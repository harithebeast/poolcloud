import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  FileUnavailableError,
  InsufficientCapacityError,
  IntegrityError,
  ProviderAuthError,
  StorageError,
} from './errors.js';
import { DownloadService } from './download-service.js';
import { QuotaSyncService } from './quota-sync.js';
import { collect, makePool, patterned, pieces, read } from './testing/harness.js';

// Sizes are scaled down: 1 "GB" = 1000 bytes. Three accounts of 15 "GB", each 14 "GB" full.
const GB = 1000;
const nearlyFull = () => ({ limit: 15 * GB, usage: 14 * GB });

describe('scenario (a): three nearly-full accounts and a file larger than any single free space', () => {
  it('stores a 3 GB file across all three accounts and reads it back byte-for-byte', async () => {
    const pool = makePool({ accounts: [nearlyFull(), nearlyFull(), nearlyFull()], chunkSize: 400 });
    const data = patterned(3 * GB);

    const stored = await pool.put(data);

    expect(new Set(stored.chunks.map((c) => c.accountId)).size).toBe(3);
    expect(stored.chunks.reduce((n, c) => n + c.size, 0)).toBe(3 * GB);
    expect(stored.chunks.map((c) => c.index)).toEqual(stored.chunks.map((_, i) => i));
    expect(await read(pool, stored)).toEqual(data);
    for (const p of pool.providers.values())
      expect((await p.getQuota()).usage).toBeLessThanOrEqual(15 * GB);
  });

  it('works the same with encryption enabled', async () => {
    const pool = makePool({ accounts: [nearlyFull(), nearlyFull(), nearlyFull()], chunkSize: 400 });
    // Ciphertext adds a 16-byte tag per chunk, so use slightly less than the free space.
    const data = patterned(2800);

    const stored = await pool.put(data, true);

    expect(stored.encryption).not.toBeNull();
    expect(stored.chunks.every((c) => c.nonce !== null)).toBe(true);
    expect(await read(pool, stored)).toEqual(data);
  });

  it('keeps small files whole on the account with the most free space', async () => {
    const pool = makePool({
      accounts: [
        { limit: 15 * GB, usage: 10 * GB },
        { limit: 15 * GB, usage: 2 * GB },
        nearlyFull(),
      ],
      chunkSize: 400,
    });
    const stored = await pool.put(patterned(500));

    expect(stored.chunks).toHaveLength(1);
    expect(stored.chunks[0]!.accountId).toBe(pool.accountIds[1]);
  });

  it('only chunks when no single account can hold the file', async () => {
    const pool = makePool({
      accounts: [{ limit: 15 * GB, usage: 5 * GB }, nearlyFull()],
      chunkSize: 400,
    });
    expect((await pool.put(patterned(9 * GB - 10))).chunks).toHaveLength(1);
  });

  it('respects the safety headroom: the same file is refused with a clear error and leaves nothing behind', async () => {
    // 5% of 15 GB = 0.75 GB headroom per account, so only 0.25 GB x 3 = 0.75 GB is placeable.
    const headroom = { percent: 5, minBytes: 100 };
    const pool = makePool({
      accounts: [nearlyFull(), nearlyFull(), nearlyFull()],
      chunkSize: 400,
      headroom,
    });

    await expect(pool.put(patterned(3 * GB))).rejects.toBeInstanceOf(InsufficientCapacityError);
    expect(pool.totalBlobs()).toBe(0);

    const ok = await pool.put(patterned(700));
    expect(await read(pool, ok)).toEqual(patterned(700));
  });

  it('refuses a file larger than the pool without writing anything', async () => {
    const pool = makePool({ accounts: [nearlyFull(), nearlyFull()], chunkSize: 400 });
    const err = await pool.put(patterned(2500)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientCapacityError);
    expect(pool.totalBlobs()).toBe(0);
    expect(pool.outbox.size).toBe(0);
  });

  it('rejects streams that do not match the declared size', async () => {
    const pool = makePool({ accounts: [nearlyFull()], chunkSize: 400 });
    const data = patterned(500);
    const run = (declared: number) =>
      pool.uploads.store(
        {
          ownerId: pool.ownerId,
          fileId: randomUUID(),
          source: pieces(data, 64),
          size: declared,
          encrypt: false,
        },
        () => Promise.resolve(),
      );
    await expect(run(600)).rejects.toBeInstanceOf(StorageError);
    await expect(run(400)).rejects.toBeInstanceOf(StorageError);
    expect(pool.totalBlobs()).toBe(0);
  });

  it('handles empty files', async () => {
    const pool = makePool({ accounts: [nearlyFull()], chunkSize: 400 });
    const stored = await pool.put(Buffer.alloc(0));
    expect(await read(pool, stored)).toEqual(Buffer.alloc(0));
  });
});

