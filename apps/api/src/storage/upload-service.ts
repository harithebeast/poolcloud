import { createHash, type Hash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ByteReader } from './byte-reader.js';
import {
  chunkAad,
  encryptChunk,
  generateDataKey,
  GCM_TAG_BYTES,
  type KeyRing,
  type WrappedKey,
} from './crypto.js';
import { InsufficientCapacityError } from './errors.js';
import {
  MostFreeSpaceStrategy,
  availableBytes,
  type HeadroomPolicy,
  type PlacementStrategy,
} from './placement.js';
import type { ProviderResolver } from './provider.js';
import type { AccountStore, CleanupOutbox, Reservation } from './stores.js';

export interface StorageSettings {
  /** Size of each piece when a file is split (also the max GCM record size). */
  chunkSize: number;
  headroom: HeadroomPolicy;
  reservationTtlMs: number;
  /** How long a crashed upload's remote blobs survive before the cleanup job removes them. */
  cleanupGraceMs: number;
}

export interface ChunkRecord {
  index: number;
  accountId: string;
  remoteId: string;
  /** Size of the stored bytes (ciphertext + tag when encrypted). */
  size: number;
  /** SHA-256 (hex) of the stored bytes. */
  sha256: string;
  /** Base64 GCM nonce; null when unencrypted. */
  nonce: string | null;
}

export interface StoredFile {
  fileId: string;
  size: number;
  chunks: ChunkRecord[];
  encryption: WrappedKey | null;
}

export interface StoreRequest {
  ownerId: string;
  fileId: string;
  source: AsyncIterable<Buffer | string>;
  /** Declared plaintext size; the stream must match it exactly. */
  size: number;
  encrypt: boolean;
}

export interface UploadServiceDeps {
  accounts: AccountStore;
  outbox: CleanupOutbox;
  providers: ProviderResolver;
  keyRing: KeyRing;
  settings: StorageSettings;
  strategy?: PlacementStrategy;
}

const RESERVE_ATTEMPTS = 3;

interface Placed {
  chunk: ChunkRecord;
  outboxId: string;
}

export class UploadService {
  private readonly strategy: PlacementStrategy;

  constructor(private readonly deps: UploadServiceDeps) {
    this.strategy = deps.strategy ?? new MostFreeSpaceStrategy();
  }

  /**
   * Stream `source` into the pool. `commit` persists metadata atomically; if it (or anything before
   * it) fails, every remote blob written by this call is deleted, or queued for the cleanup job.
   * Nothing becomes visible to users unless `commit` succeeds.
   */
  async store(req: StoreRequest, commit: (file: StoredFile) => Promise<void>): Promise<StoredFile> {
    const placed: Placed[] = [];
    try {
      const stored = await this.write(req, placed);
      await commit(stored);
      await this.deps.outbox.remove(placed.map((p) => p.outboxId));
      return stored;
    } catch (err) {
      await this.rollback(placed);
      throw err;
    }
  }

  private async write(req: StoreRequest, placed: Placed[]): Promise<StoredFile> {
    const { settings } = this.deps;
    const reader = new ByteReader(req.source);
    const dek = req.encrypt ? generateDataKey() : null;
    const tag = dek ? GCM_TAG_BYTES : 0;

    // Fail before writing anything when the pool plainly cannot hold the file.
    const overhead = tag * Math.ceil(req.size / settings.chunkSize);
    const pooled = await this.pooledAvailable(req.ownerId);
    if (pooled < req.size + overhead) throw new InsufficientCapacityError(req.size, pooled);

    // Unencrypted files stay whole when a single account can hold them; otherwise they are split.
    let whole = req.encrypt ? null : await this.reserve(req.ownerId, req.size, req.size);
    let remaining = req.size;
    let index = 0;
    do {
      const want = Math.min(settings.chunkSize, remaining) + tag;
      // Near an account's limit the chunk shrinks to what fits instead of stranding the free space.
      const reservation =
        whole ?? (await this.reserve(req.ownerId, want, remaining === 0 ? tag : tag + 1));
      whole = null;
      if (!reservation)
        throw new InsufficientCapacityError(req.size, await this.pooledAvailable(req.ownerId));
      const plainLength = reservation.bytes - tag;
      remaining -= plainLength;
      await this.putChunk(
        req,
        reader,
        dek,
        index++,
        plainLength,
        remaining === 0,
        reservation,
        placed,
      );
    } while (remaining > 0);
    await reader.assertEnd();

    return {
      fileId: req.fileId,
      size: req.size,
      chunks: placed.map((p) => p.chunk),
      encryption: dek ? this.deps.keyRing.wrap(dek, req.fileId) : null,
    };
  }

