import { ProviderAuthError } from './errors.js';
import type { ProviderResolver } from './provider.js';
import type { AccountStore } from './stores.js';

export interface PoolUsage {
  limit: number;
  usage: number;
  free: number;
}

/** Transient errors tolerated before an account is taken out of rotation. */
const DEGRADE_AFTER_FAILURES = 3;

export class QuotaSyncService {
  constructor(
    private readonly deps: {
      accounts: AccountStore;
      providers: ProviderResolver;
      onDegraded?: (accountId: string, reason: string) => void | Promise<void>;
    },
  ) {}

  /**
   * Refresh each linked account's quota from the provider (the source of truth: the 15 GB is shared
   * with Gmail/Photos). A revoked token degrades the account at once; other errors need repeating.
   */
  async syncOwner(ownerId: string): Promise<void> {
    const accounts = await this.deps.accounts.list(ownerId);
    await Promise.all(
      accounts
        .filter((a) => a.status === 'HEALTHY' || a.status === 'DRAINING')
        .map((a) => this.syncOne(a.id)),
    );
  }

  private async syncOne(accountId: string): Promise<void> {
    const { accounts, providers } = this.deps;
    try {
      await accounts.setQuota(accountId, await providers(accountId).getQuota());
      await accounts.resetFailures(accountId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      if (err instanceof ProviderAuthError) return this.degrade(accountId, message);
      if ((await accounts.recordFailure(accountId, message)) >= DEGRADE_AFTER_FAILURES) {
        await this.degrade(accountId, message);
      }
    }
  }

  private async degrade(accountId: string, reason: string): Promise<void> {
    await this.deps.accounts.setStatus(accountId, 'DEGRADED', reason);
    await this.deps.onDegraded?.(accountId, reason);
  }

  /** Pooled totals across usable accounts (what the UI's single bar shows). */
  async poolUsage(ownerId: string): Promise<PoolUsage> {
    const usable = (await this.deps.accounts.list(ownerId)).filter(
      (a) => a.status !== 'DISCONNECTED',
    );
    const limit = usable.reduce((s, a) => s + a.limit, 0);
    const usage = usable.reduce((s, a) => s + a.usage, 0);
    return { limit, usage, free: Math.max(0, limit - usage) };
  }
}