describe('scenario (b): an account goes DEGRADED mid-session', () => {
  it('excludes it from placement, keeps healthy data readable, and flags affected files unavailable', async () => {
    const pool = makePool({
      accounts: [{ limit: 10 * GB }, { limit: 10 * GB }, { limit: 10 * GB }],
      chunkSize: 400,
    });
    // Fill so files land on distinct accounts: whole files go to the emptiest account.
    const a = await pool.put(patterned(100, 1));
    const b = await pool.put(patterned(100, 2));
    const c = await pool.put(patterned(100, 3));
    const split = await pool.put(patterned(30 * GB - 3000)); // spans every account
    const holders = new Set([a, b, c].map((f) => f.chunks[0]!.accountId));
    expect(holders.size).toBe(3);

    // The token on account A is revoked.
    const victim = a.chunks[0]!.accountId;
    pool.providers.get(victim)!.setDown(true);
    const degraded: string[] = [];
    await new QuotaSyncService({
      accounts: pool.store,
      providers: (id) => pool.providers.get(id)!,
      onDegraded: (id) => void degraded.push(id),
    }).syncOwner(pool.ownerId);

    expect(degraded).toEqual([victim]);
    expect(pool.store.getStatus(victim)).toBe('DEGRADED');

    // Healthy files still download; the affected files report a clear error.
    expect(await read(pool, b)).toEqual(patterned(100, 2));
    await expect(read(pool, a)).rejects.toBeInstanceOf(FileUnavailableError);
    await expect(read(pool, split)).rejects.toBeInstanceOf(FileUnavailableError);

    // New uploads avoid the degraded account.
    const fresh = await pool.put(patterned(100, 9));
    expect(fresh.chunks[0]!.accountId).not.toBe(victim);
  });

  it('degrades only after repeated transient failures', async () => {
    const pool = makePool({ accounts: [{ limit: 1000 }], chunkSize: 400 });
    const [id] = pool.accountIds as [string];
    const flaky = {
      ...pool.providers.get(id)!,
      getQuota: () => Promise.reject(new Error('timeout')),
    };
    const sync = new QuotaSyncService({ accounts: pool.store, providers: () => flaky as never });
    await sync.syncOwner(pool.ownerId);
    await sync.syncOwner(pool.ownerId);
    expect(pool.store.getStatus(id)).toBe('HEALTHY');
    await sync.syncOwner(pool.ownerId);
    expect(pool.store.getStatus(id)).toBe('DEGRADED');
  });

  it('reports pooled totals as the sum across accounts', async () => {
    const pool = makePool({
      accounts: [
        { limit: 100, usage: 40 },
        { limit: 200, usage: 10 },
      ],
      chunkSize: 400,
    });
    const usage = await new QuotaSyncService({
      accounts: pool.store,
      providers: (id) => pool.providers.get(id)!,
    }).poolUsage(pool.ownerId);
    expect(usage).toEqual({ limit: 300, usage: 50, free: 250 });
  });
});

