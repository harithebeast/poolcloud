import 'reflect-metadata';
import fastifyCookie from '@fastify/cookie';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { loadConfig } from '@pooldrive/shared';
import { AccountsController } from '../accounts/accounts.controller.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { FakeLinkBackend } from '../accounts/link-backend.js';
import { ProviderRegistry } from '../accounts/provider-registry.js';
import { AuthController } from '../auth/auth.controller.js';
import { AuthGuard, SESSION_COOKIE } from '../auth/auth.guard.js';
import { AuthService } from '../auth/auth.service.js';
import { LoginThrottle, MemoryCounterStore } from '../auth/throttle.js';
import { DomainErrorsFilter } from '../common/domain-errors.filter.js';
import { registerStreamParsers } from '../common/stream-parser.js';
import { APP_CONFIG } from '../config/config.module.js';
import { FilesController } from '../files/files.controller.js';
import { FilesService } from '../files/files.service.js';
import { FsService } from '../fs/fs.service.js';
import { CleanupService } from '../storage/cleanup-service.js';
import { KeyRing } from '../storage/crypto.js';
import { DownloadService } from '../storage/download-service.js';
import { FakeProvider } from '../storage/fake-provider.js';
import { PgAccountStore, PgCleanupOutbox } from '../storage/pg-stores.js';
import { QuotaSyncService } from '../storage/quota-sync.js';
import { UploadService, type StorageSettings } from '../storage/upload-service.js';
import { createTestDb } from './test-db.js';

export const PASSWORD = 'a-long-enough-passphrase';

export interface HarnessOptions {
  /** Storage settings; tests use tiny chunk sizes so files split. */
  settings?: Partial<StorageSettings>;
}

export interface Session {
  cookie: string;
  csrf: string;
  id: string;
}

/**
 * The real controllers, services and Postgres, wired like production but with the fake link backend
 * and in-memory providers. Each harness gets its own database.
 */
export async function createHarness(baseUrl: string, options: HarnessOptions = {}) {
  const testDb = await createTestDb(baseUrl);
  const cfg = loadConfig({
    DATABASE_URL: baseUrl,
    REDIS_URL: 'redis://localhost:6379',
    SESSION_SECRET: 's'.repeat(40),
    MASTER_KEYS: `k1:${Buffer.alloc(32, 7).toString('base64')}`,
    WEB_ORIGIN: 'http://localhost:3000',
    STORAGE_PROVIDER: 'fake',
  });
  const keyRing = KeyRing.parse(cfg.MASTER_KEYS);
  const settings: StorageSettings = {
    chunkSize: 400,
    headroom: { percent: 0, minBytes: 0 },
    reservationTtlMs: 60_000,
    cleanupGraceMs: 0,
    ...options.settings,
  };

  const providers = new Map<string, FakeProvider>();
  const nextAccounts: Array<{ limit: number; usage: number }> = [];
  const registry = new ProviderRegistry({
    load: (id) => accounts.credentials(id),
    make: (c) => {
      let p = providers.get(c.accountId);
      if (!p) {
        const spec = nextAccounts.shift() ?? { limit: 1_000_000, usage: 0 };
        p = new FakeProvider({ limit: spec.limit, initialUsage: spec.usage });
        providers.set(c.accountId, p);
      }
      return p;
    },
  });
  const accounts: AccountsService = new AccountsService({
    db: testDb.db,
    keyRing,
    backend: new FakeLinkBackend('http://localhost:4000/api/v1/accounts/google/callback'),
    registry,
    stateSecret: cfg.SESSION_SECRET,
  });
  const auth = new AuthService(testDb.db, {
    sessionSecret: cfg.SESSION_SECRET,
    sessionTtlMs: 3_600_000,
  });
  const store = new PgAccountStore(testDb.db);
  const outbox = new PgCleanupOutbox(testDb.db);
  const fs = new FsService(testDb.db);
  const uploads = new UploadService({
    accounts: store,
    outbox,
    providers: registry.get,
    keyRing,
    settings,
  });
  const downloads = new DownloadService({ accounts: store, providers: registry.get, keyRing });
  const files = new FilesService({ db: testDb.db, fs, uploads, downloads });
  const cleanup = new CleanupService({ outbox, providers: registry.get });
  const quotaSync = new QuotaSyncService({ accounts: store, providers: registry.get });

  const mod = await Test.createTestingModule({
    controllers: [AuthController, AccountsController, FilesController],
    providers: [
      { provide: AuthService, useValue: auth },
      { provide: AccountsService, useValue: accounts },
      { provide: FsService, useValue: fs },
      { provide: FilesService, useValue: files },
      { provide: LoginThrottle, useValue: new LoginThrottle(new MemoryCounterStore(), 1000, 60) },
      { provide: APP_CONFIG, useValue: cfg },
      { provide: APP_GUARD, useClass: AuthGuard },
      { provide: APP_FILTER, useClass: DomainErrorsFilter },
    ],
  }).compile();
  const app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await app.register(fastifyCookie);
  registerStreamParsers(app.getHttpAdapter().getInstance());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  let n = 0;
  async function login(email: string, firstUser = false): Promise<Session> {
    if (firstUser) await auth.setup(email, PASSWORD);
    else await auth.createUser(email, PASSWORD);
    const s = await auth.login(email, PASSWORD);
    return { cookie: s!.token, csrf: s!.info.csrfToken, id: s!.info.user.id };
  }

  /** Link a fake account through the real OAuth state machine. `spec` sizes its fake Drive. */
  async function linkAccount(owner: Session, spec: { limit: number; usage?: number }) {
    nextAccounts.push({ limit: spec.limit, usage: spec.usage ?? 0 });
    const { url, nonce } = await accounts.start(owner.id);
    const u = new URL(url);
    const done = await accounts.complete(
      owner.id,
      u.searchParams.get('code')!,
      u.searchParams.get('state')!,
      nonce,
    );
    return { ...done, provider: providers.get(done.id)! };
  }

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    who?: Session,
    opts: { body?: unknown; headers?: Record<string, string>; payload?: Buffer } = {},
  ) =>
    app.inject({
      remoteAddress: `10.9.${Math.floor(++n / 250)}.${n % 250}`,
      method,
      url: path,
      payload: (opts.payload ?? opts.body) as never,
      headers: {
        ...(who ? { cookie: `${SESSION_COOKIE}=${who.cookie}` } : {}),
        ...(who && method !== 'GET' ? { 'x-csrf-token': who.csrf } : {}),
        ...opts.headers,
      },
    });

  const upload = (
    who: Session,
    name: string,
    data: Buffer,
    extra: { key?: string; parentId?: string; encrypt?: boolean } = {},
  ) => {
    const q = new URLSearchParams({ name });
    if (extra.parentId) q.set('parentId', extra.parentId);
    if (extra.encrypt !== undefined) q.set('encrypt', String(extra.encrypt));
    return call('POST', `/files/upload?${q}`, who, {
      payload: data,
      headers: {
        'content-type': 'application/octet-stream',
        'idempotency-key': extra.key ?? `key-${name}-${Math.random().toString(36).slice(2, 10)}`,
      },
    });
  };

  return {
    app,
    db: testDb.db,
    cfg,
    keyRing,
    auth,
    accounts,
    fs,
    files,
    uploads,
    cleanup,
    quotaSync,
    store,
    providers,
    login,
    linkAccount,
    call,
    upload,
    blobCount: () => [...providers.values()].reduce((s, p) => s + p.blobCount, 0),
    async close() {
      await app.close();
      await testDb.drop();
    },
  };
}

export type Harness = Awaited<ReturnType<typeof createHarness>>;
