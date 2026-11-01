# PoolDrive — Plan

## 1. Architecture

```
Browser (Next.js) ──HTTP──▶ API (NestJS/Fastify) ──▶ PostgreSQL (metadata, chunk map, reservations)
                               │  │                   Redis ◀── BullMQ ◀── Worker (quota sync, purge,
                               │  └─ StorageProvider        cleanup, orphan scan, migration)
                               ▼
              ┌────────── StorageService (provider-agnostic) ──────────┐
              │ PlacementStrategy · Chunker · Crypto · QuotaService     │
              └───────────────┬───────────────────────────────────────┘
                              ▼
           GoogleDriveProvider (prod)   FakeProvider (tests / STORAGE_PROVIDER=fake)
```

- **Virtual FS**: folders/files exist only in Postgres (`nodes`). Drive holds opaque UUID-named blobs in one app folder per account.
- **Core domain** (`packages/shared` holds types/zod schemas; `apps/api/src/storage` holds domain logic, no Nest imports in pure modules so unit tests are fast).
- **Placement**: whole file → healthy account with most free space (after reservations and headroom). If none fits, chunk; each chunk is placed independently with the same strategy, re-evaluating free space.
- **Reservations**: `quota_reservations` rows are created inside a transaction holding `SELECT … FOR UPDATE` on the `storage_accounts` row; `available = limit − usage − headroom − Σ active reservations`. Reservations expire (TTL) and are released on commit/rollback.
- **Upload**: browser sends fixed-size parts to `PUT /uploads/:id/parts/:n` (resumable, idempotent by part number). API streams parts through hash → (optional AES-256-GCM) → provider resumable upload, bounded buffers. Finalise = one DB transaction inserting node + chunks and converting reservations. Failure → chunks recorded in `remote_cleanup` (outbox) and deleted by a worker job.
- **Download**: stream chunks in order, verify SHA-256 of stored bytes, decrypt GCM per chunk. Range supported for single-chunk files.
- **Crypto**: per-file random data key (DEK) wrapped with master key (`kid` stored); per-chunk random 96-bit nonce; AAD = fileId‖chunkIndex‖chunkCount (prevents reorder/truncate).

## 2. Data model (ERD)

```
users(id, email unique, password_hash, role, totp_secret?, created_at)
sessions(id, user_id→users, expires_at, ...)
storage_accounts(id, owner_id→users, google_sub, email, refresh_token_enc, status[HEALTHY|DEGRADED|DISCONNECTED|DRAINING],
                 app_folder_id, quota_limit, quota_usage, quota_synced_at, consecutive_errors, last_error)
nodes(id, owner_id, parent_id→nodes, type[file|folder], name, size, mime, encrypted, encrypt_default,
      key_id, wrapped_dek, trashed_at, trash_root_id, created_at, updated_at)
      UNIQUE(owner_id, parent_id, name) WHERE trashed_at IS NULL   -- root uses a sentinel via COALESCE index
file_chunks(file_id→nodes, index, account_id→storage_accounts, remote_id, size, sha256, nonce)  PK(file_id,index)
quota_reservations(id, owner_id, account_id, upload_id, bytes, expires_at)
uploads(id, owner_id, idempotency_key, parent_id, name, size, state, chunk_plan jsonb, created_at)  UNIQUE(owner_id, idempotency_key)
remote_cleanup(id, owner_id, account_id, remote_id, reason, attempts, next_attempt_at)
share_links(id, owner_id, node_id, token_hash unique, password_hash?, expires_at?, download_count, revoked_at)
alerts(id, owner_id, account_id?, kind, message, created_at, resolved_at)
```

Indexes (documented again in `docs/architecture.md`): `nodes(owner_id,parent_id,name)` partial-unique for live nodes; `nodes(owner_id,trashed_at)` for trash/purge; `nodes(owner_id, lower(name) text_pattern_ops)` for search; `file_chunks(account_id)`; `quota_reservations(account_id, expires_at)`; `share_links(token_hash)`.

## 3. API outline (`/api/v1`)

Implemented as of Phase 2 (interactive docs at `/docs` outside production):