describe('scenario (c): an aborted or crashed upload leaves nothing visible and remote chunks are cleaned', () => {
  it('a connection failure mid-upload never commits and deletes the chunks already written', async () => {
    const pool = makePool({ accounts: [nearlyFull(), nearlyFull(), nearlyFull()], chunkSize: 400 });
    // Third chunk fails midway; earlier chunks are already on remote accounts.
    let calls = 0;
    for (const p of pool.providers.values()) {
      const original = p.upload.bind(p);
      p.upload = (...args) =>
        ++calls === 3 ? Promise.reject(new StorageError('reset')) : original(...args);
    }
    let committed = false;
    const data = patterned(3 * GB);
    await expect(
      pool.uploads.store(
        {
          ownerId: pool.ownerId,
          fileId: randomUUID(),
          source: pieces(data, 777),
          size: data.length,
          encrypt: false,
        },
        () => {
          committed = true;
          return Promise.resolve();
        },
      ),
    ).rejects.toBeInstanceOf(StorageError);

    expect(committed).toBe(false);
    expect(pool.totalBlobs()).toBe(0);
    expect(pool.outbox.size).toBe(0);
    for (const p of pool.providers.values()) expect((await p.getQuota()).usage).toBe(14 * GB);
  });

  it('a failing metadata commit rolls back every remote chunk', async () => {
    const pool = makePool({ accounts: [nearlyFull(), nearlyFull(), nearlyFull()], chunkSize: 400 });
    const data = patterned(2 * GB);
    await expect(
      pool.uploads.store(
        {
          ownerId: pool.ownerId,
          fileId: randomUUID(),
          source: pieces(data, 500),
          size: data.length,
          encrypt: true,
        },
        () => Promise.reject(new Error('db unavailable')),
      ),
    ).rejects.toThrow('db unavailable');
    expect(pool.totalBlobs()).toBe(0);
  });

  it('when immediate deletion is impossible, the cleanup job removes the blobs later', async () => {
    const pool = makePool({ accounts: [nearlyFull(), nearlyFull()], chunkSize: 400 });
    const data = patterned(1800);
    // The account dies after bytes are written but before commit, so rollback cannot delete.
    await expect(
      pool.uploads.store(
        {
          ownerId: pool.ownerId,
          fileId: randomUUID(),
          source: pieces(data, 500),
          size: data.length,
          encrypt: false,
        },
        () => {
          for (const p of pool.providers.values()) p.setDown(true);
          return Promise.reject(new Error('commit failed'));
        },
      ),
    ).rejects.toThrow('commit failed');
    expect(pool.totalBlobs()).toBeGreaterThan(0);
    expect(pool.outbox.size).toBeGreaterThan(0);

    expect(await pool.cleanup.run()).toMatchObject({ deleted: 0, failed: pool.outbox.size });
    for (const p of pool.providers.values()) p.setDown(false);
    pool.advanceClock(1_000_000); // past the retry backoff
    const result = await pool.cleanup.run();

    expect(result.failed).toBe(0);
    expect(pool.totalBlobs()).toBe(0);
    expect(pool.outbox.size).toBe(0);
  });

  it('after a hard crash (no rollback ever runs) leftover blobs are reaped once the grace period passes', async () => {
    const pool = makePool({
      accounts: [nearlyFull(), nearlyFull()],
      chunkSize: 400,
      cleanupGraceMs: 60_000,
    });
    const data = patterned(1800);
    // The process "dies" inside commit: the promise never settles, so neither commit nor rollback runs.
    void pool.uploads.store(
      {
        ownerId: pool.ownerId,
        fileId: randomUUID(),
        source: pieces(data, 500),
        size: data.length,
        encrypt: false,
      },
      () => new Promise<void>(() => undefined),
    );
    await vi_waitFor(() => pool.totalBlobs() >= 2);

    expect((await pool.cleanup.run()).deleted).toBe(0); // still inside the grace window: may be a live upload
    expect(pool.totalBlobs()).toBeGreaterThan(0);

    pool.advanceClock(61_000);
    await pool.cleanup.run();
    expect(pool.totalBlobs()).toBe(0);
    expect(pool.outbox.size).toBe(0);
  });

  it('a committed upload leaves no outbox entries behind', async () => {
    const pool = makePool({ accounts: [nearlyFull(), nearlyFull(), nearlyFull()], chunkSize: 400 });
    await pool.put(patterned(2 * GB));
    expect(pool.outbox.size).toBe(0);
  });
});

