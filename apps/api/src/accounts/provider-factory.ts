import type { AppConfig } from '@pooldrive/shared';
import { FakeProvider } from '../storage/fake-provider.js';
import { GoogleDriveProvider } from '../storage/google-drive-provider.js';
import type { StorageProvider } from '../storage/provider.js';
import type { AccountCredentials } from './provider-registry.js';

const FAKE_ACCOUNT_BYTES = 15 * 1024 ** 3;

/** Builds the provider for one account: Drive in production, in-memory for STORAGE_PROVIDER=fake. */
export function providerFactory(cfg: AppConfig): (c: AccountCredentials) => StorageProvider {
  const fakes = new Map<string, FakeProvider>(); // fake accounts keep their blobs across re-auth
  return (c) => {
    if (cfg.STORAGE_PROVIDER === 'fake') {
      let f = fakes.get(c.accountId);
      if (!f) fakes.set(c.accountId, (f = new FakeProvider({ limit: FAKE_ACCOUNT_BYTES })));
      return f;
    }
    if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET) {
      throw new Error('Google OAuth is not configured (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET)');
    }
    return new GoogleDriveProvider({
      clientId: cfg.GOOGLE_CLIENT_ID,
      clientSecret: cfg.GOOGLE_CLIENT_SECRET,
      refreshToken: c.refreshToken,
      appFolderId: c.appFolderId,
    });
  };
}
