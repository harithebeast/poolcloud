import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@pooldrive/shared';
import { AuthController } from '../auth/auth.controller.js';
import { AuthGuard, SESSION_COOKIE } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { LoginThrottle, MemoryCounterStore } from '../auth/throttle.js';
import { APP_CONFIG } from '../config/config.module.js';
import { storageAccounts } from '../db/schema.js';
import { KeyRing } from '../storage/crypto.js';
import { FakeProvider } from '../storage/fake-provider.js';
import { createTestDb } from '../testing/test-db.js';
import { AccountsController } from './accounts.controller.js';
import { RemovalService } from './removal.service.js';
import { AccountsService } from './accounts.service.js';
import { FakeLinkBackend } from './link-backend.js';
import { ProviderRegistry } from './provider-registry.js';

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-long-enough-passphrase';

describe.skipIf(!url)('linking storage accounts over HTTP', () => {
  const cfg = loadConfig({
    DATABASE_URL: url ?? 'postgres://x',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 's'.repeat(40),
    MASTER_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
    WEB_ORIGIN: 'http://localhost:3000',
    STORAGE_PROVIDER: 'fake',
  });
  const keyRing = KeyRing.parse(cfg.MASTER_KEYS);
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let app: NestFastifyApplication;
  let accounts: AccountsService;
  let fakes: Map<string, FakeProvider>;
  let n = 0;

  let admin = { cookie: '', csrf: '', id: '' };
  let member = { cookie: '', csrf: '' };

  beforeAll(async () => {
    testDb = await createTestDb(url!);
    const auth = new AuthService(testDb.db, {
      sessionSecret: cfg.SESSION_SECRET,
      sessionTtlMs: 600_000,
    });
    fakes = new Map();
    const registry = new ProviderRegistry({
      load: (id) => accounts.credentials(id),
      make: (c) => {
        const f =
          fakes.get(c.accountId) ?? new FakeProvider({ limit: 15_000, initialUsage: 2_000 });
        fakes.set(c.accountId, f);
        return f;
      },
    });
    accounts = new AccountsService({
      db: testDb.db,
      keyRing,
      backend: new FakeLinkBackend('http://localhost:4000/api/v1/accounts/google/callback'),
      registry,
      stateSecret: cfg.SESSION_SECRET,
    });
    const mod = await Test.createTestingModule({
      controllers: [AuthController, AccountsController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: AccountsService, useValue: accounts },
        { provide: RemovalService, useValue: {} }, // removal has its own tests
        { provide: LoginThrottle, useValue: new LoginThrottle(new MemoryCounterStore(), 100, 60) },
        { provide: APP_CONFIG, useValue: cfg },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    const a = await auth.setup('admin@x.io', PASSWORD);
    await auth.createUser('member@x.io', PASSWORD);
    const al = await auth.login('admin@x.io', PASSWORD);
    const ml = await auth.login('member@x.io', PASSWORD);
    admin = { cookie: al!.token, csrf: al!.info.csrfToken, id: a.id };
    member = { cookie: ml!.token, csrf: ml!.info.csrfToken };
  });
  afterAll(async () => {
    await app.close();
    await testDb.drop();
  });

  const call = (
    method: 'GET' | 'POST',
    path: string,
    who: { cookie: string; csrf?: string },
    extra: { body?: object; oauth?: string } = {},
  ) =>
    app.inject({
      remoteAddress: `10.1.0.${++n % 250}`,
      method,
      url: path,
      payload: extra.body,
      headers: {
        cookie:
          `${SESSION_COOKIE}=${who.cookie}` + (extra.oauth ? `; pd_oauth=${extra.oauth}` : ''),
        ...(who.csrf && method === 'POST' ? { 'x-csrf-token': who.csrf } : {}),
      },
    });

  /** The test app has no /api/v1 global prefix. */
  const local = (u: URL) => `${u.pathname.replace('/api/v1', '')}${u.search}`;

  /** Run the whole browser round trip and return the callback response. */
  async function link(who = admin, body: object = {}) {
    const start = await call('POST', '/accounts/google/start', who, { body });
    expect(start.statusCode).toBe(201);
    const nonce = start.cookies.find((c) => c.name === 'pd_oauth')!.value;
    const consent = new URL(start.json().url as string);
    const cb = await call('GET', local(consent), who, { oauth: nonce });
    return { cb, nonce, consent };
  }
  const outcome = (cb: Awaited<ReturnType<typeof link>>['cb']) =>
    new URL(cb.headers.location as string);

  it('links an account: redirects to the web app, stores the token encrypted, reads the quota', async () => {
    const { cb } = await link();
    expect(cb.statusCode).toBe(302);
    const dest = outcome(cb);
    expect(dest.origin + dest.pathname).toBe('http://localhost:3000/storage');
    const email = dest.searchParams.get('linked')!;
    expect(email).toMatch(/@pool\.local$/);

    const [row] = await testDb.db
      .select()
      .from(storageAccounts)
      .where(eq(storageAccounts.email, email));
    expect(row).toMatchObject({ status: 'HEALTHY', quotaLimit: 15_000, quotaUsage: 2_000 });
    expect(row!.appFolderId).toMatch(/^fake-folder-/);
    expect(row!.refreshTokenEnc).not.toContain('fake-refresh');
    expect(keyRing.openSecret(row!.refreshTokenEnc, `account:${admin.id}:${row!.googleSub}`)).toBe(
      `fake-refresh:${email}`,
    );
    expect((await accounts.credentials(row!.id))?.refreshToken).toBe(`fake-refresh:${email}`);

    const list = await call('GET', '/accounts', admin);
    expect(list.json()).toHaveLength(1);
    expect(JSON.stringify(list.json())).not.toMatch(/refresh|token/i);
  });

  it('re-authorising a DEGRADED account restores it instead of creating a duplicate', async () => {
    const [row] = await testDb.db.select().from(storageAccounts);
    await testDb.db
      .update(storageAccounts)
      .set({ status: 'DEGRADED', lastError: 'token revoked', consecutiveErrors: 3 })
      .where(eq(storageAccounts.id, row!.id));

    const { cb } = await link(admin, { accountId: row!.id });
    expect(outcome(cb).searchParams.get('linked')).toBe(row!.email);
    const all = await testDb.db.select().from(storageAccounts);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ status: 'HEALTHY', lastError: null, consecutiveErrors: 0 });
  });

  it('refuses to re-authorise with a different Google account', async () => {
    const [row] = await testDb.db.select().from(storageAccounts);
    const start = await call('POST', '/accounts/google/start', admin, {
      body: { accountId: row!.id },
    });
    const nonce = start.cookies.find((c) => c.name === 'pd_oauth')!.value;
    const consent = new URL(start.json().url as string);
    const state = consent.searchParams.get('state')!;
    const cb = await call(
      'GET',
      `/accounts/google/callback?code=${encodeURIComponent('fake:someone-else@pool.local')}&state=${state}`,
      admin,
      { oauth: nonce },
    );
    expect(outcome(cb).searchParams.get('linkError')).toMatch(/different account/);
    expect(await testDb.db.select().from(storageAccounts)).toHaveLength(1);
  });

  it('rejects a callback without the browser-bound cookie, or with a forged or foreign state', async () => {
    const start = await call('POST', '/accounts/google/start', admin);
    const consent = new URL(start.json().url as string);
    const nonce = start.cookies.find((c) => c.name === 'pd_oauth')!.value;
    const path = local(consent);

    expect(outcome(await call('GET', path, admin)).searchParams.get('linkError')).toMatch(
      /invalid/i,
    );
    expect(
      outcome(await call('GET', path, admin, { oauth: 'wrong-nonce' })).searchParams.get(
        'linkError',
      ),
    ).toMatch(/invalid/i);
    expect(
      outcome(
        await call('GET', '/accounts/google/callback?code=fake:x@y.z&state=forged.state', admin, {
          oauth: nonce,
        }),
      ).searchParams.get('linkError'),
    ).toMatch(/invalid/i);
    // A state minted for the admin is useless to another user.
    const other = await call('GET', path, { cookie: member.cookie }, { oauth: nonce });
    expect(other.statusCode).toBe(403); // members cannot manage accounts at all
    expect(await testDb.db.select().from(storageAccounts)).toHaveLength(1);
  });

  it('handles the user cancelling on Google and an unconfigured request', async () => {
    const denied = await call('GET', '/accounts/google/callback?error=access_denied', admin);
    expect(outcome(denied).searchParams.get('linkError')).toMatch(/cancelled|denied/);
    const empty = await call('GET', '/accounts/google/callback', admin);
    expect(outcome(empty).searchParams.get('linkError')).toMatch(/Missing/);
  });

  it('is admin-only and requires CSRF for starting a link', async () => {
    expect((await call('GET', '/accounts', member)).statusCode).toBe(403);
    expect((await call('POST', '/accounts/google/start', member)).statusCode).toBe(403);
    expect(
      (await call('POST', '/accounts/google/start', { cookie: admin.cookie })).statusCode,
    ).toBe(403);
    const bad = await call('POST', '/accounts/google/start', admin, {
      body: { accountId: 'nope' },
    });
    expect(bad.statusCode).toBe(400);
  });
});
