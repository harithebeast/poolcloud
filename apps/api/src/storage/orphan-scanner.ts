import type { ProviderResolver, RemoteBlob } from './provider.js';
import type { AccountStore } from './stores.js';

/** What PoolDrive believes it should have in an account. */
export interface BlobIndex {
  /** Remote ids referenced by file_chunks. */
  chunkRemoteIds(accountId: string): Promise<Set<string>>;
  /** Remote ids already queued for deletion (not orphans, just not cleaned up yet). */
  pendingCleanupIds(accountId: string): Promise<Set<string>>;
}

export interface AccountScan {
  accountId: string;
  /** In Drive but unknown to PoolDrive, and older than the grace period. */
  orphans: RemoteBlob[];
  /** Referenced by a file but absent from Drive: those files are damaged. */
  missing: string[];
  /** Set when the account could not be listed (offline accounts are skipped, not failed). */
  error?: string;
}

export interface ScanReport {
  accounts: AccountScan[];
  orphanCount: number;
  orphanBytes: number;
  missingCount: number;
}

/**
 * Reconciles what is in each Drive with the database. REPORT ONLY: it never deletes anything,
 * because deleting on a wrong guess would destroy user data. An operator reviews the report.
 */
export class OrphanScanner {
  constructor(
    private readonly deps: {
      accounts: AccountStore;
      providers: ProviderResolver;
      index: BlobIndex;
      now?: () => number;
    },
  ) {}

  async scan(ownerId: string, minAgeMs = 24 * 60 * 60 * 1000): Promise<ScanReport> {
    const now = (this.deps.now ?? Date.now)();
    const accounts: AccountScan[] = [];
    for (const account of await this.deps.accounts.list(ownerId)) {
      if (account.status === 'DISCONNECTED') continue;
      try {
        accounts.push(await this.scanOne(account.id, now, minAgeMs));
      } catch (err) {
        accounts.push({
          accountId: account.id,
          orphans: [],
          missing: [],
          error: err instanceof Error ? err.message : 'unknown error',
        });
      }
    }
    const orphans = accounts.flatMap((a) => a.orphans);
    return {
      accounts,
      orphanCount: orphans.length,
      orphanBytes: orphans.reduce((s, b) => s + b.size, 0),
      missingCount: accounts.reduce((s, a) => s + a.missing.length, 0),
    };
  }

  private async scanOne(accountId: string, now: number, minAgeMs: number): Promise<AccountScan> {
    const { index, providers } = this.deps;
    const [known, pending] = await Promise.all([
      index.chunkRemoteIds(accountId),
      index.pendingCleanupIds(accountId),
    ]);
    const orphans: RemoteBlob[] = [];
    const seen = new Set<string>();
    for await (const blob of providers(accountId).listBlobs()) {
      seen.add(blob.remoteId);
      if (known.has(blob.remoteId) || pending.has(blob.remoteId)) continue;
      // Young blobs may belong to an upload that is still running.
      if (now - blob.createdAt.getTime() < minAgeMs) continue;
      orphans.push(blob);
    }
    const missing = [...known].filter((id) => !seen.has(id));
    return { accountId, orphans, missing };
  }
}
