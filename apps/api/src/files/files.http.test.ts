import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fileChunks, nodes, remoteCleanup, storageAccounts, uploads } from '../db/schema.js';
import { contentSecurityPolicy } from './files.controller.js';
import { createHarness, type Harness, type Session } from '../testing/http-harness.js';
import { patterned, pieces } from '../storage/testing/harness.js';

const url = process.env.TEST_DATABASE_URL;
const body = (res: { rawPayload: Buffer }) => res.rawPayload;

describe.skipIf(!url)('files over HTTP', () => {
  let h: Harness;
  let alice: Session;
  let bob: Session;

  beforeAll(async () => {
    h = await createHarness(url!);
    alice = await h.login('alice@x.io', true);
    bob = await h.login('bob@x.io');
    // Three big, roomy accounts for the general tests.
    for (let i = 0; i < 3; i++) await h.linkAccount(alice, { limit: 100_000 });
  });
  afterAll(() => h.close());

  it('uploads, lists, and downloads a file byte-for-byte with safe headers', async () => {
    const data = patterned(250);
    const up = await h.upload(alice, 'notes.txt', data);
    expect(up.statusCode).toBe(201);
    const node = up.json();
    expect(node).toMatchObject({ name: 'notes.txt', size: 250, type: 'file', encrypted: false });
    expect(JSON.stringify(node)).not.toMatch(/wrapped|keyId|account|remote/i);

    const list = await h.call('GET', '/files', alice);
    expect(list.json().items.map((i: { name: string }) => i.name)).toContain('notes.txt');

    const dl = await h.call('GET', `/files/${node.id}/content`, alice);
    expect(dl.statusCode).toBe(200);
    expect(body(dl)).toEqual(data);
    expect(dl.headers['content-type']).toBe('text/plain');
    expect(dl.headers['content-disposition']).toMatch(/^inline; filename="notes.txt"/);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    expect(String(dl.headers['content-security-policy'])).toMatch(/sandbox/);
    expect(dl.headers['accept-ranges']).toBe('bytes');
  });

  it('lets only the web app embed previews, and keeps PDFs viewable', async () => {
    const pdf = (await h.upload(alice, 'doc.pdf', Buffer.from('%PDF-1.4 test'))).json();
    const res = await h.call('GET', `/files/${pdf.id}/content`, alice);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain('frame-ancestors http://localhost:3000');
    expect(csp).not.toMatch(/sandbox/); // Chrome's PDF viewer does not run in a sandbox
    expect(csp).not.toMatch(/script-src|default-src 'self'/);

    const asDownload = await h.call('GET', `/files/${pdf.id}/content?download=1`, alice);
    expect(String(asDownload.headers['content-security-policy'])).toMatch(/^sandbox;/);
    expect(contentSecurityPolicy('text/plain', true, 'https://app.example')).toMatch(
      /^sandbox; .*frame-ancestors https:\/\/app\.example$/,
    );
  });

  it('serves byte ranges for whole files and rejects bad ranges', async () => {
    const data = patterned(1000);
    const node = (await h.upload(alice, 'range.bin', data)).json();
    const part = await h.call('GET', `/files/${node.id}/content`, alice, {
      headers: { range: 'bytes=100-199' },
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 100-199/1000');
    expect(body(part)).toEqual(data.subarray(100, 200));

    const tail = await h.call('GET', `/files/${node.id}/content`, alice, {
      headers: { range: 'bytes=-50' },
    });
    expect(body(tail)).toEqual(data.subarray(950));

    const bad = await h.call('GET', `/files/${node.id}/content`, alice, {
      headers: { range: 'bytes=5000-6000' },
    });
    expect(bad.statusCode).toBe(416);
  });

  it('forces risky types (html, svg) to download and sandboxes everything', async () => {
    for (const name of ['page.html', 'logo.svg', 'archive.zip']) {
      const node = (await h.upload(alice, name, Buffer.from('<script>alert(1)</script>'))).json();
      const dl = await h.call('GET', `/files/${node.id}/content`, alice);
      expect(dl.headers['content-disposition'], name).toMatch(/^attachment;/);
      expect(dl.headers['content-type'], name).toBe('application/octet-stream');
    }
    const odd = (await h.upload(alice, 'we"ird\r\nname.txt', Buffer.from('x'))).json();
    const dl = await h.call('GET', `/files/${odd.id}/content?download=1`, alice);
    expect(String(dl.headers['content-disposition'])).not.toMatch(/[\r\n]/);
  });

  it('splits files that are bigger than one chunk and reassembles them, encrypted or not', async () => {
    for (const encrypt of [false, true]) {
      const data = patterned(2500, 3);
      const node = (await h.upload(alice, `split-${encrypt}.bin`, data, { encrypt })).json();
      expect(node.encrypted).toBe(encrypt);
      const dl = await h.call('GET', `/files/${node.id}/content`, alice);
      expect(body(dl)).toEqual(data);
      // Range works for whole unencrypted files only: an encrypted file is always split into
      // authenticated records, so it streams in full.
      const withRange = await h.call('GET', `/files/${node.id}/content`, alice, {
        headers: { range: 'bytes=0-9' },
      });
      if (encrypt) {
        expect(withRange.statusCode).toBe(200);
        expect(withRange.headers['accept-ranges']).toBe('none');
        expect(body(withRange)).toEqual(data);
      } else {
        expect(withRange.statusCode).toBe(206); // fits one account, so stored whole
        expect(body(withRange)).toEqual(data.subarray(0, 10));
      }
    }
  });

  it('never stores plaintext of encrypted files on the remote accounts', async () => {
    const secret = Buffer.from('TOP-SECRET-MARKER '.repeat(40));
    const node = (await h.upload(alice, 'secret.txt', secret, { encrypt: true })).json();
    const chunks = await h.db.select().from(fileChunks).where(eq(fileChunks.fileId, node.id));
    for (const c of chunks) {
      const stored = await [...h.providers.values()]
        .find((p) => p.hasBlob(c.remoteId))!
        .download(c.remoteId);
      const parts: Buffer[] = [];
      for await (const p of stored) parts.push(p as Buffer);
      expect(Buffer.concat(parts).includes('TOP-SECRET')).toBe(false);
    }
  });

  it('is idempotent: retrying with the same key returns the same file and stores nothing twice', async () => {
    const data = patterned(300);
    const before = h.blobCount();
    const first = (await h.upload(alice, 'once.bin', data, { key: 'idem-key-0001' })).json();
    const afterFirst = h.blobCount();
    const retry = await h.upload(alice, 'once.bin', data, { key: 'idem-key-0001' });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().id).toBe(first.id);
    expect(h.blobCount()).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(before);

    const clash = await h.upload(alice, 'other-name.bin', data, { key: 'idem-key-0001' });
    expect(clash.statusCode).toBe(422);
    expect(clash.json().code).toBe('idempotency_mismatch');
  });

  it('refuses a retry while the original upload is still in progress, and takes over a crashed one', async () => {
    const data = patterned(100);
    await h.db.insert(uploads).values({
      ownerId: alice.id,
      idempotencyKey: 'in-flight-0001',
      name: 'inflight.bin',
      size: 100,
      state: 'open',
      expiresAt: new Date(Date.now() + 60_000),
    });
    const blocked = await h.upload(alice, 'inflight.bin', data, { key: 'in-flight-0001' });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().code).toBe('upload_in_progress');

    await h.db
      .update(uploads)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(uploads.idempotencyKey, 'in-flight-0001'));
    expect(
      (await h.upload(alice, 'inflight.bin', data, { key: 'in-flight-0001' })).statusCode,
    ).toBe(201);
  });

  it('rejects duplicate names before sending any bytes', async () => {
    await h.upload(alice, 'dup.txt', patterned(10));
    const blobs = h.blobCount();
    const again = await h.upload(alice, 'dup.txt', patterned(10));
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('name_conflict');
    expect(h.blobCount()).toBe(blobs);
  });

  it('validates upload requests', async () => {
    const noKey = await h.call('POST', '/files/upload?name=a.txt', alice, {
      payload: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream' },
    });
    expect(noKey.statusCode).toBe(400);
    const noName = await h.call('POST', '/files/upload', alice, {
      payload: Buffer.from('x'),
      headers: { 'content-type': 'application/octet-stream', 'idempotency-key': 'abcdefgh1' },
    });
    expect(noName.statusCode).toBe(400);
    expect((await h.upload(alice, '../evil', Buffer.from('x'))).statusCode).toBe(400);
    expect(
      (await h.upload(alice, 'x.txt', Buffer.from('x'), { parentId: 'not-a-uuid' })).statusCode,
    ).toBe(400);
  });

  it('uploads empty files', async () => {
    const node = (await h.upload(alice, 'empty.txt', Buffer.alloc(0))).json();
    expect(node.size).toBe(0);
    expect(body(await h.call('GET', `/files/${node.id}/content`, alice))).toEqual(Buffer.alloc(0));
  });

  it('a failing upload stream leaves no file, no remote blobs and a retryable key', async () => {
    const before = h.blobCount();
    const data = patterned(1500);
    const source = (async function* () {
      yield* pieces(data.subarray(0, 900), 300);
      throw new Error('client disconnected');
    })();
    await expect(
      h.files.upload({
        ownerId: alice.id,
        idempotencyKey: 'abort-key-0001',
        parentId: null,
        name: 'aborted.bin',
        size: data.length,
        source,
      }),
    ).rejects.toThrow('client disconnected');

    expect(h.blobCount()).toBe(before);
    expect(await h.db.select().from(nodes).where(eq(nodes.name, 'aborted.bin'))).toHaveLength(0);
    const [u] = await h.db
      .select()
      .from(uploads)
      .where(eq(uploads.idempotencyKey, 'abort-key-0001'));
    expect(u!.state).toBe('failed');

    const retry = await h.upload(alice, 'aborted.bin', data, { key: 'abort-key-0001' });
    expect(retry.statusCode).toBe(201);
    expect(body(await h.call('GET', `/files/${retry.json().id}/content`, alice))).toEqual(data);
  });

  it('a declared size that does not match the body is rejected without leaving data', async () => {
    const before = h.blobCount();
    const short = await h.files
      .upload({
        ownerId: alice.id,
        idempotencyKey: 'short-key-0001',
        parentId: null,
        name: 'short.bin',
        size: 500,
        source: pieces(patterned(200), 100),
      })
      .catch((e: unknown) => e);
    expect(short).toBeInstanceOf(Error);
    expect(h.blobCount()).toBe(before);
  });

  describe('folders, move, rename', () => {
    it('manages a tree through the API', async () => {
      const folder = (
        await h.call('POST', '/folders', alice, { body: { name: 'Projects' } })
      ).json();
      expect(folder).toMatchObject({ name: 'Projects', type: 'folder', parentId: null });
      const inner = (
        await h.call('POST', '/folders', alice, { body: { name: 'Q1', parentId: folder.id } })
      ).json();
      const up = (await h.upload(alice, 'plan.txt', patterned(20), { parentId: inner.id })).json();

      const info = (await h.call('GET', `/files/${up.id}`, alice)).json();
      expect(info.path.map((p: { name: string }) => p.name)).toEqual([
        'Projects',
        'Q1',
        'plan.txt',
      ]);

      const renamed = await h.call('PATCH', `/files/${up.id}`, alice, {
        body: { name: 'plan-v2.txt' },
      });
      expect(renamed.json().name).toBe('plan-v2.txt');
      const moved = await h.call('PATCH', `/files/${up.id}`, alice, { body: { parentId: null } });
      expect(moved.json().parentId).toBeNull();

      const cycle = await h.call('PATCH', `/files/${folder.id}`, alice, {
        body: { parentId: inner.id },
      });
      expect(cycle.statusCode).toBe(400);
      expect((await h.call('PATCH', `/files/${up.id}`, alice, { body: {} })).statusCode).toBe(400);
      expect(
        (await h.call('POST', '/folders', alice, { body: { name: 'Projects' } })).statusCode,
      ).toBe(409);
    });

    it('searches by name', async () => {
      await h.upload(alice, 'Quarterly Report.pdf', patterned(10));
      const res = await h.call('GET', '/files/search?q=quarterly', alice);
      expect(res.json().items.map((i: { name: string }) => i.name)).toEqual([
        'Quarterly Report.pdf',
      ]);
    });
  });

  describe('trash', () => {
    it('trashes, hides, restores and permanently deletes (queuing remote cleanup)', async () => {
      const data = patterned(2000);
      const node = (await h.upload(alice, 'doomed.bin', data)).json();
      const remote = h.blobCount();

      expect((await h.call('DELETE', `/files/${node.id}`, alice)).statusCode).toBe(204);
      expect((await h.call('GET', `/files/${node.id}/content`, alice)).statusCode).toBe(404);
      expect(
        (await h.call('GET', '/trash', alice)).json().items.map((i: { id: string }) => i.id),
      ).toContain(node.id);

      expect((await h.call('POST', `/trash/${node.id}/restore`, alice)).statusCode).toBe(201);
      expect(body(await h.call('GET', `/files/${node.id}/content`, alice))).toEqual(data);

      await h.call('DELETE', `/files/${node.id}`, alice);
      const purge = await h.call('DELETE', `/trash/${node.id}`, alice);
      expect(purge.json()).toEqual({ files: 1, bytes: 2000 });
      expect(h.blobCount()).toBe(remote); // blobs still there until the cleanup job runs
      const queued = await h.db.select().from(remoteCleanup);
      expect(queued.length).toBeGreaterThan(0);

      await h.cleanup.run();
      expect(h.blobCount()).toBeLessThan(remote);
      expect(await h.db.select().from(remoteCleanup)).toHaveLength(0);
    });
  });

  describe('isolation and auth', () => {
    it('requires a session and CSRF', async () => {
      expect((await h.call('GET', '/files')).statusCode).toBe(401);
      expect(
        (await h.call('POST', '/folders', { ...alice, csrf: 'bad' }, { body: { name: 'x' } }))
          .statusCode,
      ).toBe(403);
    });

    it("hides one user's files from another", async () => {
      const node = (await h.upload(alice, 'alice-only.txt', patterned(30))).json();
      expect((await h.call('GET', `/files/${node.id}`, bob)).statusCode).toBe(404);
      expect((await h.call('GET', `/files/${node.id}/content`, bob)).statusCode).toBe(404);
      expect((await h.call('DELETE', `/files/${node.id}`, bob)).statusCode).toBe(404);
      expect((await h.call('GET', '/files', bob)).json().items).toEqual([]);
      expect((await h.call('GET', '/files/search?q=alice', bob)).json().items).toEqual([]);
    });
  });
});