  private async putChunk(
    req: StoreRequest,
    reader: ByteReader,
    dek: Buffer | null,
    index: number,
    plainLength: number,
    isLast: boolean,
    reservation: Reservation,
    placed: Placed[],
  ): Promise<void> {
    const { accountId } = reservation;
    const provider = this.deps.providers(accountId);
    const hash = createHash('sha256');
    let body: Readable;
    let nonce: string | null = null;
    let storedLength = plainLength;

    try {
      const remoteId = await provider.allocateId();
      // Recorded before any bytes leave, so a crash cannot leak an untracked blob.
      const outboxId = await this.deps.outbox.add(
        { ownerId: req.ownerId, accountId, remoteId, reason: 'upload-in-progress' },
        this.deps.settings.cleanupGraceMs,
      );
      // Registered before upload so rollback sees it even if the upload fails midway.
      const chunk: ChunkRecord = { index, accountId, remoteId, size: 0, sha256: '', nonce: null };
      placed.push({ outboxId, chunk });

      if (dek) {
        const plaintext = await reader.readExact(plainLength);
        const sealed = encryptChunk(dek, plaintext, chunkAad(req.fileId, index, isLast));
        hash.update(sealed.data);
        nonce = sealed.nonce.toString('base64');
        storedLength = sealed.data.length;
        body = Readable.from([sealed.data], { objectMode: false });
      } else {
        body = Readable.from(hashing(reader.take(plainLength), hash), { objectMode: false });
      }
      await provider.upload(remoteId, body, storedLength);
      await this.deps.accounts.adjustUsage(accountId, storedLength);
      Object.assign(chunk, { size: storedLength, sha256: hash.digest('hex'), nonce });
    } finally {
      await this.deps.accounts.release(reservation.id);
    }
  }

  /**
   * Pick an account via the strategy and reserve atomically, retrying if another upload wins the
   * race. Reserves `want` bytes, or the most the best account has when that is less (but >= `min`).
   */
  private async reserve(ownerId: string, want: number, min: number): Promise<Reservation | null> {
    const { accounts, settings } = this.deps;
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
      const candidates = (await accounts.list(ownerId))
        .filter((a) => a.status === 'HEALTHY')
        .map((a) => ({ accountId: a.id, available: availableBytes(a, settings.headroom) }));
      let chosen = this.strategy.choose(candidates, want);
      let amount = want;
      if (!chosen) {
        chosen = this.strategy.choose(candidates, min);
        amount = Math.min(want, candidates.find((c) => c.accountId === chosen)?.available ?? 0);
      }
      if (!chosen) return null;
      const reservation = await accounts.tryReserve(
        ownerId,
        chosen,
        amount,
        settings.reservationTtlMs,
        settings.headroom,
      );
      if (reservation) return reservation;
    }
    return null;
  }

  private async pooledAvailable(ownerId: string): Promise<number> {
    const { accounts, settings } = this.deps;
    return (await accounts.list(ownerId))
      .filter((a) => a.status === 'HEALTHY')
      .reduce((sum, a) => sum + availableBytes(a, settings.headroom), 0);
  }

  /** Best-effort immediate deletion; anything that fails stays in the outbox for the cleanup job. */
  private async rollback(placed: Placed[]): Promise<void> {
    await this.deps.outbox.expedite(placed.map((p) => p.outboxId));
    for (const { chunk, outboxId } of placed) {
      try {
        await this.deps.providers(chunk.accountId).delete(chunk.remoteId);
        await this.deps.outbox.remove([outboxId]);
        if (chunk.size > 0) await this.deps.accounts.adjustUsage(chunk.accountId, -chunk.size);
      } catch {
        // Left in the outbox; CleanupService retries with backoff.
      }
    }
  }
}

async function* hashing(parts: AsyncIterable<Buffer>, hash: Hash): AsyncGenerator<Buffer> {
  for await (const part of parts) {
    hash.update(part);
    yield part;
  }
}