- Auth: `GET /auth/status`, `POST /auth/setup` (first run only), `/auth/login`, `/auth/logout`, `GET /auth/me`, `POST /auth/users` (admin).
- Accounts (admin): `GET /accounts`, `POST /accounts/google/start` (also re-authorise, with `accountId`), `GET /accounts/google/callback`. `GET /storage/usage` for everyone.
- Files: `GET /files?parentId=`, `GET /files/:id`, `GET /files/search?q=`, `POST /folders`, `PATCH /files/:id` (rename / move / `encryptByDefault`), `DELETE /files/:id` (trash).
- Upload: `POST /files/upload?name=&parentId=&encrypt=` with `Idempotency-Key` and `Content-Length`; the body is the file (ADR-0005).
- Download: `GET /files/:id/content[?download=1]` (`Range` for whole, unencrypted files).
- Trash: `GET /trash`, `POST /trash/:id/restore`, `DELETE /trash/:id`, `DELETE /trash`.
- Sharing: `POST /shares`, `GET /shares?nodeId=`, `DELETE /shares/:id`; public `GET /public/shares/:token`, `POST /public/shares/:token/unlock`, `GET /public/shares/:token/content`.
- Alerts: `GET /alerts`, `DELETE /alerts/:id`.
- Ops: `/health/live`, `/health/ready`, `/metrics` (optional bearer `METRICS_TOKEN`).

Account removal: `DELETE /accounts/:id` (starts a migration, ADR-0008) and `POST /accounts/:id/cancel-removal`.

## 4. Risks and mitigations

| Risk                                                                                                                        | Mitigation                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Testing-mode OAuth refresh tokens expire after 7 days                                                                       | Detect `invalid_grant` → DEGRADED + alert + one-click re-auth; document publishing to "In production" (unverified is OK for ≤100 users with `drive.file`) in `google-setup.md`                                                                                                       |
| `drive.file` only sees files created by this app                                                                            | Sufficient: we only touch blobs we created. Re-auth keeps same client ID so access persists. ADR-0003                                                                                                                                                                                |
| Drive daily upload cap ≈750 GB/account, API rate limits                                                                     | Backoff+jitter, per-account concurrency limit, treat `userRateLimitExceeded`/daily limit as temporary account exclusion                                                                                                                                                              |
| No redundancy ⇒ split file unavailable if any holder is down                                                                | UI states it; `Redundancy` extension point (`ChunkCodec`) reserved for parity                                                                                                                                                                                                        |
| Drive quota is shared with Gmail/Photos                                                                                     | Always use `about.get`; usage can change outside the app, so reservations + headroom                                                                                                                                                                                                 |
| Resumable-upload sessions to Drive are per-account/URL-bound and cannot be passed to browser safely                         | Browser uploads to our API only; API streams to Drive                                                                                                                                                                                                                                |
| Crash mid-upload leaves remote blobs                                                                                        | Outbox (`remote_cleanup`) written **before** upload starts, removed on commit; worker deletes leftovers                                                                                                                                                                              |
| Default 5% headroom means the "3 accounts x 1 GB free + 3 GB file" case cannot fit: usable = 3 x (1 GB - 0.75 GB) = 0.75 GB | Scenario (a) runs with headroom 0 (exact edge) and a second test proves the default refuses with `InsufficientCapacityError` and leaves nothing behind. Set `HEADROOM_PERCENT=0 HEADROOM_MIN_BYTES=0` to use every byte; this is a safety/capacity trade-off the owner should choose |
| Fixed-size chunks strand up to one chunk of free space per account                                                          | Chunk size adapts: when no account has room for a full chunk the next chunk shrinks to the best account's remaining space. GCM AAD therefore authenticates `isLast` instead of a chunk count                                                                                         |
| Encrypted records are buffered whole on download (GCM must verify before releasing plaintext)                               | Encrypted files are stored in records of at most `ENCRYPTED_CHUNK_BYTES` (default 16 MiB), so a download holds about 2x that. Uploads stream through the cipher and buffer nothing (ADR-0004)                                                                                        |
| Non-retryable upload streams: a failed chunk upload cannot replay a consumed unencrypted stream                             | Drive uploads are resumable in 8 MiB pieces held in memory, so transient failures resume mid-chunk; a hard failure aborts and rolls back the whole upload (client retries idempotently)                                                                                              |
| Uploads are one streaming request, not client-resumable parts (ADR-0005)                                                    | A dropped browser connection restarts that file; Drive-side pieces still resume. The idempotency key makes the retry safe. Revisit with tus-style parts if large flaky uploads matter                                                                                                |
| Docker Desktop daemon availability on dev PC                                                                                | Gate verification via Compose requires it running                                                                                                                                                                                                                                    |
| 5 GB / 300 MB RSS                                                                                                           | Streams only. `pnpm --filter @pooldrive/api test:memory` moves 5 GB each way over HTTP with a disk-backed provider and samples RSS. Measured: plain 206 MB peak, encrypted 261 MB peak (server and test client in one process)                                                       |

## 5. Phases

0 Foundations → 1 Storage core → 2 API → 3 UI → 4 Hardening (see project brief).

Status: phases 0-4 are complete. See [definition-of-done.md](definition-of-done.md) for the evidence behind each requirement.