describe('scenario (d): tampering is detected', () => {
  const setup = async (encrypt: boolean) => {
    const pool = makePool({ accounts: [{ limit: 1000 }, { limit: 1000 }], chunkSize: 400 });
    const data = patterned(1500);
    const stored = await pool.put(data, encrypt);
    expect(stored.chunks.length).toBeGreaterThan(1);
    return { pool, data, stored };
  };

  it('a flipped bit in an encrypted chunk fails the download with an integrity error', async () => {
    const { pool, stored } = await setup(true);
    const target = stored.chunks[1]!;
    pool.providers.get(target.accountId)!.corrupt(target.remoteId, 5);
    await expect(read(pool, stored)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('a flipped bit in an unencrypted chunk is caught by the checksum', async () => {
    const { pool, stored } = await setup(false);
    const target = stored.chunks[0]!;
    pool.providers.get(target.accountId)!.corrupt(target.remoteId, 3);
    await expect(read(pool, stored)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('GCM alone catches an attacker who also rewrites the recorded checksum', async () => {
    const { pool, stored } = await setup(true);
    const target = stored.chunks[0]!;
    pool.providers.get(target.accountId)!.corrupt(target.remoteId, 0);
    const blob = await collect(
      await pool.providers.get(target.accountId)!.download(target.remoteId),
    );
    const { createHash } = await import('node:crypto');
    const forged = {
      ...stored,
      chunks: stored.chunks.map((c) =>
        c === target ? { ...c, sha256: createHash('sha256').update(blob).digest('hex') } : c,
      ),
    };
    await expect(read(pool, forged)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('swapping two chunks is detected because the chunk index is authenticated', async () => {
    const { pool, stored } = await setup(true);
    const [c0, c1] = [stored.chunks[0]!, stored.chunks[1]!];
    const swap = (a: typeof c0, b: typeof c0) => ({
      ...a,
      accountId: b.accountId,
      remoteId: b.remoteId,
      size: b.size,
      sha256: b.sha256,
      nonce: b.nonce,
    });
    const swapped = { ...stored, chunks: [swap(c0, c1), swap(c1, c0), ...stored.chunks.slice(2)] };
    await expect(read(pool, swapped)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('dropping the last chunk is detected because the chunk count is authenticated', async () => {
    const { pool, stored } = await setup(true);
    const truncated = { ...stored, chunks: stored.chunks.slice(0, -1) };
    await expect(read(pool, truncated)).rejects.toBeInstanceOf(IntegrityError);
  });

  it('a wrapped key cannot be moved to another file', async () => {
    const { pool, stored } = await setup(true);
    expect(() => pool.keyRing.unwrap(stored.encryption!, randomUUID())).toThrow(IntegrityError);
  });

  it('ciphertext on the remote does not contain the plaintext', async () => {
    const { pool, data, stored } = await setup(true);
    const c = stored.chunks[0]!;
    const blob = await collect(await pool.providers.get(c.accountId)!.download(c.remoteId));
    expect(blob.includes(data.subarray(0, 32))).toBe(false);
  });
});

describe('downloads', () => {
  it('serves byte ranges for whole, unencrypted files only', async () => {
    const pool = makePool({ accounts: [{ limit: 10 * GB }], chunkSize: 400 });
    const data = patterned(300);
    const whole = await pool.put(data);
    expect(await read(pool, whole, { start: 10, end: 49 })).toEqual(data.subarray(10, 50));

    const small = makePool({ accounts: [{ limit: 1000 }, { limit: 1000 }], chunkSize: 400 });
    const split = await small.put(patterned(1500));
    await expect(read(small, split, { start: 0, end: 9 })).rejects.toThrow(/range/);
  });

  it('surfaces an auth failure on a provider as a typed error', async () => {
    const pool = makePool({ accounts: [{ limit: 10 * GB }], chunkSize: 400 });
    const stored = await pool.put(patterned(100));
    pool.providers.get(pool.accountIds[0]!)!.setDown(true);
    // Raised by open() itself, before any byte is produced, so HTTP can still send a clean error.
    await expect(pool.downloads.open(pool.ownerId, stored)).rejects.toBeInstanceOf(
      ProviderAuthError,
    );
  });

  it('reports an auth failure on a LATER chunk while streaming, and notifies the health hook', async () => {
    const failures: string[] = [];
    const pool = makePool({ accounts: [{ limit: 10 * GB }, { limit: 10 * GB }], chunkSize: 400 });
    const stored = await pool.put(patterned(1000), true);
    const victim = stored.chunks.find(
      (c) => c.accountId !== stored.chunks[0]!.accountId,
    )!.accountId;
    const downloads = new DownloadService({
      accounts: pool.store,
      providers: (id) => pool.providers.get(id)!,
      keyRing: pool.keyRing,
      onAuthFailure: (id) => Promise.resolve(void failures.push(id)),
    });
    const stream = await downloads.open(pool.ownerId, stored);
    pool.providers.get(victim)!.setDown(true);
    await expect(collect(stream)).rejects.toBeInstanceOf(ProviderAuthError);
    expect(failures).toEqual([victim]);
  });
});

async function vi_waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  if (!cond()) throw new Error('condition not reached');
}
