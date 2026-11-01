import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@pooldrive/shared';
import { APP_CONFIG } from '../config/config.module.js';
import * as schema from '../db/schema.js';
import { sessions } from '../db/schema.js';
import { createTestDb } from '../testing/test-db.js';
import { AuthController } from './auth.controller.js';
import { AuthGuard, SESSION_COOKIE } from './auth.guard.js';
import { AuthService } from './auth.service.js';
import { LoginThrottle, MemoryCounterStore } from './throttle.js';

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = 'a-long-enough-passphrase';

describe.skipIf(!url)('auth over HTTP', () => {
  let testDb: Awaited<ReturnType<typeof createTestDb>>;
  let db: typeof testDb.db;
  const cfg = loadConfig({
    DATABASE_URL: url ?? 'postgres://x',
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 's'.repeat(40),
    MASTER_KEYS: `k1:${Buffer.alloc(32, 1).toString('base64')}`,
    WEB_ORIGIN: 'http://localhost:3000',
  });
  let app: NestFastifyApplication;
  let auth: AuthService;
  let clock = Date.now();
  let calls = 0;

  beforeAll(async () => {
    testDb = await createTestDb(url!);
    db = testDb.db;
    auth = new AuthService(
      db,
      { sessionSecret: cfg.SESSION_SECRET, sessionTtlMs: 60_000 },
      () => clock,
    );
    const mod = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        { provide: AuthService, useValue: auth },
        { provide: LoginThrottle, useValue: new LoginThrottle(new MemoryCounterStore(), 5, 60) },
        { provide: APP_CONFIG, useValue: cfg },
        { provide: APP_GUARD, useClass: AuthGuard },
      ],
    }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.register(fastifyCookie);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterAll(async () => {
    await app.close();
    await testDb.drop();
  });

  const call = (
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; cookie?: string; csrf?: string; origin?: string } = {},
  ) =>
    app.inject({
      remoteAddress: `10.0.${Math.floor(++calls / 250)}.${calls % 250}`,
      method,
      url: path,
      payload: opts.body as object | undefined,
      headers: {
        ...(opts.cookie ? { cookie: `${SESSION_COOKIE}=${opts.cookie}` } : {}),
        ...(opts.csrf ? { 'x-csrf-token': opts.csrf } : {}),
        ...(opts.origin ? { origin: opts.origin } : {}),
      },
    });
  const sid = (res: Awaited<ReturnType<typeof call>>) =>
    res.cookies.find((c) => c.name === SESSION_COOKIE)?.value ?? '';

  let cookie = '';
  let csrf = '';

  it('requires first-run setup, then creates the admin and logs them in', async () => {
    expect((await call('GET', '/auth/status')).json()).toEqual({ setupRequired: true });
    const weak = await call('POST', '/auth/setup', {
      body: { email: 'a@b.io', password: 'short' },
    });
    expect(weak.statusCode).toBe(400);

    const res = await call('POST', '/auth/setup', {
      body: { email: 'Admin@Example.com', password: PASSWORD },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({ email: 'admin@example.com', role: 'admin' });
    const set = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
    expect(set).toMatchObject({ httpOnly: true, sameSite: 'Lax', path: '/' });
    cookie = set.value;
    csrf = res.json().csrfToken;
    expect((await call('GET', '/auth/status')).json()).toEqual({ setupRequired: false });
  });

  it('closes setup after the first user, even for concurrent attempts', async () => {
    const again = await call('POST', '/auth/setup', {
      body: { email: 'x@y.io', password: PASSWORD },
    });
    expect(again.statusCode).toBe(409);
  });

  it('only one of two concurrent first-run requests wins', async () => {
    await db.delete(sessions);
    await db.delete(schema.users);
    const [a, b] = await Promise.all(
      ['one', 'two'].map((n) =>
        call('POST', '/auth/setup', { body: { email: `${n}@x.io`, password: PASSWORD } }),
      ),
    );
    expect([a!.statusCode, b!.statusCode].sort()).toEqual([201, 409]);
    const login = await call('POST', '/auth/login', {
      body: { email: a!.statusCode === 201 ? 'one@x.io' : 'two@x.io', password: PASSWORD },
    });
    cookie = sid(login);
    csrf = login.json().csrfToken;
  });

  it('rejects unauthenticated requests by default', async () => {
    expect((await call('GET', '/auth/me')).statusCode).toBe(401);
    expect((await call('GET', '/auth/me', { cookie: 'nonsense' })).statusCode).toBe(401);
  });

  it('returns the user and a CSRF token for a valid session', async () => {
    const me = await call('GET', '/auth/me', { cookie });
    expect(me.statusCode).toBe(200);
    expect(me.json().csrfToken).toBe(csrf);
  });

  it('enforces CSRF token and origin on state-changing requests', async () => {
    const body = { email: 'u@x.io', password: PASSWORD };
    expect((await call('POST', '/auth/users', { cookie, body })).statusCode).toBe(403);
    expect((await call('POST', '/auth/users', { cookie, body, csrf: 'forged' })).statusCode).toBe(
      403,
    );
    expect(
      (await call('POST', '/auth/users', { cookie, body, csrf, origin: 'http://evil.test' }))
        .statusCode,
    ).toBe(403);
    const ok = await call('POST', '/auth/users', {
      cookie,
      body,
      csrf,
      origin: 'http://localhost:3000',
    });
    expect(ok.statusCode).toBe(201);
    expect((await call('POST', '/auth/users', { cookie, body, csrf })).statusCode).toBe(409);
  });

  it('rejects bad credentials identically for unknown and known emails', async () => {
    const unknown = await call('POST', '/auth/login', {
      body: { email: 'nobody@x.io', password: PASSWORD },
    });
    const wrong = await call('POST', '/auth/login', {
      body: { email: 'u@x.io', password: 'wrong-wrong-wrong' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.json().message).toBe(wrong.json().message);
  });

  it('keeps ordinary users out of admin routes', async () => {
    const login = await call('POST', '/auth/login', {
      body: { email: 'u@x.io', password: PASSWORD },
    });
    const res = await call('POST', '/auth/users', {
      cookie: sid(login),
      csrf: login.json().csrfToken,
      body: { email: 'z@x.io', password: PASSWORD },
    });
    expect(res.statusCode).toBe(403);
  });

  it('throttles repeated failed logins with 429', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push(
        (
          await call('POST', '/auth/login', {
            body: { email: 'victim@x.io', password: 'bad-bad-bad-bad' },
          })
        ).statusCode,
      );
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes.slice(5)).toEqual([429, 429]);
  });

  it('expires sessions and deletes them on logout', async () => {
    const login = await call('POST', '/auth/login', {
      body: { email: 'u@x.io', password: PASSWORD },
    });
    const c = sid(login);
    const t = login.json().csrfToken as string;
    expect((await call('GET', '/auth/me', { cookie: c })).statusCode).toBe(200);
    expect((await call('POST', '/auth/logout', { cookie: c, csrf: t })).statusCode).toBe(204);
    expect((await call('GET', '/auth/me', { cookie: c })).statusCode).toBe(401);

    const again = await call('POST', '/auth/login', {
      body: { email: 'u@x.io', password: PASSWORD },
    });
    clock += 61_000;
    expect((await call('GET', '/auth/me', { cookie: sid(again) })).statusCode).toBe(401);
    await auth.purgeExpired();
    expect(await db.select().from(sessions)).toHaveLength(0); // every session was past its 60s TTL
  });
});
