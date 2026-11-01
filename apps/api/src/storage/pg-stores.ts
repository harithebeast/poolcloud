import type { AccountStatus } from '@pooldrive/shared';
import { and, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';
import {
  fileChunks,
  nodes,
  quotaReservations,
  remoteCleanup,
  storageAccounts,
} from '../db/schema.js';
import type { BlobIndex } from './orphan-scanner.js';
import { availableBytes, type HeadroomPolicy } from './placement.js';
import type { Quota } from './provider.js';
import type {
  ChunkRef,
  ChunkStore,
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

  async listByStatus(status: AccountStatus): Promise<Array<{ id: string; ownerId: string }>> {
    return this.db
      .select({ id: storageAccounts.id, ownerId: storageAccounts.ownerId })
      .from(storageAccounts)
      .where(eq(storageAccounts.status, status));
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

export class PgBlobIndex implements BlobIndex {
  constructor(private readonly db: Db) {}

  async chunkRemoteIds(accountId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: fileChunks.remoteId })
      .from(fileChunks)
      .where(eq(fileChunks.accountId, accountId));
    return new Set(rows.map((r) => r.id));
  }

  async pendingCleanupIds(accountId: string): Promise<Set<string>> {
    const rows = await this.db
      .select({ id: remoteCleanup.remoteId })
      .from(remoteCleanup)
      .where(eq(remoteCleanup.accountId, accountId));
    return new Set(rows.map((r) => r.id));
  }
}

export class PgChunkStore implements ChunkStore {
  constructor(private readonly db: Db) {}

  async listOn(accountId: string, limit: number): Promise<ChunkRef[]> {
    const rows = await this.db
      .select({
        ownerId: nodes.ownerId,
        fileId: fileChunks.fileId,
        index: fileChunks.index,
        accountId: fileChunks.accountId,
        remoteId: fileChunks.remoteId,
        size: fileChunks.size,
        sha256: fileChunks.sha256,
        nonce: fileChunks.nonce,
      })
      .from(fileChunks)
      .innerJoin(nodes, eq(nodes.id, fileChunks.fileId))
      .where(eq(fileChunks.accountId, accountId))
      .limit(limit);
    return rows;
  }

  async countOn(accountId: string): Promise<{ parts: number; bytes: number }> {
    const [r] = await this.db
      .select({
        parts: sql<number>`count(*)::int`,
        bytes: sql<number>`coalesce(sum(${fileChunks.size}), 0)::float8`,
      })
      .from(fileChunks)
      .where(eq(fileChunks.accountId, accountId));
    return { parts: Number(r?.parts ?? 0), bytes: Number(r?.bytes ?? 0) };
  }

  async repoint(chunk: ChunkRef, to: { accountId: string; remoteId: string }): Promise<boolean> {
    const rows = await this.db
      .update(fileChunks)
      .set({ accountId: to.accountId, remoteId: to.remoteId })
      .where(
        and(
          eq(fileChunks.fileId, chunk.fileId),
          eq(fileChunks.index, chunk.index),
          eq(fileChunks.accountId, chunk.accountId),
          eq(fileChunks.remoteId, chunk.remoteId),
        ),
      )
      .returning({ index: fileChunks.index });
    return rows.length > 0;
  }
}
