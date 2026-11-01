import { sql } from 'drizzle-orm';
import type { AlertsService } from '../alerts/alerts.service.js';
import type { AuthService } from '../auth/auth.service.js';
import type { Db } from '../db/db.module.js';
import { storageAccounts } from '../db/schema.js';
import type { FsService } from '../fs/fs.service.js';
import type { CleanupService } from '../storage/cleanup-service.js';
import type { OrphanScanner } from '../storage/orphan-scanner.js';
import type { QuotaSyncService } from '../storage/quota-sync.js';

export const JOB_NAMES = [
  'quota-sync',
  'cleanup',
  'trash-purge',
  'session-purge',
  'orphan-scan',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Per-job schedule in seconds. Quota sync follows QUOTA_SYNC_INTERVAL_SECONDS. */
export function schedule(quotaSyncSeconds: number): Record<JobName, number> {
  return {
    'quota-sync': quotaSyncSeconds,
    cleanup: 60,
    'trash-purge': 3600,
    'session-purge': 3600,
    'orphan-scan': 24 * 3600,
  };
}

/** The periodic work, as plain methods so the worker, tests and an admin "run now" can all call it. */
export class MaintenanceJobs {
  constructor(
    private readonly deps: {
      db: Db;
      quotaSync: QuotaSyncService;
      cleanup: CleanupService;
      fs: FsService;
      auth: Pick<AuthService, 'purgeExpired'>;
      alerts: AlertsService;
      orphans: OrphanScanner;
      retentionDays: number;
      log?: (event: string, data?: Record<string, unknown>) => void;
    },
  ) {}

  run(name: JobName): Promise<unknown> {
    switch (name) {
      case 'quota-sync':
        return this.quotaSync();
      case 'cleanup':
        return this.deps.cleanup.run();
      case 'trash-purge':
        return this.deps.fs.purgeExpired(this.deps.retentionDays);
      case 'session-purge':
        return this.deps.auth.purgeExpired();
      case 'orphan-scan':
        return this.orphanScan();
    }
  }

  /** One failing owner or account must not stop the others. */
  async quotaSync(): Promise<number> {
    const owners = await this.owners();
    for (const ownerId of owners) {
      try {
        await this.deps.quotaSync.syncOwner(ownerId);
      } catch (err) {
        this.deps.log?.('quota sync failed', { ownerId, err: String(err) });
      }
    }
    return owners.length;
  }

  /**
   * Compare Drive with the database and raise an alert when they disagree. It reports only;
   * deleting "orphans" automatically could destroy data on a wrong guess.
   */
  async orphanScan() {
    const totals = { orphans: 0, missing: 0 };
    for (const ownerId of await this.owners()) {
      const report = await this.deps.orphans.scan(ownerId);
      totals.orphans += report.orphanCount;
      totals.missing += report.missingCount;
      if (report.orphanCount > 0) {
        await this.deps.alerts.raise(
          ownerId,
          null,
          'orphan_blobs',
          `${report.orphanCount} unreferenced blob(s) (${report.orphanBytes} bytes) were found in your Drive accounts. Nothing was deleted; see the runbook before removing them.`,
        );
      } else {
        await this.deps.alerts.resolveKind(ownerId, 'orphan_blobs');
      }
      if (report.missingCount > 0) {
        await this.deps.alerts.raise(
          ownerId,
          null,
          'missing_blobs',
          `${report.missingCount} stored chunk(s) are missing from Drive. The affected files cannot be downloaded.`,
        );
      } else {
        await this.deps.alerts.resolveKind(ownerId, 'missing_blobs');
      }
    }
    this.deps.log?.('orphan scan finished', totals);
    return totals;
  }

  private async owners(): Promise<string[]> {
    const rows = await this.deps.db
      .selectDistinct({ ownerId: storageAccounts.ownerId })
      .from(storageAccounts)
      .where(sql`${storageAccounts.status} <> 'DISCONNECTED'`);
    return rows.map((r) => r.ownerId);
  }
}
