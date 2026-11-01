# PoolDrive

Link several Google Drive accounts and use them as one storage pool with a Google Drive–style UI. Files that do not fit in a single account are split into chunks across accounts and reassembled on download.

> Status: **Phase 3 (UI) complete**: sign-in and first-run setup, a Drive-style file browser (grid/list, multi-select, drag and drop, preview, details), trash, sharing, the storage page with the pooled bar and Google account linking, dark mode. Hardening (Phase 4) is next. See [docs/PLAN.md](docs/PLAN.md) for the plan, risks and phases.

## Quickstart

Requires Docker (Compose v2) and Node 22 (only for the one-off secret generator).

```sh
node scripts/init-env.mjs   # creates .env with generated secrets (back up MASTER_KEYS!)
docker compose up --build   # web :3000, api :4000, worker, postgres, redis
```

- Web app: http://localhost:3000 (the first visitor creates the admin account)
- API health: http://localhost:4000/health/ready · metrics: `/metrics`
- API reference (outside production): http://localhost:4000/docs
- Linking real Google accounts: [docs/google-setup.md](docs/google-setup.md). To try things without Google, set `STORAGE_PROVIDER=fake` in `.env` (in-memory accounts, lost on restart; run no separate worker in this mode).

## Development

```sh
corepack enable && pnpm install
pnpm lint && pnpm format:check && pnpm typecheck && pnpm build
pnpm test                    # unit tests; database-backed tests skip without TEST_DATABASE_URL
```

Database-backed tests (most of the API) need a Postgres where the user may `CREATE DATABASE`; each test file gets its own throwaway database.

```sh
docker run -d --rm --name pooldrive-test-pg -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test -e POSTGRES_DB=test -p 55432:5432 postgres:17-alpine
export TEST_DATABASE_URL=postgres://test:test@localhost:55432/test
pnpm --filter @pooldrive/api test:ci            # full suite + coverage gate (80%)
SIZE_GB=1 pnpm --filter @pooldrive/api test:memory   # streams N GB through the API and checks peak RSS (default 5 GB, limit 300 MB)
```

| Path              | What                                                                                                                           |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `apps/api`        | NestJS (Fastify) API, storage core, Drizzle schema, job logic                                                                  |
| `apps/worker`     | BullMQ process that runs the scheduled jobs                                                                                    |
| `apps/web`        | Next.js UI                                                                                                                     |
| `packages/shared` | Config schema and domain types                                                                                                 |
| `docs`            | Plan, [architecture](docs/architecture.md), [threat model](docs/threat-model.md), [runbook](docs/runbook.md), [ADRs](docs/adr) |
