import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import { DB, type Db } from '../db/db.module.js';
import { KeyRing } from '../storage/crypto.js';
import { AccountsController } from './accounts.controller.js';
import { AccountsService } from './accounts.service.js';
import { FakeLinkBackend, GoogleLinkBackend, LinkError, type LinkBackend } from './link-backend.js';
import { providerFactory } from './provider-factory.js';
import { ProviderRegistry } from './provider-registry.js';

export const KEY_RING = Symbol('KEY_RING');
export const LINK_BACKEND = Symbol('LINK_BACKEND');

export function callbackUrl(cfg: AppConfig): string {
  return (
    cfg.GOOGLE_REDIRECT_URI ?? `http://localhost:${cfg.API_PORT}/api/v1/accounts/google/callback`
  );
}

/** Surfaces a clear message when Google is selected but the OAuth client is not configured yet. */
class UnconfiguredBackend implements LinkBackend {
  private fail(): never {
    throw new LinkError(
      'Google OAuth is not configured. Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (see docs/google-setup.md).',
    );
  }
  authUrl(): string {
    return this.fail();
  }
  exchange(): Promise<never> {
    return this.fail();
  }
  createAppFolder(): Promise<never> {
    return this.fail();
  }
}

@Global()
@Module({
  controllers: [AccountsController],
  providers: [
    {
      provide: KEY_RING,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => KeyRing.parse(c.MASTER_KEYS),
    },
    {
      provide: LINK_BACKEND,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig): LinkBackend => {
        if (cfg.STORAGE_PROVIDER === 'fake') return new FakeLinkBackend(callbackUrl(cfg));
        if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET) return new UnconfiguredBackend();
        return new GoogleLinkBackend(
          cfg.GOOGLE_CLIENT_ID,
          cfg.GOOGLE_CLIENT_SECRET,
          callbackUrl(cfg),
        );
      },
    },
    {
      provide: AccountsService,
      inject: [DB, KEY_RING, LINK_BACKEND, APP_CONFIG],
      useFactory: (db: Db, keyRing: KeyRing, backend: LinkBackend, cfg: AppConfig) => {
        const registry = new ProviderRegistry({
          load: (id) => service.credentials(id),
          make: providerFactory(cfg),
        });
        const service: AccountsService = new AccountsService({
          db,
          keyRing,
          backend,
          registry,
          stateSecret: cfg.SESSION_SECRET,
        });
        return service;
      },
    },
  ],
  exports: [KEY_RING, LINK_BACKEND, AccountsService],
})
export class AccountsModule {}
