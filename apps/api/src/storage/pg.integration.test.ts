import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../db/schema.js';
import {
  fileChunks,
  nodes,
  quotaReservations,
  remoteCleanup,
  storageAccounts,
  users,
} from '../db/schema.js';
import { CleanupService } from './cleanup-service.js';
import { KeyRing } from './crypto.js';
import { DownloadService } from './download-service.js';
import { FakeProvider } from './fake-provider.js';
import { PgAccountStore, PgCleanupOutbox } from './pg-stores.js';
import { UploadService, type StoredFile } from './upload-service.js';
import { collect, patterned, pieces } from './testing/harness.js';

const url = process.env.TEST_DATABASE_URL;
const GB = 1000;
const noHeadroom = { percent: 0, minBytes: 0 };

describe.skipIf(!url)('Postgres-backed stores', () => {
  const pool = new Pool({ connectionString: url, max: 20 });
  const db = drizzle(pool, { schema });
  const accounts = new PgAccountStore(db);
  const outbox = new PgCleanupOutbox(db);
  let ownerId: string;

  beforeAll(async () => {
    await migrate(db, { migrationsFolder: join(import.meta.dirname, '../../drizzle') });
  });
  afterAll(async () => {
    await pool.end();
  });

  async function newOwner() {
    const [u] = await db
      .insert(users)
      .values({ email: `${randomUUID()}@test.local`, passwordHash: 'x' })
      .returning({ id: users.id });
    return u!.id;
  }
  async function newAccount(owner: string, limit: number, usage = 0) {
    const [a] = await db
      .insert(storageAccounts)
      .values({
        ownerId: owner,
        googleSub: randomUUID(),
        email: 'a@test',
        refreshTokenEnc: 'enc',
        quotaLimit: limit,
        quotaUsage: usage,
      })
      .returning({ id: storageAccounts.id });
    return a!.id;
  }

  it('serialises concurrent reservations with row locks', async () => {
    ownerId = await newOwner();
    const a = await newAccount(ownerId, 1000);
    const results = await Promise.all(
      Array.from({ length: 30 }, () => accounts.tryReserve(ownerId, a, 100, 60_000, noHeadroom)),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect((await accounts.list(ownerId))[0]!.reserved).toBe(1000);

    await accounts.release(results.find(Boolean)!.id);
    expect(await accounts.tryReserve(ownerId, a, 100, 60_000, noHeadroom)).not.toBeNull();
  });

  it('ignores expired reservations, unhealthy accounts and foreign owners', async () => {
    const owner = await newOwner();
    const a = await newAccount(owner, 100);
    await db.insert(quotaReservations).values({
      ownerId: owner,
      accountId: a,
      bytes: 100,
      expiresAt: sql`now() - interval '1 minute'`,
    });
    expect(await accounts.tryReserve(owner, a, 100, 60_000, noHeadroom)).not.toBeNull();

    await accounts.setStatus(a, 'DEGRADED', 'token revoked');
    expect(await accounts.tryReserve(owner, a, 1, 60_000, noHeadroom)).toBeNull();
    expect(await accounts.tryReserve(await newOwner(), a, 1, 60_000, noHeadroom)).toBeNull();
    expect(await accounts.list(await newOwner())).toEqual([]);
  });

  it('tracks usage, quota sync and failure counts', async () => {
    const owner = await newOwner();
    const a = await newAccount(owner, 100, 10);
    await accounts.adjustUsage(a, 40);
    await accounts.adjustUsage(a, -500);
    expect((await accounts.list(owner))[0]!.usage).toBe(0);
    await accounts.setQuota(a, { limit: 500, usage: 123 });
    expect((await accounts.list(owner))[0]).toMatchObject({ limit: 500, usage: 123 });
    expect(await accounts.recordFailure(a, 'x')).toBe(1);
    expect(await accounts.recordFailure(a, 'x')).toBe(2);
    await accounts.resetFailures(a);
    expect(await accounts.recordFailure(a, 'x')).toBe(1);
  });

  it('runs the cleanup outbox lifecycle: grace, expedite, retry backoff, remove', async () => {
    const owner = await newOwner();
    const a = await newAccount(owner, 100);
    const entry = { ownerId: owner, accountId: a, remoteId: randomUUID(), reason: 'test' };
    const id = await outbox.add(entry, 60_000);
    const due = async () => (await outbox.claimDue(1000)).filter((e) => e.id === id);
    expect(await due()).toHaveLength(0);
    await outbox.expedite([id]);
    expect(await due()).toHaveLength(1);
    await outbox.recordFailure(id, 60_000);
    expect(await due()).toHaveLength(0);
    await outbox.expedite([id]);
    expect((await due())[0]!.attempts).toBe(1);
    await outbox.remove([id]);
    expect(await due()).toHaveLength(0);
    await outbox.remove([]);
    await outbox.expedite([]);
  });

  it('scenario (a) end-to-end: 3 nearly-full accounts, 3 GB file, metadata committed atomically in Postgres', async () => {
    const owner = await newOwner();
    const ids = await Promise.all([1, 2, 3].map(() => newAccount(owner, 15 * GB, 14 * GB)));
    const providers = new Map(
      ids.map((id) => [id, new FakeProvider({ limit: 15 * GB, initialUsage: 14 * GB })]),
    );
    const resolve = (id: string) => providers.get(id)!;
    const keyRing = KeyRing.parse(`k1:${Buffer.alloc(32, 9).toString('base64')}`);
    const uploads = new UploadService({
      accounts,
      outbox,
      providers: resolve,
      keyRing,
      settings: {
        chunkSize: 400,
        headroom: noHeadroom,
        reservationTtlMs: 60_000,
        cleanupGraceMs: 60_000,
      },
    });
    const data = patterned(3 * GB, 5);
    const fileId = randomUUID();

    const stored = await uploads.store(
      { ownerId: owner, fileId, source: pieces(data, 999), size: data.length, encrypt: false },
      (file) =>
        db.transaction(async (tx) => {
          await tx.insert(nodes).values({
            id: file.fileId,
            ownerId: owner,
            type: 'file',
            name: 'big.bin',
            size: file.size,
          });
          await tx
            .insert(fileChunks)
            .values(file.chunks.map((c) => ({ ...c, fileId: file.fileId })));
        }),
    );

    expect(new Set(stored.chunks.map((c) => c.accountId)).size).toBe(3);
    expect(
      await db.select().from(remoteCleanup).where(eq(remoteCleanup.ownerId, owner)),
    ).toHaveLength(0);
    expect(
      await db.select().from(quotaReservations).where(eq(quotaReservations.ownerId, owner)),
    ).toHaveLength(0);

    // Read the chunk map back from the database, as the API will, and download.
    const rows = await db
      .select()
      .from(fileChunks)
      .where(eq(fileChunks.fileId, fileId))
      .orderBy(fileChunks.index);
    const fromDb: StoredFile = { fileId, size: data.length, encryption: null, chunks: rows };
    const downloads = new DownloadService({ accounts, providers: resolve, keyRing });
    expect(await collect(await downloads.open(owner, fromDb))).toEqual(data);
  });

  it('a failed commit leaves no node, no chunks, and the cleanup job removes the blobs', async () => {
    const owner = await newOwner();
    const ids = await Promise.all([1, 2].map(() => newAccount(owner, 15 * GB, 14 * GB)));
    const providers = new Map(
      ids.map((id) => [id, new FakeProvider({ limit: 15 * GB, initialUsage: 14 * GB })]),
    );
    const resolve = (id: string) => providers.get(id)!;
    const uploads = new UploadService({
      accounts,
      outbox,
      providers: resolve,
      keyRing: KeyRing.parse(`k1:${Buffer.alloc(32, 9).toString('base64')}`),
      settings: {
        chunkSize: 400,
        headroom: noHeadroom,
        reservationTtlMs: 60_000,
        cleanupGraceMs: 0,
      },
    });
    const fileId = randomUUID();
    const data = patterned(1800);

    await expect(
      uploads.store(
        { ownerId: owner, fileId, source: pieces(data, 500), size: data.length, encrypt: true },
        async () => {
          for (const p of providers.values()) p.setDown(true); // rollback cannot reach Drive
          throw new Error('commit failed');
        },
      ),
    ).rejects.toThrow('commit failed');

    expect(await db.select().from(nodes).where(eq(nodes.id, fileId))).toHaveLength(0);
    expect(await db.select().from(fileChunks).where(eq(fileChunks.fileId, fileId))).toHaveLength(0);
    const pending = await db.select().from(remoteCleanup).where(eq(remoteCleanup.ownerId, owner));
    expect(pending.length).toBeGreaterThan(0);

    for (const p of providers.values()) p.setDown(false);
    await db
      .update(remoteCleanup)
      .set({ nextAttemptAt: sql`now()` })
      .where(eq(remoteCleanup.ownerId, owner));
    await new CleanupService({ outbox, providers: resolve }).run();

    expect([...providers.values()].reduce((n, p) => n + p.blobCount, 0)).toBe(0);
    expect(
      await db.select().from(remoteCleanup).where(eq(remoteCleanup.ownerId, owner)),
    ).toHaveLength(0);
  });

  it('enforces unique names among live siblings but allows reuse after trashing', async () => {
    const owner = await newOwner();
    const folder = async (name: string, parentId: string | null = null) =>
      db
        .insert(nodes)
        .values({ ownerId: owner, parentId, type: 'folder', name })
        .returning({ id: nodes.id });
    const [root] = await folder('docs');
    await expect(folder('docs')).rejects.toThrow();
    await db.update(nodes).set({ trashedAt: new Date() }).where(eq(nodes.id, root!.id));
    await expect(folder('docs')).resolves.toBeDefined();
    const [child] = await folder('a', root!.id);
    await expect(folder('a', root!.id)).rejects.toThrow();
    expect(child).toBeDefined();
  });
});
