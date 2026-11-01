import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileChunks, storageAccounts } from '../db/schema.js';
import { patterned } from '../storage/testing/harness.js';
import { createHarness, type Harness, type Session } from '../testing/http-harness.js';

const url = process.env.TEST_DATABASE_URL;
const body = (res: { rawPayload: Buffer }) => res.rawPayload;

describe.skipIf(!url)('removing a Google account over HTTP', () => {
  let h: Harness;
  let admin: Session;

  beforeAll(async () => {
    h = await createHarness(url!);
    admin = await h.login('admin@x.io', true);
  });
  afterAll(() => h.close());

  const status = async (id: string) =>
    (await h.db.select().from(storageAccounts).where(eq(storageAccounts.id, id)))[0]!.status;
  const listed = async (who = admin) =>
    (await h.call('GET', '/accounts', who)).json() as Array<{
      id: string;
      status: string;
      remaining?: { parts: number; bytes: number };
    }>;

  it('is admin only', async () => {
    const u = await h.login('plain-user@x.io'); // an ordinary user, not the admin
    const a = await h.linkAccount(u, { limit: 1000 });
    expect((await h.call('DELETE', `/accounts/${a.id}`, u)).statusCode).toBe(403);
    expect((await h.call('POST', `/accounts/${a.id}/cancel-removal`, u)).statusCode).toBe(403);
    expect(await status(a.id)).toBe('HEALTHY');
  });

  describe('as the admin', () => {
    let owner: Session;
    let accts: Awaited<ReturnType<Harness['linkAccount']>>[];
    const originals = new Map<string, Buffer>();

    beforeAll(async () => {
      owner = admin;
      accts = [];
      for (let i = 0; i < 3; i++) accts.push(await h.linkAccount(owner, { limit: 100_000 }));
      for (const [name, size, encrypt] of [
        ['a.txt', 700, false],
        ['b.bin', 1500, false],
        ['c.enc', 1300, true],
        ['d.txt', 90, false],
      ] as const) {
        const data = patterned(size, size);
        const up = await h.upload(owner, name, data, { encrypt });
        expect(up.statusCode).toBe(201);
        originals.set(up.json().id, data);
      }
    });

    const assertAllReadable = async () => {
      for (const [id, data] of originals) {
        const res = await h.call('GET', `/files/${id}/content`, owner);
        expect(res.statusCode).toBe(200);
        expect(body(res)).toEqual(data);
      }
    };

    it('starts removal, keeps serving files and sending new uploads elsewhere, then finishes', async () => {
      const chunks = await h.db.select().from(fileChunks);
      const counts = new Map<string, number>();
      for (const c of chunks) counts.set(c.accountId, (counts.get(c.accountId) ?? 0) + 1);
      const victim = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      const victimBlobs = accts.find((a) => a.id === victim)!.provider;
      const pieces = counts.get(victim)!;

      const start = await h.call('DELETE', `/accounts/${victim}`, owner);
      expect(start.statusCode).toBe(202);
      expect(await status(victim)).toBe('DRAINING');
      const during = (await listed()).find((a) => a.id === victim)!;
      expect(during).toMatchObject({ status: 'DRAINING', remaining: { parts: pieces } });
      await assertAllReadable(); // nothing is unavailable while it is being emptied

      // A new upload avoids the account that is leaving.
      const fresh = (await h.upload(owner, 'during.txt', patterned(400, 7))).json();
      const freshChunks = await h.db
        .select()
        .from(fileChunks)
        .where(eq(fileChunks.fileId, fresh.id));
      expect(freshChunks.every((c) => c.accountId !== victim)).toBe(true);
      originals.set(fresh.id, patterned(400, 7));

      // The worker job does the moving.
      const run = (await h.jobs.run('drain')) as Array<{ finished: boolean; remaining: number }>;
      expect(run).toHaveLength(1);
      expect(run[0]).toMatchObject({ finished: true, remaining: 0 });
      expect(await status(victim)).toBe('DISCONNECTED');
      expect(await h.db.select().from(fileChunks).where(eq(fileChunks.accountId, victim))).toEqual(
        [],
      );
      await assertAllReadable(); // identical bytes from the new locations, encrypted included

      // Old copies disappear from Google once cleanup runs.
      await h.cleanup.run();
      expect(victimBlobs.blobCount).toBe(0);
      await assertAllReadable();

      // The pool no longer counts it, and the API says so.
      const usage = (await h.call('GET', '/storage/usage', owner)).json();
      expect(usage.accounts.total).toBe(2);
      expect((await listed()).find((a) => a.id === victim)!.status).toBe('DISCONNECTED');
    });

    it('refuses to remove it twice or to remove an unknown or malformed account', async () => {
      const gone = (await listed()).find((a) => a.status === 'DISCONNECTED')!;
      const again = await h.call('DELETE', `/accounts/${gone.id}`, owner);
      expect(again.statusCode).toBe(409);
      expect(again.json().code).toBe('account_not_removable');
      expect(
        (await h.call('DELETE', `/accounts/${'0'.repeat(8)}-0000-4000-8000-000000000000`, owner))
          .statusCode,
      ).toBe(404);
      expect((await h.call('DELETE', '/accounts/not-a-uuid', owner)).statusCode).toBe(400);
    });

    it('lets the admin change their mind', async () => {
      const healthy = (await listed()).filter((a) => a.status === 'HEALTHY');
      const target = healthy[0]!.id;
      expect((await h.call('DELETE', `/accounts/${target}`, owner)).statusCode).toBe(202);
      expect((await h.call('POST', `/accounts/${target}/cancel-removal`, owner)).statusCode).toBe(
        200,
      );
      expect(await status(target)).toBe('HEALTHY');
      const cancelAgain = await h.call('POST', `/accounts/${target}/cancel-removal`, owner);
      expect(cancelAgain.statusCode).toBe(409);
      await assertAllReadable();
    });

    it('will not remove an offline account (its files cannot be read), until it is re-authorised', async () => {
      const [a] = (await listed()).filter((x) => x.status === 'HEALTHY');
      await h.db
        .update(storageAccounts)
        .set({ status: 'DEGRADED' })
        .where(eq(storageAccounts.id, a!.id));
      const res = await h.call('DELETE', `/accounts/${a!.id}`, owner);
      expect(res.statusCode).toBe(409);
      expect(res.json().message).toMatch(/Re-authorise/i);
      await h.db
        .update(storageAccounts)
        .set({ status: 'HEALTHY' })
        .where(eq(storageAccounts.id, a!.id));
    });
  });

  describe('when the other accounts cannot take the files', () => {
    it('refuses up front if the total free space is too small', async () => {
      const u = await h.login('tight@x.io');
      const big = await h.linkAccount(u, { limit: 5000 });
      await h.linkAccount(u, { limit: 300 });
      await h.upload(u, 'heavy.bin', patterned(2000, 3));
      // The 5000 account holds 2000 bytes; the only other has 300 free. Make `u` an admin-equivalent
      // by calling the service directly (roles are covered elsewhere).
      await expect(h.removal.start(u.id, big.id)).rejects.toThrow(/free but this account holds/);
      expect(await status(big.id)).toBe('HEALTHY');
    });

    it('pauses with an alert when no single account can hold a piece, then completes after more space is added', async () => {
      const u = await h.login('stuck@x.io');
      const leaving = await h.linkAccount(u, { limit: 5000 });
      const f = (await h.upload(u, 'whole.bin', patterned(600, 5))).json(); // stored whole, 600 bytes
      await h.linkAccount(u, { limit: 500, usage: 100 }); // 400 free
      await h.linkAccount(u, { limit: 500, usage: 100 }); // 400 free: 800 total, but no single 600

      await h.removal.start(u.id, leaving.id); // passes: 800 >= 600
      const first = (await h.jobs.run('drain')) as Array<{ finished: boolean; remaining: number }>;
      expect(first[0]).toMatchObject({ finished: false, remaining: 1 });
      expect(await status(leaving.id)).toBe('DRAINING');
      const alert = (await h.alerts.list(u.id)).find((a) => a.kind === 'removal_stuck');
      expect(alert?.message).toMatch(/paused/i);
      expect(alert?.message).toMatch(/free space/i);
      const still = await h.call('GET', `/files/${f.id}/content`, u);
      expect(body(still)).toEqual(patterned(600, 5)); // never lost, never unavailable

      await h.linkAccount(u, { limit: 5000 });
      const second = (await h.jobs.run('drain')) as Array<{ finished: boolean }>;
      expect(second[0]!.finished).toBe(true);
      expect(await status(leaving.id)).toBe('DISCONNECTED');
      expect((await h.alerts.list(u.id)).some((a) => a.kind === 'removal_stuck')).toBe(false);
      expect(body(await h.call('GET', `/files/${f.id}/content`, u))).toEqual(patterned(600, 5));
    });
  });

  it('in fake-storage mode moves the files before the request returns (the worker cannot see them)', async () => {
    const { RemovalService } = await import('./removal.service.js');
    const { PgChunkStore } = await import('../storage/pg-stores.js');
    const u = await h.login('inline@x.io');
    await h.linkAccount(u, { limit: 100_000 });
    await h.linkAccount(u, { limit: 100_000 });
    const f = (await h.upload(u, 'inline.bin', patterned(900, 8))).json();
    const inline = new RemovalService({
      db: h.db,
      accounts: h.store,
      chunks: new PgChunkStore(h.db),
      drain: h.drain,
      alerts: h.alerts,
      headroom: { percent: 0, minBytes: 0 },
      inlineDrain: true,
    });
    // Whichever account holds the file is the one to remove.
    const holder = (await h.db.select().from(fileChunks).where(eq(fileChunks.fileId, f.id)))[0]!
      .accountId;
    await inline.start(u.id, holder);
    expect(await status(holder)).toBe('DISCONNECTED');
    expect(body(await h.call('GET', `/files/${f.id}/content`, u))).toEqual(patterned(900, 8));
  });

  it('removes an empty account immediately', async () => {
    const u = await h.login('empty@x.io');
    const a = await h.linkAccount(u, { limit: 1000 });
    await h.linkAccount(u, { limit: 1000 });
    await h.removal.start(u.id, a.id);
    expect(await status(a.id)).toBe('DISCONNECTED');
  });

  it('a removed account can be linked again later', async () => {
    const u = await h.login('relink@x.io');
    const a = await h.linkAccount(u, { limit: 1000 });
    await h.linkAccount(u, { limit: 1000 });
    await h.removal.start(u.id, a.id);
    expect(await status(a.id)).toBe('DISCONNECTED');
    // Linking the same Google account again brings it back (same stored row).
    const { url: authUrl, nonce } = await h.accounts.start(u.id, undefined);
    const link = new URL(authUrl);
    const [row] = await h.db.select().from(storageAccounts).where(eq(storageAccounts.id, a.id));
    link.searchParams.set('code', `fake:${row!.email}`);
    const done = await h.accounts.complete(
      u.id,
      link.searchParams.get('code')!,
      link.searchParams.get('state')!,
      nonce,
    );
    expect(done.id).toBe(a.id);
    expect(await status(a.id)).toBe('HEALTHY');
  });
});