describe.skipIf(!url)('pool behaviour over HTTP', () => {
  let h: Harness;
  let owner: Session;

  beforeAll(async () => {
    h = await createHarness(url!);
    owner = await h.login('pool@x.io', true);
  });
  afterAll(() => h.close());

  it('scenario (a): 3 nearly-full accounts still accept a file that only fits when spread across all', async () => {
    // 100 bytes free in each of three accounts; a 300 byte file must be split three ways.
    const accts = [];
    for (let i = 0; i < 3; i++)
      accts.push(await h.linkAccount(owner, { limit: 1500, usage: 1400 }));
    const data = patterned(300, 11);
    const up = await h.upload(owner, 'edge.bin', data);
    expect(up.statusCode).toBe(201);
    const chunks = await h.db.select().from(fileChunks).where(eq(fileChunks.fileId, up.json().id));
    expect(new Set(chunks.map((c) => c.accountId)).size).toBe(3);
    expect(body(await h.call('GET', `/files/${up.json().id}/content`, owner))).toEqual(data);

    const over = await h.upload(owner, 'one-more.bin', patterned(1));
    expect(over.statusCode).toBe(507);
    expect(over.json().code).toBe('insufficient_storage');
  });

  it('scenario (b): a degraded account makes only its own files unavailable, with a clear error', async () => {
    const u = await h.login('degrade@x.io');
    const a = await h.linkAccount(u, { limit: 700 });
    const big = patterned(500, 5);
    const stored = (await h.upload(u, 'on-a.bin', big)).json();
    const b = await h.linkAccount(u, { limit: 100_000 });
    const elsewhere = (await h.upload(u, 'on-b.bin', patterned(50_000, 6))).json();
    const chunkAccounts = async (id: string) =>
      (await h.db.select().from(fileChunks).where(eq(fileChunks.fileId, id))).map(
        (c) => c.accountId,
      );
    expect(await chunkAccounts(stored.id)).toEqual([a.id]);
    expect(await chunkAccounts(elsewhere.id)).toEqual([b.id]);

    a.provider.setDown(true);
    await h.quotaSync.syncOwner(u.id);
    const [row] = await h.db.select().from(storageAccounts).where(eq(storageAccounts.id, a.id));
    expect(row!.status).toBe('DEGRADED');

    // The listing flags exactly the files that cannot be read, so the UI can grey them out.
    const listed = (await h.call('GET', '/files', u)).json().items as Array<{
      id: string;
      unavailable: boolean;
    }>;
    expect(Object.fromEntries(listed.map((i) => [i.id, i.unavailable]))).toMatchObject({
      [stored.id]: true,
      [elsewhere.id]: false,
    });
    expect((await h.call('GET', `/files/${stored.id}`, u)).json().node.unavailable).toBe(true);

    const broken = await h.call('GET', `/files/${stored.id}/content`, u);
    expect(broken.statusCode).toBe(503);
    expect(broken.json()).toMatchObject({ code: 'file_unavailable' });
    expect(broken.json().message).toMatch(/offline/i);
    expect((await h.call('GET', `/files/${elsewhere.id}/content`, u)).statusCode).toBe(200);

    // New uploads avoid the degraded account.
    const fresh = (await h.upload(u, 'new.bin', patterned(100))).json();
    expect(await chunkAccounts(fresh.id)).toEqual([b.id]);

    // Metadata is never deleted: after re-authorising, the file works again.
    a.provider.setDown(false);
    const { url, nonce } = await h.accounts.start(u.id, a.id);
    const link = new URL(url);
    await h.accounts.complete(
      u.id,
      link.searchParams.get('code')!,
      link.searchParams.get('state')!,
      nonce,
    );
    expect(body(await h.call('GET', `/files/${stored.id}/content`, u))).toEqual(big);
  });

  it('refuses uploads when no account is linked', async () => {
    const lonely = await h.login('lonely@x.io');
    const res = await h.upload(lonely, 'x.bin', randomBytes(10));
    expect(res.statusCode).toBe(507);
  });
});

