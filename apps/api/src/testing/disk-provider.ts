import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { RemoteNotFoundError, SizeMismatchError, StorageError } from '../storage/errors.js';
import type { ByteRange, Quota, RemoteBlob, StorageProvider } from '../storage/provider.js';

/**
 * File-backed provider for tests that move more data than fits in memory (the 5 GB streaming
 * check). Same contract as FakeProvider, but blobs live on disk and are streamed in and out.
 */
export class DiskProvider implements StorageProvider {
  private used = 0;

  constructor(
    private readonly dir: string,
    readonly limit: number,
  ) {}

  private path(id: string) {
    return join(this.dir, id);
  }

  async allocateId(): Promise<string> {
    await mkdir(this.dir, { recursive: true });
    return randomUUID();
  }

  async upload(remoteId: string, data: Readable, size: number): Promise<{ size: number }> {
    if (this.used + size > this.limit) throw new StorageError('disk: storage quota exceeded');
    const target = this.path(remoteId);
    await pipeline(data, createWriteStream(target));
    const written = (await stat(target)).size;
    if (written !== size) {
      await unlink(target).catch(() => undefined);
      throw new SizeMismatchError(`expected ${size} bytes, got ${written}`);
    }
    this.used += written;
    return { size: written };
  }

  async download(remoteId: string, range?: ByteRange): Promise<Readable> {
    try {
      await stat(this.path(remoteId));
    } catch {
      throw new RemoteNotFoundError(remoteId);
    }
    return createReadStream(
      this.path(remoteId),
      range ? { start: range.start, end: range.end } : {},
    );
  }

  async delete(remoteId: string): Promise<void> {
    try {
      const { size } = await stat(this.path(remoteId));
      await unlink(this.path(remoteId));
      this.used -= size;
    } catch {
      /* already gone */
    }
  }

  getQuota(): Promise<Quota> {
    return Promise.resolve({ limit: this.limit, usage: this.used });
  }

  healthCheck(): Promise<void> {
    return Promise.resolve();
  }

  async *listBlobs(): AsyncGenerator<RemoteBlob> {
    for (const name of await readdir(this.dir).catch(() => [])) {
      const s = await stat(this.path(name));
      yield { remoteId: name, size: s.size, createdAt: s.mtime };
    }
  }

  async destroy(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }
}
