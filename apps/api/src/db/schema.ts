import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { ACCOUNT_STATUSES, NODE_TYPES, USER_ROLES } from '@pooldrive/shared';

export const accountStatus = pgEnum('account_status', ACCOUNT_STATUSES);
export const nodeType = pgEnum('node_type', NODE_TYPES);
export const userRole = pgEnum('user_role', USER_ROLES);

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const bytes = (name: string) => bigint(name, { mode: 'number' });

export const users = pgTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: userRole('role').notNull().default('user'),
  totpSecretEnc: text('totp_secret_enc'),
  createdAt: createdAt(),
});

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('sessions_owner_idx').on(t.ownerId), index('sessions_expires_idx').on(t.expiresAt)],
);

export const storageAccounts = pgTable(
  'storage_accounts',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    googleSub: text('google_sub').notNull(),
    email: text('email').notNull(),
    refreshTokenEnc: text('refresh_token_enc').notNull(),
    status: accountStatus('status').notNull().default('HEALTHY'),
    appFolderId: text('app_folder_id'),
    quotaLimit: bytes('quota_limit').notNull().default(0),
    quotaUsage: bytes('quota_usage').notNull().default(0),
    quotaSyncedAt: timestamp('quota_synced_at', { withTimezone: true }),
    consecutiveErrors: integer('consecutive_errors').notNull().default(0),
    lastError: text('last_error'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('storage_accounts_owner_sub_uq').on(t.ownerId, t.googleSub)],
);

export const nodes = pgTable(
  'nodes',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    parentId: uuid('parent_id').references((): AnyPgColumn => nodes.id),
    type: nodeType('type').notNull(),
    name: text('name').notNull(),
    size: bytes('size').notNull().default(0),
    mime: text('mime'),
    encrypted: boolean('encrypted').notNull().default(false),
    /** Folder setting inherited by new children. */
    encryptByDefault: boolean('encrypt_by_default').notNull().default(false),
    keyId: text('key_id'),
    wrappedDek: text('wrapped_dek'),
    trashedAt: timestamp('trashed_at', { withTimezone: true }),
    /** The node that was explicitly trashed (descendants point at it). */
    trashRootId: uuid('trash_root_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Name uniqueness among live siblings; root-level (parent_id NULL) uses a zero-UUID sentinel.
    uniqueIndex('nodes_live_name_uq')
      .on(
        t.ownerId,
        sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.name,
      )
      .where(sql`${t.trashedAt} is null`),
    index('nodes_parent_idx').on(t.ownerId, t.parentId),
    index('nodes_trash_idx').on(t.ownerId, t.trashedAt),
    index('nodes_search_idx').on(t.ownerId, sql`lower(${t.name}) text_pattern_ops`),
  ],
);

export const fileChunks = pgTable(
  'file_chunks',
  {
    fileId: uuid('file_id')
      .notNull()
      .references(() => nodes.id),
    index: integer('index').notNull(),
    accountId: uuid('account_id')
      .notNull()
      .references(() => storageAccounts.id),
    remoteId: text('remote_id').notNull(),
    size: bytes('size').notNull(),
    sha256: text('sha256').notNull(),
    nonce: text('nonce'),
  },
  (t) => [
    primaryKey({ columns: [t.fileId, t.index] }),
    index('file_chunks_account_idx').on(t.accountId),
  ],
);

export const uploads = pgTable(
  'uploads',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    idempotencyKey: text('idempotency_key').notNull(),
    parentId: uuid('parent_id').references(() => nodes.id),
    name: text('name').notNull(),
    size: bytes('size').notNull(),
    encrypted: boolean('encrypted').notNull().default(false),
    state: text('state').notNull().default('open'),
    plan: jsonb('plan'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uploads_idem_uq').on(t.ownerId, t.idempotencyKey)],
);

export const quotaReservations = pgTable(
  'quota_reservations',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => storageAccounts.id),
    uploadId: uuid('upload_id').references(() => uploads.id, { onDelete: 'cascade' }),
    bytes: bytes('bytes').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (t) => [index('quota_res_account_idx').on(t.accountId, t.expiresAt)],
);

/** Outbox of remote blobs that must be deleted. Written BEFORE a remote upload starts. */
export const remoteCleanup = pgTable(
  'remote_cleanup',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    accountId: uuid('account_id')
      .notNull()
      .references(() => storageAccounts.id),
    remoteId: text('remote_id').notNull(),
    reason: text('reason').notNull(),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('remote_cleanup_due_idx').on(t.nextAttemptAt)],
);

export const shareLinks = pgTable(
  'share_links',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    nodeId: uuid('node_id')
      .notNull()
      .references(() => nodes.id),
    tokenHash: text('token_hash').notNull().unique(),
    passwordHash: text('password_hash'),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    downloadCount: integer('download_count').notNull().default(0),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index('share_links_node_idx').on(t.nodeId)],
);

export const alerts = pgTable(
  'alerts',
  {
    id: id(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id),
    accountId: uuid('account_id').references(() => storageAccounts.id),
    kind: text('kind').notNull(),
    message: text('message').notNull(),
    createdAt: createdAt(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => [index('alerts_owner_open_idx').on(t.ownerId, t.resolvedAt)],
);
