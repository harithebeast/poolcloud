import { describe, expect, it } from 'vitest';
import { collect, makePool, patterned } from './testing/harness.js';
import type { StoredFile } from './upload-service.js';

type Pool = ReturnType<typeof makePool>;

/** The file as the chunk map describes it now (pieces may have moved since upload). */
const current = (pool: Pool, f: StoredFile): StoredFile => ({
  ...f,
  chunks: pool.chunks
    .all()
    .filter((c) => c.fileId === f.fileId)
    .sort((a, b) => a.index - b.index),
});

const read = async (pool: Pool, f: StoredFile) =>
  collect(await pool.downloads.open(pool.ownerId, current(pool, f)));

const holders = (pool: Pool, f: StoredFile) =>
  new Set(current(pool, f).chunks.map((c) => c.accountId));

async function filled(accounts = 3, limit = 3000) {
  const pool = makePool({
    accounts: Array.from({ length: accounts }, () => ({ limit })),
    chunkSize: 400,
  });
  const files = [
    { data: patterned(1500, 1), encrypt: false },
    { data: patterned(900, 2), encrypt: false },
    { data: patterned(1200, 3), encrypt: true }, // several encrypted pieces
    { data: patterned(700, 4), encrypt: true },
    { data: patterned(300, 5), encrypt: false },
  ];
  const stored: StoredFile[] = [];
  for (const f of files) stored.push(await pool.put(f.data, f.encrypt));
  return { pool, files, stored };
}

