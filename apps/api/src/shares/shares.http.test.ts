import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../auth/tokens.js';
import { shareLinks } from '../db/schema.js';
import { patterned } from '../storage/testing/harness.js';
import { createHarness, type Harness, type Session } from '../testing/http-harness.js';

const url = process.env.TEST_DATABASE_URL;
const body = (res: { rawPayload: Buffer }) => res.rawPayload;

describe.skipIf(!url)('share links over HTTP', () => {
  let h: Harness;
  let owner: Session;
  let other: Session;
  let fileId: string;
  const data = patterned(1200, 9);

  beforeAll(async () => {
    h = await createHarness(url!);
    owner = await h.login('owner@x.io', true);
    other = await h.login('other@x.io');
    await h.linkAccount(owner, { limit: 100_000 });
    fileId = (await h.upload(owner, 'shared.txt', data)).json().id;
  });
  afterAll(() => h.close());

  const tokenOf = (shareUrl: string) => new URL(shareUrl).pathname.replace('/s/', '');
  const create = async (payload: object = {}, who = owner) =>
    h.call('POST', '/shares', who, { body: { nodeId: fileId, ...payload } });

  it('creates a link whose token is shown once and stored only as a hash', async () => {
    const res = await create();
    expect(res.statusCode).toBe(201);
    const share = res.json();
    expect(share.url).toMatch(/^http:\/\/localhost:3000\/s\/[\w-]{43}$/);
    const token = tokenOf(share.url);

    const [row] = await h.db.select().from(shareLinks).where(eq(shareLinks.id, share.id));
    expect(row!.tokenHash).toBe(hashToken(token));
    expect(JSON.stringify(row)).not.toContain(token);

    const list = (await h.call('GET', `/shares?nodeId=${fileId}`, owner)).json();
    expect(JSON.stringify(list)).not.toContain(token);
    expect(list.items[0]).toMatchObject({
      id: share.id,
      passwordProtected: false,
      downloadCount: 0,
    });
  });

  it('lets anyone with the link download, without a session, and counts downloads', async () => {
    const { url: shareUrl, id } = (await create()).json();
    const token = tokenOf(shareUrl);

    const info = await h.call('GET', `/public/shares/${token}`);
    expect(info.json()).toMatchObject({ name: 'shared.txt', size: 1200, passwordProtected: false });
    expect(JSON.stringify(info.json())).not.toMatch(/account|owner|remote/i);

    const dl = await h.call('GET', `/public/shares/${token}/content`);
    expect(dl.statusCode).toBe(200);
    expect(body(dl)).toEqual(data);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
    await h.call('GET', `/public/shares/${token}/content?download=1`);

    const part = await h.call('GET', `/public/shares/${token}/content`, undefined, {
      headers: { range: 'bytes=10-19' },
    });
    expect(part.statusCode).toBe(206);
    expect(body(part)).toEqual(data.subarray(10, 20));

    const [row] = await h.db.select().from(shareLinks).where(eq(shareLinks.id, id));
    expect(row!.downloadCount).toBe(2); // the mid-file range request is not a new download
  });

  it('protects links with a password and issues a short-lived access token', async () => {
    const token = tokenOf((await create({ password: 'open-sesame' })).json().url);
    expect((await h.call('GET', `/public/shares/${token}`)).json().passwordProtected).toBe(true);
    expect((await h.call('GET', `/public/shares/${token}/content`)).statusCode).toBe(401);

    const wrong = await h.call('POST', `/public/shares/${token}/unlock`, undefined, {
      body: { password: 'nope' },
    });
    expect(wrong.statusCode).toBe(401);

    const ok = await h.call('POST', `/public/shares/${token}/unlock`, undefined, {
      body: { password: 'open-sesame' },
    });
    expect(ok.statusCode).toBe(200);
    const access = ok.json().access as string;
    const dl = await h.call('GET', `/public/shares/${token}/content?access=${access}`);
    expect(body(dl)).toEqual(data);

    // The access token works for this link only, and cannot be forged or altered.
    const otherToken = tokenOf((await create({ password: 'another-pass' })).json().url);
    expect(
      (await h.call('GET', `/public/shares/${otherToken}/content?access=${access}`)).statusCode,
    ).toBe(401);
    const forged = access.replace(/^\d+/, String(Date.now() + 9e9));
    expect(
      (await h.call('GET', `/public/shares/${token}/content?access=${forged}`)).statusCode,
    ).toBe(401);
  });

  it('honours expiry', async () => {
    const soon = new Date(Date.now() + 60_000).toISOString();
    const share = (await create({ expiresAt: soon })).json();
    const token = tokenOf(share.url);
    expect((await h.call('GET', `/public/shares/${token}/content`)).statusCode).toBe(200);
    await h.db
      .update(shareLinks)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(shareLinks.id, share.id));
    expect((await h.call('GET', `/public/shares/${token}`)).statusCode).toBe(404);
    expect((await h.call('GET', `/public/shares/${token}/content`)).statusCode).toBe(404);

    const past = await create({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect(past.statusCode).toBe(400);
  });

  it('revocation takes effect immediately and only for the owner', async () => {
    const share = (await create()).json();
    const token = tokenOf(share.url);
    expect((await h.call('DELETE', `/shares/${share.id}`, other)).statusCode).toBe(404);
    expect((await h.call('GET', `/public/shares/${token}/content`)).statusCode).toBe(200);
    expect((await h.call('DELETE', `/shares/${share.id}`, owner)).statusCode).toBe(204);
    expect((await h.call('GET', `/public/shares/${token}/content`)).statusCode).toBe(404);
    expect((await h.call('DELETE', `/shares/${share.id}`, owner)).statusCode).toBe(404);
  });

  it('answers unknown, malformed and revoked tokens identically', async () => {
    const share = (await create()).json();
    await h.call('DELETE', `/shares/${share.id}`, owner);
    const bodies = new Set<string>();
    for (const t of ['x'.repeat(43), 'short', tokenOf(share.url)]) {
      const res = await h.call('GET', `/public/shares/${t}`);
      expect(res.statusCode).toBe(404);
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
  });

  it("stops serving when the file is trashed, and cannot share someone else's file", async () => {
    const other2 = (await h.upload(owner, 'will-trash.txt', patterned(40))).json();
    const share = (await h.call('POST', '/shares', owner, { body: { nodeId: other2.id } })).json();
    const token = tokenOf(share.url);
    await h.call('DELETE', `/files/${other2.id}`, owner);
    expect((await h.call('GET', `/public/shares/${token}/content`)).statusCode).toBe(404);
    await h.call('POST', `/trash/${other2.id}/restore`, owner);
    expect((await h.call('GET', `/public/shares/${token}/content`)).statusCode).toBe(200);

    expect((await create({}, other)).statusCode).toBe(404);
    const folder = (await h.call('POST', '/folders', owner, { body: { name: 'dir' } })).json();
    const nope = await h.call('POST', '/shares', owner, { body: { nodeId: folder.id } });
    expect(nope.statusCode).toBe(404); // v1 shares files only
  });

  it('reports an offline account as 503 rather than a broken download', async () => {
    const u = await h.login('offline@x.io');
    const acct = await h.linkAccount(u, { limit: 10_000 });
    const f = (await h.upload(u, 'offline.txt', patterned(100))).json();
    const token = tokenOf(
      (await h.call('POST', '/shares', u, { body: { nodeId: f.id } })).json().url,
    );
    acct.provider.setDown(true);
    await h.quotaSync.syncOwner(u.id);
    const res = await h.call('GET', `/public/shares/${token}/content`);
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe('file_unavailable');
  });
});

describe.skipIf(!url)('share password throttling', () => {
  it('stops password guessing with 429 after a few wrong attempts', async () => {
    const h = await createHarness(url!, { throttleMax: 5 });
    try {
      const owner = await h.login('t@x.io', true);
      await h.linkAccount(owner, { limit: 10_000 });
      const f = (await h.upload(owner, 'a.txt', patterned(10))).json();
      const { url: shareUrl } = (
        await h.call('POST', '/shares', owner, { body: { nodeId: f.id, password: 'guard-me-123' } })
      ).json();
      const token = new URL(shareUrl).pathname.replace('/s/', '');
      const codes: number[] = [];
      for (let i = 0; i < 7; i++) {
        const res = await h.app.inject({
          method: 'POST',
          url: `/public/shares/${token}/unlock`,
          remoteAddress: '203.0.113.9',
          payload: { password: `guess-${i}` },
        });
        codes.push(res.statusCode);
      }
      expect(codes).toEqual([401, 401, 401, 401, 401, 429, 429]);
    } finally {
      await h.close();
    }
  });
});
