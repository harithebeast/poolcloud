import { createHash, type Hash } from 'node:crypto';
import { Readable } from 'node:stream';
import { IntegrityError, StorageError } from './errors.js';
import {
  MostFreeSpaceStrategy,
  availableBytes,
  type HeadroomPolicy,
  type PlacementStrategy,
} from './placement.js';
import type { ProviderResolver } from './provider.js';
import type { AccountStore, ChunkRef, ChunkStore, CleanupOutbox } from './stores.js';

export interface DrainSettings {
  headroom: HeadroomPolicy;
  reservationTtlMs: number;
  /** Old copies are deleted only after this delay, so a download that already started can finish. */
  cleanupGraceMs: number;
}

export interface DrainResult {
  accountId: string;
  ownerId: string;
  /** Pieces moved in this pass. */
  moved: number;
  /** Pieces still on the account. */
  remaining: number;
  /** True once the account is empty and has been disconnected. */
  finished: boolean;
  /** Why progress stopped, in words an administrator can act on. */
  stuck?: string;
}

const BATCH = 25;

/**
 * Empties an account that is being removed: every stored piece is copied to another account,
 * verified against its recorded SHA-256, and only then repointed in the chunk map. The old copy is
 * queued for deletion afterwards. The bytes are copied as stored, so encrypted pieces stay encrypted
 * and never need the key. At no point is the only copy of a piece deleted or unreferenced.
 */
export class DrainService {
  private readonly strategy: PlacementStrategy;

  constructor(
    private readonly deps: {
      accounts: AccountStore;
      chunks: ChunkStore;
      outbox: CleanupOutbox;
      providers: ProviderResolver;
      settings: DrainSettings;
      strategy?: PlacementStrategy;
      /** Called when an account has been fully emptied and disconnected. */
      onFinished?: (accountId: string, ownerId: string) => Promise<void>;
    },
  ) {
    this.strategy = deps.strategy ?? new MostFreeSpaceStrategy();
  }

  /** One pass over every account that is being removed (run by the worker). */
  async run(): Promise<DrainResult[]> {
    const results: DrainResult[] = [];
    for (const { id, ownerId } of await this.deps.accounts.listByStatus('DRAINING')) {
      results.push(await this.drain(ownerId, id));
    }
    return results;
  }

  /** Move up to `maxPieces` pieces off the account; disconnect it if that empties it. */
  async drain(ownerId: string, accountId: string, maxPieces = BATCH): Promise<DrainResult> {
    const { chunks, accounts } = this.deps;
    let moved = 0;
    let stuck: string | undefined;

    for (const chunk of maxPieces > 0 ? await chunks.listOn(accountId, maxPieces) : []) {
      try {
        const outcome = await this.moveOne(chunk);
        if (outcome === 'no-room') {
          stuck =
            'Your other accounts do not have enough free space to take this account’s files. Free up space or link another account, then removal continues automatically.';
          break;
        }
        if (outcome === 'moved') moved += 1;
      } catch (err) {
        stuck = describe(err);
        break;
      }
    }

    const { parts } = await chunks.countOn(accountId);
    const finished = parts === 0 && !stuck;
    if (finished) {
      await accounts.setStatus(accountId, 'DISCONNECTED', 'removed');
      await this.deps.onFinished?.(accountId, ownerId);
    }
    return { accountId, ownerId, moved, remaining: parts, finished, stuck };
  }

  private async moveOne(c: ChunkRef): Promise<'moved' | 'gone' | 'no-room'> {
    const { accounts, outbox, providers, settings, chunks } = this.deps;

    const target = await this.reserveElsewhere(c);
    if (!target) return 'no-room';

    let newOutbox: string | undefined;
    let newRemote: string | undefined;
    // Once the pointer has moved, the new copy is the live one and must never be cleaned up.
    let live = false;
    try {
      const to = providers(target.accountId);
      newRemote = await to.allocateId();
      // Recorded before any byte is written, exactly like an upload, so a crash leaves no stray blob.
      newOutbox = await outbox.add(
        {
          ownerId: c.ownerId,
          accountId: target.accountId,
          remoteId: newRemote,
          reason: 'migration-in-progress',
        },
        settings.cleanupGraceMs,
      );

      const hash = createHash('sha256');
      const source = await providers(c.accountId).download(c.remoteId);
      await to.upload(
        newRemote,
        Readable.from(hashing(source, hash), { objectMode: false }),
        c.size,
      );
      if (hash.digest('hex') !== c.sha256) {
        throw new IntegrityError(
          `piece ${c.index} of file ${c.fileId} failed its integrity check while being moved; it was not copied`,
        );
      }
      await accounts.adjustUsage(target.accountId, c.size);

      // Queue the old copy first (delayed), then switch the pointer.
      const oldOutbox = await outbox.add(
        {
          ownerId: c.ownerId,
          accountId: c.accountId,
          remoteId: c.remoteId,
          reason: 'migrated-away',
        },
        settings.cleanupGraceMs,
      );
      const switched = await chunks.repoint(c, {
        accountId: target.accountId,
        remoteId: newRemote,
      });
      live = switched;
      if (!switched) {
        // The file was purged or changed meanwhile: keep nothing from this attempt.
        await outbox.remove([oldOutbox]);
        await outbox.expedite([newOutbox]);
        await accounts.adjustUsage(target.accountId, -c.size);
        await providers(target.accountId)
          .delete(newRemote)
          .then(
            () => outbox.remove([newOutbox!]),
            () => undefined,
          );
        return 'gone';
      }
      // Best-effort bookkeeping: failing here must not undo a completed move.
      await outbox.remove([newOutbox]).catch(() => undefined); // the new copy is now referenced
      await accounts.adjustUsage(c.accountId, -c.size).catch(() => undefined);
      return 'moved';
    } catch (err) {
      if (!live) {
        if (newOutbox) await outbox.expedite([newOutbox]).catch(() => undefined); // cleanup will remove it
        if (newRemote && newOutbox) {
          await providers(target.accountId)
            .delete(newRemote)
            .then(() => outbox.remove([newOutbox!]))
            .catch(() => undefined);
        }
      }
      throw err;
    } finally {
      await accounts.release(target.id);
    }
  }

  private async reserveElsewhere(c: ChunkRef) {
    const { accounts, settings } = this.deps;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidates = (await accounts.list(c.ownerId))
        .filter((a) => a.status === 'HEALTHY' && a.id !== c.accountId)
        .map((a) => ({ accountId: a.id, available: availableBytes(a, settings.headroom) }));
      const chosen = this.strategy.choose(candidates, c.size);
      if (!chosen) return null;
      const reservation = await accounts.tryReserve(
        c.ownerId,
        chosen,
        c.size,
        settings.reservationTtlMs,
        settings.headroom,
      );
      if (reservation) return reservation;
    }
    return null;
  }
}

async function* hashing(
  source: AsyncIterable<Buffer | string>,
  hash: Hash,
): AsyncGenerator<Buffer> {
  for await (const piece of source) {
    const buf = typeof piece === 'string' ? Buffer.from(piece) : piece;
    hash.update(buf);
    yield buf;
  }
}

/** Domain errors carry safe messages; anything else becomes a generic hint (details are logged). */
function describe(err: unknown): string {
  if (err instanceof StorageError) return err.message;
  return 'Moving files failed unexpectedly. It will be retried; see the API log if it keeps happening.';
}
