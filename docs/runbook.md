# Runbook

Commands assume the repository root and a running `docker compose` stack.

## First start

```bash
node scripts/init-env.mjs        # generates .env with random secrets; refuses to overwrite an existing one
# edit .env: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (see google-setup.md), or STORAGE_PROVIDER=fake to try it out
docker compose up --build -d
curl localhost:4400/health/ready  # {"status":"ok",...}
```

The first visitor to the web app creates the admin account. There is no public sign-up.

## Health

| Check                | Command                                                                                |
| -------------------- | -------------------------------------------------------------------------------------- |
| API alive / ready    | `curl localhost:4400/health/live`, `curl localhost:4400/health/ready`                  |
| Worker alive / ready | `docker compose exec worker wget -qO- localhost:4001/health/ready`                     |
| Containers           | `docker compose ps`                                                                    |
| Metrics              | `curl localhost:4400/metrics` (add `-H "Authorization: Bearer $METRICS_TOKEN"` if set) |
| Worker job results   | `docker compose logs worker --since 10m` (look for `job finished` / `job failed`)      |

Useful metrics: `pooldrive_storage_accounts{status="DEGRADED"}` above zero means an account needs attention;
`pooldrive_pool_used_bytes / pooldrive_pool_capacity_bytes` is pool fullness;
`pooldrive_http_request_duration_seconds` by route.

## An account shows DEGRADED

Causes: the token was revoked at <https://myaccount.google.com/permissions>, the password changed, or (while the Google app is
in _Testing_) the 7-day refresh token expired.

1. Storage page, **Re-authorise** on that account, and sign in with the **same** Google account.
2. Files on it work again immediately; nothing was deleted. New uploads use it again.
3. If it keeps happening weekly, publish the consent screen (`google-setup.md`).

While an account is DEGRADED: new uploads avoid it, files stored only on healthy accounts work, and files that have any
piece on it return `503 file_unavailable`.

## Storage is full or uploads return 507

`507 insufficient_storage` means no combination of healthy accounts has room after the safety headroom
(`HEADROOM_PERCENT`, default 5%, and `HEADROOM_MIN_BYTES`). Link another account, empty the trash
(`DELETE /trash`), or lower the headroom. Lowering it to 0 lets uploads use every byte but leaves no margin for the free
space Gmail and Photos consume.

## Alerts

`GET /alerts` lists open alerts; the UI shows them on the Storage page.

| Kind               | Meaning                                                                               | Action                                                                 |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `account_degraded` | An account was disconnected or revoked                                                | Re-authorise (above)                                                   |
| `orphan_blobs`     | Blobs in Drive that no file references (older than 24 hours, not queued for deletion) | Investigate first: see below. Nothing is deleted automatically         |
| `missing_blobs`    | A file's chunk is gone from Drive; the file cannot be downloaded                      | Restore the blob if it is in Drive's trash, or delete the damaged file |

### Reviewing orphans

The scan runs daily and only reports. To list them, run the scan from a Node shell against the database, or read the worker
log line `orphan scan finished`. Orphans usually come from a crash between "blob written" and "database commit" where the
cleanup entry was also lost, which should not happen; if you find any, please open an issue with the log. Only delete a blob
after confirming no `file_chunks.remote_id` references it.

## Trash

Deleted items stay in the trash for `TRASH_RETENTION_DAYS` (default 30), then the worker purges them. Purging queues the
remote blobs in `remote_cleanup`, and the cleanup job (every minute) deletes them from Drive and frees the quota.
Check the backlog with:

```sql
select count(*), min(next_attempt_at) from remote_cleanup;
```

A growing backlog with `attempts` above 3 means an account is unreachable; fix the account and the job catches up.

## Key rotation

`MASTER_KEYS` is `kid:base64,kid2:base64`. The **first** entry encrypts new data; all entries can decrypt.

