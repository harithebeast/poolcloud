import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ProviderAuthError,
  RemoteNotFoundError,
  SizeMismatchError,
  StorageError,
} from './errors.js';
import type { ByteRange, Quota, RemoteBlob, StorageProvider } from './provider.js';

export interface FakeProviderOptions {
  limit: number;
  /** Bytes already used by other services (Gmail/Photos) or earlier data. */
  initialUsage?: number;
}

/** In-memory provider. Enforces its quota like Drive does and supports failure injection. */
export class FakeProvider implements StorageProvider {
  private readonly blobs = new Map<string, Buffer>();
  private readonly allocated = new Set<string>();
  private readonly createdAt = new Map<string, number>();
  private externalUsage: number;
  private down = false;
  private failUploadAfterBytes: number | null = null;
  readonly limit: number;

  constructor(options: FakeProviderOptions) {
    this.limit = options.limit;
    this.externalUsage = options.initialUsage ?? 0;
  }

  /** Simulate a revoked token: every call fails with ProviderAuthError. */
  setDown(down: boolean): void {
    this.down = down;
  }

  /** Make the next upload fail once this many bytes were received (mid-stream failure). */
  failNextUploadAfter(bytes: number): void {
    this.failUploadAfterBytes = bytes;
  }

  get blobCount(): number {
    return this.blobs.size;
  }

  hasBlob(remoteId: string): boolean {
    return this.blobs.has(remoteId);
  }

  /** Test hook: flip a byte inside a stored blob. */
  corrupt(remoteId: string, offset = 0): void {
    const blob = this.blobs.get(remoteId);
    if (!blob) throw new RemoteNotFoundError(remoteId);
    blob[offset] = (blob[offset] ?? 0) ^ 0xff;
  }

  private get usage(): number {
    let total = this.externalUsage;
    for (const b of this.blobs.values()) total += b.length;
    return total;
  }

  private assertUp(): void {
    if (this.down) throw new ProviderAuthError('fake: token revoked');
  }

  allocateId(): Promise<string> {
    this.assertUp();
    const id = randomUUID();
    this.allocated.add(id);
    return Promise.resolve(id);
  }

  async upload(remoteId: string, data: Readable, size: number): Promise<{ size: number }> {
    this.assertUp();
    const parts: Buffer[] = [];
    let received = 0;
    const failAt = this.failUploadAfterBytes;
    for await (const piece of data) {
      const buf = Buffer.isBuffer(piece) ? piece : Buffer.from(piece as string);
      parts.push(buf);
      received += buf.length;
      if (failAt !== null && received >= failAt) {
        this.failUploadAfterBytes = null;
        throw new StorageError('fake: connection reset mid-upload');
      }
    }
    if (received !== size) throw new SizeMismatchError(`expected ${size} bytes, got ${received}`);
    if (this.usage + received > this.limit) throw new StorageError('fake: storage quota exceeded');
    this.blobs.set(remoteId, Buffer.concat(parts));
    this.createdAt.set(remoteId, Date.now());
    return { size: received };
  }

  download(remoteId: string, range?: ByteRange): Promise<Readable> {
    this.assertUp();
    const blob = this.blobs.get(remoteId);
    if (!blob) return Promise.reject(new RemoteNotFoundError(remoteId));
    const slice = range ? blob.subarray(range.start, range.end + 1) : blob;
    return Promise.resolve(Readable.from([slice], { objectMode: false }));
  }

  delete(remoteId: string): Promise<void> {
    this.assertUp();
    this.blobs.delete(remoteId);
    this.createdAt.delete(remoteId);
    return Promise.resolve();
  }

  /** Test hook: pretend a blob was uploaded `ms` milliseconds ago. */
  ageBlob(remoteId: string, ms: number): void {
    this.createdAt.set(remoteId, Date.now() - ms);
  }

  /** Test hook: put a blob in the account that PoolDrive knows nothing about. */
  plantBlob(remoteId: string, data: Buffer, ageMs = 0): void {
    this.blobs.set(remoteId, data);
    this.createdAt.set(remoteId, Date.now() - ageMs);
  }

  /** Test hook: remove a blob behind PoolDrive's back. */
  loseBlob(remoteId: string): void {
    this.blobs.delete(remoteId);
    this.createdAt.delete(remoteId);
  }

  async *listBlobs(): AsyncGenerator<RemoteBlob> {
    this.assertUp();
    for (const [remoteId, data] of [...this.blobs]) {
      yield { remoteId, size: data.length, createdAt: new Date(this.createdAt.get(remoteId) ?? 0) };
    }
  }

  getQuota(): Promise<Quota> {
    this.assertUp();
    return Promise.resolve({ limit: this.limit, usage: this.usage });
  }

  healthCheck(): Promise<void> {
    this.assertUp();
    return Promise.resolve();
  }
}
