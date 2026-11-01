import { and, eq } from 'drizzle-orm';
import type { AlertsService } from '../alerts/alerts.service.js';
import type { Db } from '../db/db.module.js';
import { storageAccounts } from '../db/schema.js';
import { NotFoundError } from '../fs/fs.service.js';
import type { DrainService } from '../storage/drain-service.js';
import { availableBytes, type HeadroomPolicy } from '../storage/placement.js';
import type { AccountStore, ChunkStore } from '../storage/stores.js';

/** Removal was refused; the message explains what to do first. */
export class RemovalNotAllowedError extends Error {}

const mb = (n: number) => `${Math.ceil(n / 1_000_000)} MB`;

/**
 * Removes a Google account from the pool without losing files: it is first marked as "being
 * emptied" (no new uploads go there, existing files stay readable), then the worker moves every
 * piece to the other accounts, and only an empty account is disconnected.
 */
export class RemovalService {
  constructor(
    private readonly deps: {
      db: Db;
      accounts: AccountStore;
      chunks: ChunkStore;
      drain: DrainService;
      alerts: Pick<AlertsService, 'resolveKind'>;
      headroom: HeadroomPolicy;
      /**
       * Move the files right away in this process instead of leaving it to the worker. Used with
       * STORAGE_PROVIDER=fake, where the worker cannot see the API's in-memory accounts.
       */
      inlineDrain?: boolean;
    },
  ) {}

  private async account(ownerId: string, accountId: string) {
    const [a] = await this.deps.db
      .select()
      .from(storageAccounts)
      .where(and(eq(storageAccounts.id, accountId), eq(storageAccounts.ownerId, ownerId)));
    if (!a) throw new NotFoundError('Account');
    return a;
  }

  async start(ownerId: string, accountId: string): Promise<void> {
    const a = await this.account(ownerId, accountId);
    if (a.status === 'DRAINING') {
      throw new RemovalNotAllowedError('This account is already being removed.');
    }
    if (a.status === 'DISCONNECTED') {
      throw new RemovalNotAllowedError('This account has already been removed.');
    }
    if (a.status === 'DEGRADED') {
      throw new RemovalNotAllowedError(
        'This account is offline, so its files cannot be read and moved. Re-authorise it first, then remove it.',
      );
    }

    const { parts, bytes } = await this.deps.chunks.countOn(accountId);
    if (parts > 0) {
      const room = (await this.deps.accounts.list(ownerId))
        .filter((o) => o.status === 'HEALTHY' && o.id !== accountId)
        .reduce((n, o) => n + availableBytes(o, this.deps.headroom), 0);
      if (room < bytes) {
        throw new RemovalNotAllowedError(
          `Your other accounts have ${mb(room)} free but this account holds ${mb(bytes)} of files. Link another account or free up space first.`,
        );
      }
    }
    await this.deps.accounts.setStatus(accountId, 'DRAINING');
    // An empty account is disconnected immediately; otherwise the worker takes it from here.
    let result = await this.deps.drain.drain(ownerId, accountId, 0);
    while (this.deps.inlineDrain && !result.finished && !result.stuck) {
      result = await this.deps.drain.drain(ownerId, accountId);
      if (result.moved === 0) break;
    }
  }

  /** Change of mind: the account goes back into service. Pieces already moved simply stay where they are. */
  async cancel(ownerId: string, accountId: string): Promise<void> {
    const a = await this.account(ownerId, accountId);
    if (a.status !== 'DRAINING') {
      throw new RemovalNotAllowedError('This account is not being removed.');
    }
    await this.deps.accounts.setStatus(accountId, 'HEALTHY');
    await this.deps.alerts.resolveKind(ownerId, 'removal_stuck');
  }

  progress(accountId: string) {
    return this.deps.chunks.countOn(accountId);
  }
}
