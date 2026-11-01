import type { AccountStatus } from '@pooldrive/shared';
import { randomUUID } from 'node:crypto';
import { availableBytes, type HeadroomPolicy } from './placement.js';
import type { Quota } from './provider.js';
import type {
  AccountRecord,
  AccountStore,
  CleanupEntry,
  CleanupOutbox,
  Reservation,
} from './stores.js';

interface MemAccount {
  id: string;
  ownerId: string;
  status: AccountStatus;
  limit: number;
  usage: number;
  failures: number;
  lastError?: string;
}

interface MemReservation extends Reservation {
  expiresAt: number;
}

/** Reference implementation of the store contracts; synchronous sections make reservations atomic. */
export class MemoryAccountStore implements AccountStore {
  private readonly accounts = new Map<string, MemAccount>();
  private readonly reservations = new Map<string, MemReservation>();

  constructor(private readonly now: () => number = Date.now) {}

  addAccount(a: {
    id: string;
    ownerId: string;
    limit: number;
    usage: number;
    status?: AccountStatus;
  }): void {
    this.accounts.set(a.id, { status: 'HEALTHY', failures: 0, ...a });
  }

  getStatus(accountId: string): AccountStatus | undefined {
    return this.accounts.get(accountId)?.status;
  }

  private reserved(accountId: string): number {
    let total = 0;
    for (const r of this.reservations.values()) {
      if (r.accountId === accountId && r.expiresAt > this.now()) total += r.bytes;
    }
    return total;
  }

  list(ownerId: string): Promise<AccountRecord[]> {
    return Promise.resolve(
      [...this.accounts.values()]
        .filter((a) => a.ownerId === ownerId)
        .map((a) => ({ ...a, reserved: this.reserved(a.id) })),
    );
  }

  tryReserve(
    ownerId: string,
    accountId: string,
    bytes: number,
    ttlMs: number,
    policy: HeadroomPolicy,
  ): Promise<Reservation | null> {
    const account = this.accounts.get(accountId);
    if (!account || account.ownerId !== ownerId || account.status !== 'HEALTHY')
      return Promise.resolve(null);
    const view = { limit: account.limit, usage: account.usage, reserved: this.reserved(accountId) };
    if (availableBytes(view, policy) < bytes) return Promise.resolve(null);
    const reservation = { id: randomUUID(), accountId, bytes, expiresAt: this.now() + ttlMs };
    this.reservations.set(reservation.id, reservation);
    return Promise.resolve({ id: reservation.id, accountId, bytes });
  }

  release(reservationId: string): Promise<void> {
    this.reservations.delete(reservationId);
    return Promise.resolve();
  }

  adjustUsage(accountId: string, delta: number): Promise<void> {
    const a = this.accounts.get(accountId);
    if (a) a.usage = Math.max(0, a.usage + delta);
    return Promise.resolve();
  }

  setQuota(accountId: string, quota: Quota): Promise<void> {
    const a = this.accounts.get(accountId);
    if (a) Object.assign(a, { limit: quota.limit, usage: quota.usage });
    return Promise.resolve();
  }

  setStatus(accountId: string, status: AccountStatus, error?: string): Promise<void> {
    const a = this.accounts.get(accountId);
    if (a) Object.assign(a, { status, lastError: error });
    return Promise.resolve();
  }

  recordFailure(accountId: string, message: string): Promise<number> {
    const a = this.accounts.get(accountId);
    if (!a) return Promise.resolve(0);
    a.failures += 1;
    a.lastError = message;
    return Promise.resolve(a.failures);
  }

  resetFailures(accountId: string): Promise<void> {
    const a = this.accounts.get(accountId);
    if (a) a.failures = 0;
    return Promise.resolve();
  }
}

interface MemEntry extends CleanupEntry {
  dueAt: number;
}

export class MemoryCleanupOutbox implements CleanupOutbox {
  private readonly entries = new Map<string, MemEntry>();

  constructor(private readonly now: () => number = Date.now) {}

  get size(): number {
    return this.entries.size;
  }

  remoteIds(): string[] {
    return [...this.entries.values()].map((e) => e.remoteId);
  }

  add(entry: Omit<CleanupEntry, 'id' | 'attempts'>, graceMs: number): Promise<string> {
    const id = randomUUID();
    this.entries.set(id, { ...entry, id, attempts: 0, dueAt: this.now() + graceMs });
    return Promise.resolve(id);
  }

  expedite(ids: string[]): Promise<void> {
    for (const id of ids) {
      const e = this.entries.get(id);
      if (e) e.dueAt = this.now();
    }
    return Promise.resolve();
  }

  remove(ids: string[]): Promise<void> {
    for (const id of ids) this.entries.delete(id);
    return Promise.resolve();
  }

  claimDue(limit: number): Promise<CleanupEntry[]> {
    return Promise.resolve(
      [...this.entries.values()].filter((e) => e.dueAt <= this.now()).slice(0, limit),
    );
  }

  recordFailure(id: string, retryInMs: number): Promise<void> {
    const e = this.entries.get(id);
    if (e) {
      e.attempts += 1;
      e.dueAt = this.now() + retryInMs;
    }
    return Promise.resolve();
  }
}
