import type { AccountStatus } from '@pooldrive/shared';
import type { HeadroomPolicy } from './placement.js';
import type { Quota } from './provider.js';

export interface AccountRecord {
  id: string;
  ownerId: string;
  status: AccountStatus;
  limit: number;
  usage: number;
  /** Active, unexpired reservations. */
  reserved: number;
}

export interface Reservation {
  id: string;
  accountId: string;
  bytes: number;
}

/**
 * Account quota state plus in-flight reservations. `tryReserve` MUST be atomic per account:
 * two concurrent callers can never reserve more than the account's available bytes.
 * Every method is scoped by owner (directly or through the account id).
 */
export interface AccountStore {
  list(ownerId: string): Promise<AccountRecord[]>;
  tryReserve(
    ownerId: string,
    accountId: string,
    bytes: number,
    ttlMs: number,
    policy: HeadroomPolicy,
  ): Promise<Reservation | null>;
  release(reservationId: string): Promise<void>;
  /** Optimistic local bookkeeping between quota syncs. */
  adjustUsage(accountId: string, delta: number): Promise<void>;
  setQuota(accountId: string, quota: Quota): Promise<void>;
  setStatus(accountId: string, status: AccountStatus, error?: string): Promise<void>;
  /** Returns the new consecutive-failure count. */
  recordFailure(accountId: string, message: string): Promise<number>;
  resetFailures(accountId: string): Promise<void>;
  /** Accounts in a given state, across all owners (for background jobs). */
  listByStatus(status: AccountStatus): Promise<Array<{ id: string; ownerId: string }>>;
}

export interface CleanupEntry {
  id: string;
  ownerId: string;
  accountId: string;
  remoteId: string;
  reason: string;
  attempts: number;
}

/** Remote blobs that must not outlive their upload attempt. Written BEFORE bytes are sent. */
export interface CleanupOutbox {
  /** `graceMs` delays first processing so an in-flight upload is not deleted from under itself. */
  add(entry: Omit<CleanupEntry, 'id' | 'attempts'>, graceMs: number): Promise<string>;
  /** Mark due immediately (upload aborted). */
  expedite(ids: string[]): Promise<void>;
  /** Forget entries (upload committed, or remote deleted). */
  remove(ids: string[]): Promise<void>;
  claimDue(limit: number): Promise<CleanupEntry[]>;
  recordFailure(id: string, retryInMs: number): Promise<void>;
}

/** One stored piece of a file, as recorded in the chunk map. */
export interface ChunkRef {
  ownerId: string;
  fileId: string;
  index: number;
  accountId: string;
  remoteId: string;
  size: number;
  sha256: string;
  nonce: string | null;
}

/** The chunk map, from the point of view of moving pieces between accounts. */
export interface ChunkStore {
  /** Pieces currently stored on `accountId` (including those of trashed files). */
  listOn(accountId: string, limit: number): Promise<ChunkRef[]>;
  countOn(accountId: string): Promise<{ parts: number; bytes: number }>;
  /**
   * Point a piece at its new copy. Compare-and-swap on the old location: returns false if the piece
   * was purged or already moved meanwhile, so a stale migration can never overwrite newer state.
   */
  repoint(chunk: ChunkRef, to: { accountId: string; remoteId: string }): Promise<boolean>;
}
