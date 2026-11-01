import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { AppConfig } from '@pooldrive/shared';
import { AccountHealth, AlertsService } from '../alerts/alerts.service.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { providerFactory } from '../accounts/provider-factory.js';
import { ProviderRegistry } from '../accounts/provider-registry.js';
import { AuthService } from '../auth/auth.service.js';
import * as schema from '../db/schema.js';
import { FsService } from '../fs/fs.service.js';
import { CleanupService } from '../storage/cleanup-service.js';
import { KeyRing } from '../storage/crypto.js';
import { OrphanScanner } from '../storage/orphan-scanner.js';
import { PgAccountStore, PgBlobIndex, PgCleanupOutbox } from '../storage/pg-stores.js';
import { QuotaSyncService } from '../storage/quota-sync.js';
import { MaintenanceJobs } from './maintenance.js';

export { JOB_NAMES, schedule, type JobName } from './maintenance.js';

/** Builds the maintenance jobs outside Nest, for the worker process. */
export function createMaintenanceJobs(
  cfg: AppConfig,
  log?: (event: string, data?: Record<string, unknown>) => void,
) {
  const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 5 });
  const db = drizzle(pool, { schema });
  const keyRing = KeyRing.parse(cfg.MASTER_KEYS);
  const accounts = new PgAccountStore(db);
  const alerts = new AlertsService(db);
  const health = new AccountHealth({
    accounts,
    alerts,
    log: (msg, accountId) => log?.(msg, { accountId }),
  });

  // The worker never links accounts, so it needs no OAuth backend.
  const noBackend = {
    authUrl: () => '',
    exchange: () => Promise.reject(new Error('linking is not available in the worker')),
    createAppFolder: () => Promise.reject(new Error('linking is not available in the worker')),
  };
  // eslint-disable-next-line prefer-const -- the registry's loader refers to the service it feeds
  let service: AccountsService;
  const registry = new ProviderRegistry({
    load: (id) => service.credentials(id),
    make: providerFactory(cfg),
  });
  service = new AccountsService({
    db,
    keyRing,
    backend: noBackend,
    registry,
    stateSecret: cfg.SESSION_SECRET,
  });

  const jobs = new MaintenanceJobs({
    db,
    quotaSync: new QuotaSyncService({
      accounts,
      providers: registry.get,
      onDegraded: (accountId, reason) => health.degrade(accountId, reason),
    }),
    cleanup: new CleanupService({ outbox: new PgCleanupOutbox(db), providers: registry.get }),
    fs: new FsService(db),
    auth: new AuthService(db, { sessionSecret: cfg.SESSION_SECRET, sessionTtlMs: 0 }),
    alerts,
    orphans: new OrphanScanner({ accounts, providers: registry.get, index: new PgBlobIndex(db) }),
    retentionDays: cfg.TRASH_RETENTION_DAYS,
    log,
  });
  return { jobs, close: () => pool.end() };
}