describe.skipIf(!url)('storage usage over HTTP', () => {
  it('reports pooled capacity to everyone without revealing individual accounts', async () => {
    const h = await createHarness(url!, {
      env: { HEADROOM_PERCENT: '10', HEADROOM_MIN_BYTES: '0' },
    });
    try {
      const admin = await h.login('u-admin@x.io', true);
      const member = await h.login('u-member@x.io');
      await h.linkAccount(admin, { limit: 10_000, usage: 1_000 });
      const b = await h.linkAccount(admin, { limit: 20_000, usage: 2_000 });

      for (const who of [admin, member]) {
        const res = await h.call('GET', '/storage/usage', who);
        expect(res.statusCode).toBe(200);
        expect(JSON.stringify(res.json())).not.toMatch(/@|fake-|email/);
      }
      expect((await h.call('GET', '/storage/usage', admin)).json()).toMatchObject({
        limit: 30_000,
        used: 3_000,
        free: 27_000,
        accounts: { total: 2, healthy: 2, degraded: 0 },
        uploadable: 8_000 + 16_000, // free minus 10% headroom, per account
      });
      expect((await h.call('GET', '/storage/usage', member)).json()).toMatchObject({
        limit: 0,
        accounts: { total: 0 },
      });

      b.provider.setDown(true);
      await h.quotaSync.syncOwner(admin.id);
      expect((await h.call('GET', '/storage/usage', admin)).json()).toMatchObject({
        accounts: { total: 2, healthy: 1, degraded: 1 },
        uploadable: 8_000,
      });
    } finally {
      await h.close();
    }
  });
});
