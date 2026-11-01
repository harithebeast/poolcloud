import type { Readable } from 'node:stream';
import type { ByteRange, Quota, StorageProvider } from '../storage/provider.js';

export interface AccountCredentials {
  accountId: string;
  refreshToken: string;
  appFolderId: string;
}

/**
 * Hands out one StorageProvider per account. Providers are built lazily because the credentials
 * (an encrypted refresh token) live in the database, while `ProviderResolver` is synchronous.
 */
export class ProviderRegistry {
  private readonly cache = new Map<string, LazyProvider>();

  constructor(
    private readonly deps: {
      load: (accountId: string) => Promise<AccountCredentials | null>;
      make: (credentials: AccountCredentials) => StorageProvider;
    },
  ) {}

  get = (accountId: string): StorageProvider => {
    let p = this.cache.get(accountId);
    if (!p) {
      p = new LazyProvider(async () => {
        const creds = await this.deps.load(accountId);
        if (!creds) throw new Error(`Unknown storage account ${accountId}`);
        return this.deps.make(creds);
      });
      this.cache.set(accountId, p);
    }
    return p;
  };

  /** Drop the cached provider (after re-authorisation changed the credentials). */
  invalidate(accountId: string): void {
    this.cache.delete(accountId);
  }
}

class LazyProvider implements StorageProvider {
  private inner: Promise<StorageProvider> | undefined;

  constructor(private readonly build: () => Promise<StorageProvider>) {}

  private target(): Promise<StorageProvider> {
    this.inner ??= this.build().catch((err: unknown) => {
      this.inner = undefined; // retry next time instead of caching the failure
      throw err;
    });
    return this.inner;
  }

  async allocateId(): Promise<string> {
    return (await this.target()).allocateId();
  }
  async upload(remoteId: string, data: Readable, size: number): Promise<{ size: number }> {
    return (await this.target()).upload(remoteId, data, size);
  }
  async download(remoteId: string, range?: ByteRange): Promise<Readable> {
    return (await this.target()).download(remoteId, range);
  }
  async delete(remoteId: string): Promise<void> {
    return (await this.target()).delete(remoteId);
  }
  async getQuota(): Promise<Quota> {
    return (await this.target()).getQuota();
  }
  async healthCheck(): Promise<void> {
    return (await this.target()).healthCheck();
  }
}
