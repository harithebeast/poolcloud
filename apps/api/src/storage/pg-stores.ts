import type { AccountStatus } from '@pooldrive/shared';
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';
import { quotaReservations, remoteCleanup, storageAccounts } from '../db/schema.js';
import { availableBytes, type HeadroomPolicy } from './placement.js';
import type { Quota } from './provider.js';
import type {
  AccountRecord,
  AccountStore,
  CleanupEntry,
  CleanupOutbox,
  Reservation,
} from './stores.js';

export class PgAccountStore implements AccountStore {
  constructor(private readonly db: Db) {}

  async list(ownerId: string): Promise<AccountRecord[]> {
    const rows = await this.db
      .select({
        id: storageAccounts.id,
        ownerId: storageAccounts.ownerId,
        status: storageAccounts.status,
        limit: storageAccounts.quotaLimit,
        usage: storageAccounts.quotaUsage,
        // Explicit aliases: Drizzle drops table qualifiers inside a correlated subquery.
        reserved: sql<number>`coalesce((
          select sum(qr.bytes) from quota_reservations qr
          where qr.account_id = "storage_accounts"."id" and qr.expires_at > now()
        ), 0)::float8`,
      })
      .from(storageAccounts)
      .where(eq(storageAccounts.ownerId, ownerId));
    return rows.map((r) => ({ ...r, reserved: Number(r.reserved) }));
  }

  async tryReserve(
    ownerId: string,
    accountId: string,
    bytes: number,
    ttlMs: number,
    policy: HeadroomPolicy,
  ): Promise<Reservation | null> {
    return this.db.transaction(async (tx) => {
      // The row lock serialises concurrent reservations on the same account.
      const [account] = await tx
        .select()
        .from(storageAccounts)
        .where(and(eq(storageAccounts.id, accountId), eq(storageAccounts.ownerId, ownerId)))
        .for('update');
      if (!account || account.status !== 'HEALTHY') return null;
      const [sum] = await tx
        .select({ total: sql<number>`coalesce(sum(${quotaReservations.bytes}), 0)::float8` })
        .from(quotaReservations)
        .where(
          and(
            eq(quotaReservations.accountId, accountId),
            gt(quotaReservations.expiresAt, sql`now()`),
          ),
        );
      const view = {
        limit: account.quotaLimit,
        usage: account.quotaUsage,
        reserved: Number(sum?.total ?? 0),
      };
      if (availableBytes(view, policy) < bytes) return null;
      const [row] = await tx
        .insert(quotaReservations)
        .values({
          ownerId,
          accountId,
          bytes,
          expiresAt: sql`now() + ${`${ttlMs} milliseconds`}::interval`,
        })
        .returning({ id: quotaReservations.id });
      return row ? { id: row.id, accountId, bytes } : null;
    });
  }

  async release(reservationId: string): Promise<void> {
    await this.db.delete(quotaReservations).where(eq(quotaReservations.id, reservationId));
  }

  async adjustUsage(accountId: string, delta: number): Promise<void> {
    await this.db
      .update(storageAccounts)
      .set({ quotaUsage: sql`greatest(0, ${storageAccounts.quotaUsage} + ${delta})` })
      .where(eq(storageAccounts.id, accountId));
  }

  async setQuota(accountId: string, quota: Quota): Promise<void> {
    await this.db
      .update(storageAccounts)
      .set({ quotaLimit: quota.limit, quotaUsage: quota.usage, quotaSyncedAt: new Date() })
      .where(eq(storageAccounts.id, accountId));
  }

  async setStatus(accountId: string, status: AccountStatus, error?: string): Promise<void> {
    await this.db
      .update(storageAccounts)
      .set({ status, lastError: error ?? null })
      .where(eq(storageAccounts.id, accountId));
  }

  async recordFailure(accountId: string, message: string): Promise<number> {
    const [row] = await this.db
      .update(storageAccounts)
      .set({ consecutiveErrors: sql`${storageAccounts.consecutiveErrors} + 1`, lastError: message })
      .where(eq(storageAccounts.id, accountId))
      .returning({ n: storageAccounts.consecutiveErrors });
    return row?.n ?? 0;
  }

  async resetFailures(accountId: string): Promise<void> {
    await this.db
      .update(storageAccounts)
      .set({ consecutiveErrors: 0 })
      .where(eq(storageAccounts.id, accountId));
  }
}

export class PgCleanupOutbox implements CleanupOutbox {
  constructor(private readonly db: Db) {}

  async add(entry: Omit<CleanupEntry, 'id' | 'attempts'>, graceMs: number): Promise<string> {
    const [row] = await this.db
      .insert(remoteCleanup)
      .values({ ...entry, nextAttemptAt: sql`now() + ${`${graceMs} milliseconds`}::interval` })
      .returning({ id: remoteCleanup.id });
    if (!row) throw new Error('failed to insert cleanup entry');
    return row.id;
  }

  async expedite(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(remoteCleanup)
      .set({ nextAttemptAt: sql`now()` })
      .where(inArray(remoteCleanup.id, ids));
  }

  async remove(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.db.delete(remoteCleanup).where(inArray(remoteCleanup.id, ids));
  }

  async claimDue(limit: number): Promise<CleanupEntry[]> {
    return this.db
      .select({
        id: remoteCleanup.id,
        ownerId: remoteCleanup.ownerId,
        accountId: remoteCleanup.accountId,
        remoteId: remoteCleanup.remoteId,
        reason: remoteCleanup.reason,
        attempts: remoteCleanup.attempts,
      })
      .from(remoteCleanup)
      .where(lte(remoteCleanup.nextAttemptAt, sql`now()`))
      .orderBy(remoteCleanup.nextAttemptAt)
      .limit(limit);
  }

  async recordFailure(id: string, retryInMs: number): Promise<void> {
    await this.db
      .update(remoteCleanup)
      .set({
        attempts: sql`${remoteCleanup.attempts} + 1`,
        nextAttemptAt: sql`now() + ${`${retryInMs} milliseconds`}::interval`,
      })
      .where(eq(remoteCleanup.id, id));
  }
}
