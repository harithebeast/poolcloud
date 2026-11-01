import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  alerts,
  fileChunks,
  nodes,
  remoteCleanup,
  sessions,
  storageAccounts,
} from '../db/schema.js';
import { patterned } from '../storage/testing/harness.js';
import { createHarness, type Harness, type Session } from '../testing/http-harness.js';
import { JOB_NAMES, schedule } from './maintenance.js';

const url = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;

describe('job schedule', () => {
  it('has a positive interval for every job and follows the quota sync setting', () => {
    const s = schedule(120);
    expect(Object.keys(s).sort()).toEqual([...JOB_NAMES].sort());
    expect(s['quota-sync']).toBe(120);
    for (const v of Object.values(s)) expect(v).toBeGreaterThan(0);
  });
});

describe.skipIf(!url)('maintenance jobs (Postgres)', () => {
  let h: Harness;
  let owner: Session;

  beforeAll(async () => {
    h = await createHarness(url!);
    owner = await h.login('jobs@x.io', true);
  });
  afterAll(() => h.close());

  const openAlerts = async (kind: string) =>
    (await h.alerts.list(owner.id)).filter((a) => a.kind === kind);

  it('quota sync refreshes real usage from the provider, for every owner', async () => {
    const a = await h.linkAccount(owner, { limit: 5_000, usage: 100 });
    a.provider.plantBlob(randomUUID(), Buffer.alloc(400));
    await h.jobs.run('quota-sync');
    const [row] = await h.db.select().from(storageAccounts).where(eq(storageAccounts.id, a.id));
    expect(row).toMatchObject({ quotaLimit: 5_000, quotaUsage: 500 });
  });

  it('degrades a revoked account, raises ONE alert, and the API lists and dismisses it', async () => {
    const a = await h.linkAccount(owner, { limit: 5_000 });
    a.provider.setDown(true);
    await h.jobs.run('quota-sync');
    await h.jobs.run('quota-sync'); // second run must not duplicate the alert
    const [row] = await h.db.select().from(storageAccounts).where(eq(storageAccounts.id, a.id));
    expect(row!.status).toBe('DEGRADED');

    const open = await openAlerts('account_degraded');
    expect(open).toHaveLength(1);
    expect(open[0]!.accountId).toBe(a.id);

    const list = (await h.call('GET', '/alerts', owner)).json().items;
    expect(list.map((x: { id: string }) => x.id)).toContain(open[0]!.id);
    expect((await h.call('DELETE', `/alerts/${open[0]!.id}`, owner)).statusCode).toBe(204);
    expect((await h.call('DELETE', `/alerts/${open[0]!.id}`, owner)).statusCode).toBe(404);
    a.provider.setDown(false);
  });

  it('a revoked token noticed during an upload degrades that account immediately', async () => {
    const u = await h.login('live@x.io');
    const a = await h.linkAccount(u, { limit: 10_000 });
    a.provider.setDown(true);
    const res = await h.upload(u, 'x.bin', patterned(100));
    expect(res.statusCode).toBe(502);
    const [row] = await h.db.select().from(storageAccounts).where(eq(storageAccounts.id, a.id));
    expect(row!.status).toBe('DEGRADED');
    expect((await h.alerts.list(u.id)).map((x) => x.kind)).toContain('account_degraded');
  });

  it('a revoked token noticed during a download degrades the account and nothing is deleted', async () => {
    const u = await h.login('dl@x.io');
    const a = await h.linkAccount(u, { limit: 10_000 });
    const f = (await h.upload(u, 'keep.bin', patterned(100))).json();
    a.provider.setDown(true); // revoked, but the database does not know yet
    const res = await h.call('GET', `/files/${f.id}/content`, u);
    expect(res.statusCode).toBe(502);
    const [row] = await h.db.select().from(storageAccounts).where(eq(storageAccounts.id, a.id));
    expect(row!.status).toBe('DEGRADED');
    expect(await h.db.select().from(nodes).where(eq(nodes.id, f.id))).toHaveLength(1);
    expect(await h.db.select().from(fileChunks).where(eq(fileChunks.fileId, f.id))).toHaveLength(1);
    expect((await h.call('GET', `/files/${f.id}/content`, u)).statusCode).toBe(503);
  });

  describe('orphan scan (report only)', () => {
    it('reports old unknown blobs and missing chunks, ignores young ones and queued deletions', async () => {
      const u = await h.login('orphan@x.io');
      const a = await h.linkAccount(u, { limit: 100_000 });
      const kept = (await h.upload(u, 'kept.bin', patterned(300))).json();
      const lost = (await h.upload(u, 'lost.bin', patterned(300, 2))).json();
      const [lostChunk] = await h.db
        .select()
        .from(fileChunks)
        .where(eq(fileChunks.fileId, lost.id));
      a.provider.loseBlob(lostChunk!.remoteId);

      const orphan = randomUUID();
      a.provider.plantBlob(orphan, Buffer.alloc(77), 3 * DAY);
      a.provider.plantBlob(randomUUID(), Buffer.alloc(5), 1000); // looks like a running upload
      const queued = randomUUID();
      a.provider.plantBlob(queued, Buffer.alloc(9), 3 * DAY);
      await h.db
        .insert(remoteCleanup)
        .values({ ownerId: u.id, accountId: a.id, remoteId: queued, reason: 'purge' });

      const report = await h.orphans.scan(u.id);
      expect(report.orphanCount).toBe(1);
      expect(report.orphanBytes).toBe(77);
      expect(report.accounts[0]!.orphans[0]!.remoteId).toBe(orphan);
      expect(report.accounts[0]!.missing).toEqual([lostChunk!.remoteId]);

      await h.jobs.run('orphan-scan');
      const msgs = (await h.alerts.list(u.id)).map((x) => x.kind).sort();
      expect(msgs).toEqual(['missing_blobs', 'orphan_blobs']);

      // Report only: nothing was deleted, and the healthy file still downloads.
      expect(a.provider.hasBlob(orphan)).toBe(true);
      expect((await h.call('GET', `/files/${kept.id}/content`, u)).statusCode).toBe(200);

      // Once the problems are gone, the alerts clear themselves.
      a.provider.loseBlob(orphan);
      await h.db.delete(fileChunks).where(eq(fileChunks.fileId, lost.id));
      await h.jobs.run('orphan-scan');
      expect(await h.alerts.list(u.id)).toEqual([]);
    });

    it('skips an offline account instead of failing the scan', async () => {
      const u = await h.login('offline-scan@x.io');
      const a = await h.linkAccount(u, { limit: 1000 });
      a.provider.setDown(true);
      const report = await h.orphans.scan(u.id);
      expect(report.accounts[0]!.error).toMatch(/revoked/);
      expect(report.orphanCount).toBe(0);
    });
  });

  it('cleanup removes blobs queued by a purge', async () => {
    const u = await h.login('clean@x.io');
    const a = await h.linkAccount(u, { limit: 100_000 });
    const f = (await h.upload(u, 'bye.bin', patterned(500))).json();
    const chunks = await h.db.select().from(fileChunks).where(eq(fileChunks.fileId, f.id));
    expect(chunks.length).toBeGreaterThan(0);
    await h.call('DELETE', `/files/${f.id}`, u);
    await h.call('DELETE', `/trash/${f.id}`, u);
    expect(chunks.every((c) => a.provider.hasBlob(c.remoteId))).toBe(true); // not yet
    await h.jobs.run('cleanup');
    expect(chunks.some((c) => a.provider.hasBlob(c.remoteId))).toBe(false);
  });

  it('trash purge honours the retention period, and session purge drops expired sessions', async () => {
    const u = await h.login('retain@x.io');
    await h.linkAccount(u, { limit: 100_000 });
    const old = (await h.upload(u, 'old.bin', patterned(10))).json();
    const fresh = (await h.upload(u, 'fresh.bin', patterned(10))).json();
    for (const f of [old, fresh]) await h.call('DELETE', `/files/${f.id}`, u);
    await h.db
      .update(nodes)
      .set({ trashedAt: new Date(Date.now() - 31 * DAY) })
      .where(eq(nodes.id, old.id));

    await h.jobs.run('trash-purge');
    expect(await h.db.select().from(nodes).where(eq(nodes.id, old.id))).toHaveLength(0);
    expect(await h.db.select().from(nodes).where(eq(nodes.id, fresh.id))).toHaveLength(1);

    await h.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    await h.jobs.run('session-purge');
    expect(await h.db.select().from(sessions)).toHaveLength(0);
  });

  it('one failing owner does not stop quota sync for the rest', async () => {
    const logs: string[] = [];
    const failing = new (await import('./maintenance.js')).MaintenanceJobs({
      db: h.db,
      quotaSync: {
        syncOwner: (id: string) =>
          id === owner.id ? Promise.reject(new Error('boom')) : Promise.resolve(),
      } as never,
      cleanup: h.cleanup,
      fs: h.fs,
      auth: h.auth,
      alerts: h.alerts,
      orphans: h.orphans,
      retentionDays: 30,
      log: (e) => void logs.push(e),
    });
    await expect(failing.quotaSync()).resolves.toBeGreaterThan(1);
    expect(logs).toContain('quota sync failed');
  });

  it('alerts are private to their owner', async () => {
    const stranger = await h.login('stranger@x.io');
    expect((await h.call('GET', '/alerts', stranger)).json().items).toEqual([]);
    const any = await h.db.select().from(alerts);
    expect(any.length).toBeGreaterThan(0);
    expect((await h.call('DELETE', `/alerts/${any[0]!.id}`, stranger)).statusCode).toBe(404);
  });
});