1. Generate a key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
2. Put it **first**: `MASTER_KEYS=k2:<new>,k1:<old>`. Restart the API and worker.
3. New files and re-authorised accounts use `k2`; existing data still opens with `k1`. Keep `k1` for as long as anything uses it.
   A bulk re-wrap job is not part of v1.

Never remove a key that something still uses: that data becomes unrecoverable.

## Backups

Back up together: the Postgres volume, and `.env` (or at least `MASTER_KEYS` and `SESSION_SECRET`) stored **separately**.
Without the database the blobs in Drive cannot be mapped back to files; without `MASTER_KEYS` encrypted files and stored
refresh tokens cannot be read.

```bash
docker compose exec postgres pg_dump -U pooldrive pooldrive | gzip > pooldrive-$(date +%F).sql.gz
```

## Verifying a release

```bash
pnpm lint && pnpm format:check && pnpm typecheck
TEST_DATABASE_URL=postgres://... pnpm test:ci      # needs a Postgres where the user may CREATE DATABASE; enforces coverage
pnpm --filter @pooldrive/api test:memory           # 5 GB streaming check; set SIZE_GB=1 for a quicker run

# Browser end-to-end tests (Playwright) on an isolated stack with fake Google, on ports 3100/4100.
# It creates the first admin, so it needs a fresh database: always start from `down -v`.
docker compose -p pooldrive-e2e -f docker-compose.yml -f docker-compose.e2e.yml down -v
docker compose -p pooldrive-e2e -f docker-compose.yml -f docker-compose.e2e.yml up -d --build
pnpm --filter @pooldrive/web exec playwright install chromium   # once
pnpm --filter @pooldrive/web test:e2e                          # journey + WCAG checks (axe) in light and dark
docker compose -p pooldrive-e2e -f docker-compose.yml -f docker-compose.e2e.yml down -v
```

## Removing a Google account

Storage page, **Remove** on the account, confirm. What happens:

1. The account becomes **Being removed**. Nothing new is stored on it, and every file keeps working.
2. The worker moves its pieces to your other accounts (checking each one against its checksum), 25 at a time, every 30
   seconds. The Storage page shows how many pieces are left.
3. When it is empty it shows **Removed**. The old copies are deleted from that Google account by the cleanup job shortly
   after (within about an hour; a delay is deliberate so downloads in progress can finish).
4. Optional tidy-up in that Google account: revoke PoolDrive at <https://myaccount.google.com/permissions> and delete the empty
   "PoolDrive (do not edit)" folder.

If it says **paused** (an alert on the Storage page), the other accounts cannot take a piece: link another account or free
space, and it resumes by itself. **Cancel removal** returns the account to service at any time. An offline account cannot be
removed until it is re-authorised, because its files cannot be read. Check progress in the log:

```sh
docker compose logs worker --since 10m | grep -i drain
```

A removed account can be linked again later from the Storage page; it comes back as the same account.

## Load testing

`scripts/load-test.mjs` signs in, uploads many files at once, lists them, downloads each and compares checksums, then removes
what it created. Use the fake-storage test stack (see "Verifying a release") or your own pool (it uses real quota while it runs).

```sh
API_URL=http://localhost:4100/api/v1 E2E_EMAIL=you@example.com E2E_PASSWORD=... \
  FILES=300 SIZE_KB=128 CONCURRENCY=16 node scripts/load-test.mjs
ENCRYPT=true FILES=100 SIZE_KB=512 CONCURRENCY=8 node scripts/load-test.mjs
```

Reference results from the author's PC (fake storage in Docker, API limited to 512 MB): 300 x 128 KB uploaded at 16 at a time
with p50 about 190 ms and p95 about 1 s, 0 failures; downloads p50 about 60 ms; 100 x 512 KB encrypted p50 about 260 ms, 0
failures. Every download matched its checksum. Your numbers will differ, and Google's own throughput will dominate with real
accounts.

The request limit per address is `RATE_LIMIT_PER_MINUTE` (default 1200). A burst above it gets `429 Too Many Requests` with a
`Retry-After` header rather than an error; raise it only if you genuinely need more.
