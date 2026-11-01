import { createHash, randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { CleanupService } from '../cleanup-service.js';
import { KeyRing } from '../crypto.js';
import { DownloadService } from '../download-service.js';
import { FakeProvider } from '../fake-provider.js';
import { MemoryAccountStore, MemoryCleanupOutbox } from '../memory-stores.js';
import type { HeadroomPolicy } from '../placement.js';
import { UploadService, type StoredFile } from '../upload-service.js';

export interface PoolOptions {
  /** One entry per linked account. */
  accounts: Array<{ limit: number; usage?: number }>;
  chunkSize: number;
  encryptedChunkSize?: number;
  headroom?: HeadroomPolicy;
  cleanupGraceMs?: number;
}

export const NO_HEADROOM: HeadroomPolicy = { percent: 0, minBytes: 0 };

/** A complete in-memory pool: fake providers, stores and all services wired together. */
export function makePool(options: PoolOptions) {
  let clock = 1_000_000;
  const now = () => clock;
  const ownerId = randomUUID();
  const store = new MemoryAccountStore(now);
  const outbox = new MemoryCleanupOutbox(now);
  const providers = new Map<string, FakeProvider>();
  const accountIds: string[] = [];

  for (const a of options.accounts) {
    const id = randomUUID();
    accountIds.push(id);
    store.addAccount({ id, ownerId, limit: a.limit, usage: a.usage ?? 0 });
    providers.set(id, new FakeProvider({ limit: a.limit, initialUsage: a.usage ?? 0 }));
  }
  const resolve = (id: string) => {
    const p = providers.get(id);
    if (!p) throw new Error(`unknown account ${id}`);
    return p;
  };
  const keyRing = KeyRing.parse(`k1:${Buffer.alloc(32, 7).toString('base64')}`);
  const settings = {
    chunkSize: options.chunkSize,
    encryptedChunkSize: options.encryptedChunkSize,
    headroom: options.headroom ?? NO_HEADROOM,
    reservationTtlMs: 60_000,
    cleanupGraceMs: options.cleanupGraceMs ?? 60_000,
  };
  const deps = { accounts: store, outbox, providers: resolve, keyRing, settings };

  return {
    ownerId,
    accountIds,
    store,
    outbox,
    providers,
    keyRing,
    uploads: new UploadService(deps),
    downloads: new DownloadService({ accounts: store, providers: resolve, keyRing }),
    cleanup: new CleanupService({ outbox, providers: resolve, baseRetryMs: 10 }),
    advanceClock: (ms: number) => {
      clock += ms;
    },
    totalBlobs: () => [...providers.values()].reduce((n, p) => n + p.blobCount, 0),
    /** Upload with a no-op commit; returns what would have been persisted. */
    put: (data: Buffer, encrypt = false, fileId: string = randomUUID()) =>
      new UploadService(deps).store(
        { ownerId, fileId, source: pieces(data, 1000), size: data.length, encrypt },
        () => Promise.resolve(),
      ),
  };
}

/** Deterministic pseudo-random bytes so corruption and reordering are detectable. */
export function patterned(size: number, seed = 1): Buffer {
  const out = Buffer.alloc(size);
  let hash = createHash('sha256').update(String(seed)).digest();
  for (let i = 0; i < size; i += hash.length) {
    hash.copy(out, i, 0, Math.min(hash.length, size - i));
    hash = createHash('sha256').update(hash).digest();
  }
  return out;
}

/** Async source delivering `data` in odd-sized pieces, like a network stream. */
export async function* pieces(data: Buffer, pieceSize: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < data.length; i += pieceSize) yield data.subarray(i, i + pieceSize);
}

export async function collect(stream: Readable): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const p of stream) parts.push(p as Buffer);
  return Buffer.concat(parts);
}

export async function read(
  pool: ReturnType<typeof makePool>,
  file: StoredFile,
  range?: { start: number; end: number },
): Promise<Buffer> {
  return collect(await pool.downloads.open(pool.ownerId, file, range));
}
