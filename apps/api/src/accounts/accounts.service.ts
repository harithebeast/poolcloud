import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/db.module.js';
import { alerts, storageAccounts } from '../db/schema.js';
import type { KeyRing } from '../storage/crypto.js';
import type { StorageProvider } from '../storage/provider.js';
import { decodeState, encodeState, newNonce } from './link-state.js';
import { LinkError, type LinkBackend } from './link-backend.js';
import type { AccountCredentials, ProviderRegistry } from './provider-registry.js';

const STATE_TTL_MS = 10 * 60 * 1000;

export class InvalidLinkStateError extends Error {
  constructor() {
    super('This link request is invalid or has expired. Start again.');
  }
}

export interface AccountView {
  id: string;
  email: string;
  status: string;
  quotaLimit: number;
  quotaUsage: number;
  quotaSyncedAt: Date | null;
  lastError: string | null;
}

const secretContext = (ownerId: string, sub: string) => `account:${ownerId}:${sub}`;

export class AccountsService {
  constructor(
    private readonly deps: {
      db: Db;
      keyRing: KeyRing;
      backend: LinkBackend;
      registry: ProviderRegistry;
      stateSecret: string;
      now?: () => number;
    },
  ) {}

  /** Resolver for the storage services (upload, download, cleanup, quota sync). */
  get providers(): (accountId: string) => StorageProvider {
    return this.deps.registry.get;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Begin linking (or re-authorising `accountId`). The nonce must also be set as a cookie. */
  async start(ownerId: string, accountId?: string) {
    let hint: string | undefined;
    if (accountId) {
      const [a] = await this.deps.db
        .select({ email: storageAccounts.email })
        .from(storageAccounts)
        .where(and(eq(storageAccounts.id, accountId), eq(storageAccounts.ownerId, ownerId)));
      if (!a) throw new LinkError('Unknown account');
      hint = a.email;
    }
    const nonce = newNonce();
    const state = encodeState(this.deps.stateSecret, {
      uid: ownerId,
      accountId,
      nonce,
      exp: this.now() + STATE_TTL_MS,
    });
    return { url: this.deps.backend.authUrl(state, hint), nonce };
  }

  /** Finish the OAuth round trip: verify the state, store the encrypted token, mark the account healthy. */
  async complete(
    ownerId: string,
    code: string,
    stateToken: string,
    cookieNonce: string | undefined,
  ) {
    const state = decodeState(this.deps.stateSecret, stateToken, this.now());
    if (!state || state.uid !== ownerId || !cookieNonce || state.nonce !== cookieNonce) {
      throw new InvalidLinkStateError();
    }
    const identity = await this.deps.backend.exchange(code);

    const [existing] = await this.deps.db
      .select()
      .from(storageAccounts)
      .where(
        and(eq(storageAccounts.ownerId, ownerId), eq(storageAccounts.googleSub, identity.sub)),
      );
    if (state.accountId && existing?.id !== state.accountId) {
      throw new LinkError(
        `That is ${identity.email}, but you are re-authorising a different account. Sign in with the same Google account.`,
      );
    }

    const refreshTokenEnc = this.deps.keyRing.sealSecret(
      identity.refreshToken,
      secretContext(ownerId, identity.sub),
    );
    let id: string;
    if (existing) {
      id = existing.id;
      await this.deps.db
        .update(storageAccounts)
        .set({
          refreshTokenEnc,
          email: identity.email,
          status: 'HEALTHY',
          consecutiveErrors: 0,
          lastError: null,
        })
        .where(eq(storageAccounts.id, id));
      await this.deps.db
        .update(alerts)
        .set({ resolvedAt: new Date(this.now()) })
        .where(and(eq(alerts.accountId, id), isNull(alerts.resolvedAt)));
    } else {
      const appFolderId = await this.deps.backend.createAppFolder(identity.refreshToken);
      const [row] = await this.deps.db
        .insert(storageAccounts)
        .values({
          ownerId,
          googleSub: identity.sub,
          email: identity.email,
          refreshTokenEnc,
          appFolderId,
        })
        .returning({ id: storageAccounts.id });
      id = row!.id;
    }

    this.deps.registry.invalidate(id);
    try {
      await this.refreshQuota(id);
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'unknown error';
      throw new LinkError(
        `${identity.email} was linked but its storage quota could not be read: ${reason}`,
      );
    }
    return { id, email: identity.email, reauthorised: Boolean(existing) };
  }

  /** Decrypts the credentials for one account (used by the provider registry). */
  async credentials(accountId: string): Promise<AccountCredentials | null> {
    const [a] = await this.deps.db
      .select()
      .from(storageAccounts)
      .where(eq(storageAccounts.id, accountId));
    if (!a?.appFolderId) return null;
    return {
      accountId: a.id,
      appFolderId: a.appFolderId,
      refreshToken: this.deps.keyRing.openSecret(
        a.refreshTokenEnc,
        secretContext(a.ownerId, a.googleSub),
      ),
    };
  }

  private async refreshQuota(accountId: string): Promise<void> {
    const quota = await this.deps.registry.get(accountId).getQuota();
    await this.deps.db
      .update(storageAccounts)
      .set({
        quotaLimit: quota.limit,
        quotaUsage: quota.usage,
        quotaSyncedAt: new Date(this.now()),
      })
      .where(eq(storageAccounts.id, accountId));
  }

  async list(ownerId: string): Promise<AccountView[]> {
    const rows = await this.deps.db
      .select()
      .from(storageAccounts)
      .where(eq(storageAccounts.ownerId, ownerId))
      .orderBy(storageAccounts.createdAt);
    return rows.map((a) => ({
      id: a.id,
      email: a.email,
      status: a.status,
      quotaLimit: a.quotaLimit,
      quotaUsage: a.quotaUsage,
      quotaSyncedAt: a.quotaSyncedAt,
      lastError: a.lastError,
    }));
  }
}
