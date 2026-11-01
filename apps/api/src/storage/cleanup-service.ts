import type { ProviderResolver } from './provider.js';
import type { CleanupOutbox } from './stores.js';

export interface CleanupResult {
  deleted: number;
  failed: number;
}

const BATCH = 100;
const MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;

/** Deletes remote blobs left behind by aborted/crashed uploads and purged files. Safe to re-run. */
export class CleanupService {
  constructor(
    private readonly deps: {
      outbox: CleanupOutbox;
      providers: ProviderResolver;
      baseRetryMs?: number;
    },
  ) {}

  async run(): Promise<CleanupResult> {
    const result: CleanupResult = { deleted: 0, failed: 0 };
    const due = await this.deps.outbox.claimDue(BATCH);
    for (const entry of due) {
      try {
        await this.deps.providers(entry.accountId).delete(entry.remoteId);
        await this.deps.outbox.remove([entry.id]);
        result.deleted += 1;
      } catch {
        const base = this.deps.baseRetryMs ?? 60_000;
        await this.deps.outbox.recordFailure(
          entry.id,
          Math.min(base * 2 ** entry.attempts, MAX_BACKOFF_MS),
        );
        result.failed += 1;
      }
    }
    return result;
  }
}