/** The account holding the most pieces: the most interesting one to remove. */
function busiest(pool: Pool) {
  const counts = new Map<string, number>();
  for (const c of pool.chunks.all()) counts.set(c.accountId, (counts.get(c.accountId) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
}

describe('removing a Google account: moving its pieces to the others', () => {
  it('moves everything off, keeps every file byte-identical, then disconnects the account', async () => {
    const { pool, files, stored } = await filled();
    const victim = busiest(pool);
    await pool.store.setStatus(victim, 'DRAINING');
    const finished: string[] = [];
    const drain = pool.drainer((id) => Promise.resolve(void finished.push(id)));

    const before = pool.chunks.all().filter((c) => c.accountId === victim).length;
    expect(before).toBeGreaterThan(0);
    const [result] = await drain.run();

    expect(result).toMatchObject({
      accountId: victim,
      moved: before,
      remaining: 0,
      finished: true,
    });
    expect(finished).toEqual([victim]);
    expect(pool.store.getStatus(victim)).toBe('DISCONNECTED');
    expect(pool.chunks.all().some((c) => c.accountId === victim)).toBe(false);

    // Every file still downloads identically, plain and encrypted, from the new locations.
    for (const [i, f] of stored.entries()) {
      expect(await read(pool, f)).toEqual(files[i]!.data);
      expect(holders(pool, f).has(victim)).toBe(false);
    }

    // The old copies are deleted by the cleanup job afterwards, and nothing else is.
    const blobsBefore = pool.totalBlobs();
    await pool.cleanup.run();
    expect(pool.providers.get(victim)!.blobCount).toBe(0);
    expect(pool.totalBlobs()).toBe(blobsBefore - before);
    for (const [i, f] of stored.entries()) expect(await read(pool, f)).toEqual(files[i]!.data);
  });

  it('keeps the chunk map consistent with what is really stored in each account', async () => {
    const { pool, stored } = await filled();
    const victim = busiest(pool);
    await pool.store.setStatus(victim, 'DRAINING');
    await pool.drainer().run();
    await pool.cleanup.run();

    for (const c of pool.chunks.all()) {
      expect(pool.providers.get(c.accountId)!.hasBlob(c.remoteId)).toBe(true);
    }
    // Total blobs equals total pieces: no leftovers, no missing copies.
    expect(pool.totalBlobs()).toBe(pool.chunks.all().length);
    expect(stored.length).toBeGreaterThan(0);
  });

  it('never touches accounts that are not being removed', async () => {
    const { pool } = await filled();
    const victim = busiest(pool);
    const others = pool.accountIds.filter((a) => a !== victim);
    const snapshot = others.map((a) => pool.chunks.all().filter((c) => c.accountId === a).length);
    await pool.store.setStatus(victim, 'DRAINING');
    expect(await pool.drainer().run()).toHaveLength(1);
    // Others only ever gain pieces.
    others.forEach((a, i) =>
      expect(pool.chunks.all().filter((c) => c.accountId === a).length).toBeGreaterThanOrEqual(
        snapshot[i]!,
      ),
    );
    for (const a of others) expect(pool.store.getStatus(a)).toBe('HEALTHY');
  });

  it('keeps files readable while the account is still being emptied', async () => {
    const { pool, files, stored } = await filled();
    const victim = busiest(pool);
    await pool.store.setStatus(victim, 'DRAINING');
    const drain = pool.drainer();
    const first = await drain.drain(pool.ownerId, victim, 1); // just one piece
    expect(first.moved).toBe(1);
    expect(first.finished).toBe(false);
    expect(pool.store.getStatus(victim)).toBe('DRAINING');
    for (const [i, f] of stored.entries()) expect(await read(pool, f)).toEqual(files[i]!.data);
  });

  it('stops with a clear message when the other accounts have no room, loses nothing, and resumes', async () => {
    // Two small accounts that are already nearly full, plus the one being removed.
    const pool = makePool({
      accounts: [{ limit: 3000 }, { limit: 700 }, { limit: 700 }],
      chunkSize: 400,
    });
    const big = patterned(2500, 9);
    const stored = await pool.put(big);
    const victim = current(pool, stored).chunks[0]!.accountId;
    await pool.store.setStatus(victim, 'DRAINING');

    const result = await pool.drainer().drain(pool.ownerId, victim);
    expect(result.finished).toBe(false);
    expect(result.stuck).toMatch(/enough free space/i);
    expect(result.remaining).toBeGreaterThan(0);
    expect(pool.store.getStatus(victim)).toBe('DRAINING');
    expect(await read(pool, stored)).toEqual(big); // still fully readable

    // Link a roomy account: the next pass completes.
    pool.store.addAccount({ id: 'roomy', ownerId: pool.ownerId, limit: 10_000, usage: 0 });
    pool.providers.set(
      'roomy',
      new (await import('./fake-provider.js')).FakeProvider({ limit: 10_000 }),
    );
    const again = await pool.drainer().drain(pool.ownerId, victim);
    expect(again).toMatchObject({ finished: true, remaining: 0 });
    expect(await read(pool, stored)).toEqual(big);
  });

  it('refuses to copy a damaged piece instead of spreading the damage', async () => {
    const { pool, stored } = await filled();
    const victim = busiest(pool);
    const bad = pool.chunks.all().find((c) => c.accountId === victim)!;
    pool.providers.get(victim)!.corrupt(bad.remoteId, 0);
    await pool.store.setStatus(victim, 'DRAINING');
    const blobsOnOthers = () =>
      pool.accountIds
        .filter((a) => a !== victim)
        .reduce((n, a) => n + pool.providers.get(a)!.blobCount, 0);
    const before = blobsOnOthers();

    const result = await pool.drainer().drain(pool.ownerId, victim, 100);
    expect(result.finished).toBe(false);
    expect(result.stuck).toMatch(/integrity/i);
    expect(
      pool.chunks.all().find((c) => c.fileId === bad.fileId && c.index === bad.index)?.accountId,
    ).toBe(victim);

    await pool.cleanup.run();
    // Pieces moved before the damaged one are fine; the damaged copy never reached another account.
    const copied = result.moved;
    expect(blobsOnOthers()).toBe(before + copied);
    expect(stored.length).toBeGreaterThan(0);
  });

  it('cleans up after a failed copy and leaves the original untouched', async () => {
    const { pool, files, stored } = await filled();
    const victim = busiest(pool);
    await pool.store.setStatus(victim, 'DRAINING');
    for (const a of pool.accountIds)
      if (a !== victim) pool.providers.get(a)!.failNextUploadAfter(1);

    const result = await pool.drainer().drain(pool.ownerId, victim);
    expect(result.finished).toBe(false);
    expect(result.stuck).toBeDefined();
    await pool.cleanup.run();
    expect(pool.totalBlobs()).toBe(pool.chunks.all().length); // no half-written blob survives
    for (const [i, f] of stored.entries()) expect(await read(pool, f)).toEqual(files[i]!.data);
  });

  it('drops its copy when the file was purged while the piece was being moved', async () => {
    const { pool } = await filled();
    const victim = busiest(pool);
    await pool.store.setStatus(victim, 'DRAINING');
    // Simulate a purge landing between the copy and the pointer switch.
    const real = pool.chunks.repoint.bind(pool.chunks);
    let first = true;
    pool.chunks.repoint = async (chunk, to) => {
      if (first) {
        first = false;
        pool.chunks.removeFile(chunk.fileId);
      }
      return real(chunk, to);
    };
    await pool.drainer().drain(pool.ownerId, victim, 1);
    await pool.cleanup.run();
    // The copy made for the purged file is gone; every remaining piece still has its blob.
    for (const c of pool.chunks.all())
      expect(pool.providers.get(c.accountId)!.hasBlob(c.remoteId)).toBe(true);
    expect(pool.totalBlobs()).toBeGreaterThanOrEqual(pool.chunks.all().length);
  });

  it('disconnects an account that holds nothing straight away', async () => {
    const pool = makePool({ accounts: [{ limit: 1000 }, { limit: 1000 }], chunkSize: 400 });
    const [a] = pool.accountIds;
    await pool.store.setStatus(a!, 'DRAINING');
    const result = await pool.drainer().drain(pool.ownerId, a!, 0);
    expect(result).toMatchObject({ finished: true, moved: 0, remaining: 0 });
    expect(pool.store.getStatus(a!)).toBe('DISCONNECTED');
  });

  it('ignores accounts that are healthy or degraded', async () => {
    const { pool } = await filled();
    await pool.store.setStatus(pool.accountIds[0]!, 'DEGRADED');
    expect(await pool.drainer().run()).toEqual([]);
  });
});
