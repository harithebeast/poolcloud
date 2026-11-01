import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';
import { alerts, storageAccounts } from '../db/schema.js';
import type { AccountStore } from '../storage/stores.js';

export type AlertRow = typeof alerts.$inferSelect;

export class AlertsService {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Raise an alert unless an identical one is still open (so a flapping account does not spam). */
  async raise(ownerId: string, accountId: string | null, kind: string, message: string) {
    const [open] = await this.db
      .select({ id: alerts.id })
      .from(alerts)
      .where(
        and(
          eq(alerts.ownerId, ownerId),
          eq(alerts.kind, kind),
          isNull(alerts.resolvedAt),
          accountId ? eq(alerts.accountId, accountId) : isNull(alerts.accountId),
        ),
      );
    if (open) {
      await this.db.update(alerts).set({ message }).where(eq(alerts.id, open.id));
      return open.id;
    }
    const [row] = await this.db
      .insert(alerts)
      .values({ ownerId, accountId, kind, message })
      .returning({ id: alerts.id });
    return row!.id;
  }

  async raiseForAccount(accountId: string, kind: string, message: string): Promise<void> {
    const [a] = await this.db
      .select({ ownerId: storageAccounts.ownerId })
      .from(storageAccounts)
      .where(eq(storageAccounts.id, accountId));
    if (a) await this.raise(a.ownerId, accountId, kind, message);
  }

  async resolveKind(ownerId: string, kind: string): Promise<void> {
    await this.db
      .update(alerts)
      .set({ resolvedAt: this.now() })
      .where(and(eq(alerts.ownerId, ownerId), eq(alerts.kind, kind), isNull(alerts.resolvedAt)));
  }

  list(ownerId: string, openOnly = true): Promise<AlertRow[]> {
    return this.db
      .select()
      .from(alerts)
      .where(and(eq(alerts.ownerId, ownerId), openOnly ? isNull(alerts.resolvedAt) : undefined))
      .orderBy(desc(alerts.createdAt))
      .limit(100);
  }

  async dismiss(ownerId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .update(alerts)
      .set({ resolvedAt: this.now() })
      .where(and(eq(alerts.id, id), eq(alerts.ownerId, ownerId), isNull(alerts.resolvedAt)))
      .returning({ id: alerts.id });
    return rows.length > 0;
  }
}

/** Takes a failing account out of rotation and tells the owner. Never deletes any metadata. */
export class AccountHealth {
  constructor(
    private readonly deps: {
      accounts: AccountStore;
      alerts: Pick<AlertsService, 'raiseForAccount'>;
      log?: (msg: string, accountId: string) => void;
    },
  ) {}

  async degrade(accountId: string, reason: string): Promise<void> {
    await this.deps.accounts.setStatus(accountId, 'DEGRADED', reason);
    await this.deps.alerts.raiseForAccount(
      accountId,
      'account_degraded',
      'A Google account was disconnected or its access was revoked. Files stored on it are unavailable until you re-authorise it on the Storage page.',
    );
    this.deps.log?.('account degraded', accountId);
  }
}
