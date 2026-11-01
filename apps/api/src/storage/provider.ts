import type { Readable } from 'node:stream';

export interface Quota {
  /** Total bytes the account may hold (shared with Gmail/Photos). */
  limit: number;
  /** Bytes used across all Google services. */
  usage: number;
}

export interface ByteRange {
  /** Inclusive offsets. */
  start: number;
  end: number;
}

/**
 * One backing store holding opaque blobs. Everything above this interface is provider-agnostic.
 * Implementations: GoogleDriveProvider (production), FakeProvider (tests and STORAGE_PROVIDER=fake).
 */
export interface StorageProvider {
  /**
   * Reserve an id for a future blob. Lets callers record the blob in a cleanup outbox BEFORE bytes
   * are sent, so a crash cannot leak an untracked remote object.
   */
  allocateId(): Promise<string>;
  /** Stream `size` bytes into the blob `remoteId`. Rejects if the stream length differs from `size`. */
  upload(remoteId: string, data: Readable, size: number): Promise<{ size: number }>;
  download(remoteId: string, range?: ByteRange): Promise<Readable>;
  /** Idempotent: deleting a missing blob succeeds. */
  delete(remoteId: string): Promise<void>;
  getQuota(): Promise<Quota>;
  /** Resolves if the account is usable; throws ProviderAuthError / ProviderUnavailableError otherwise. */
  healthCheck(): Promise<void>;
}

export type ProviderResolver = (accountId: string) => StorageProvider;
