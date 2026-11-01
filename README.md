# PoolDrive

Link several Google Drive accounts and use them as one storage pool with a Google Drive–style UI. Files that do not fit in a single account are split into chunks across accounts and reassembled on download.

> Status: **Phase 0 (foundations)** complete. See [docs/PLAN.md](docs/PLAN.md) for architecture, data model, risks and the phase plan.

## Quickstart

Requires Docker (Compose v2) and Node 22 (only for the one-off secret generator).

```sh
node scripts/init-env.mjs   # creates .env with generated secrets (back up MASTER_KEYS!)
docker compose up --build   # web :3000, api :4000, worker, postgres, redis
```

- Web: http://localhost:3000
- API health: http://localhost:4000/health/ready
- Linking real Google accounts: see `docs/google-setup.md` (Phase 4). For UI/dev work without Google, set `STORAGE_PROVIDER=fake` in `.env`.

## Development

```sh
corepack enable && pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

| Path              | What                                 |
| ----------------- | ------------------------------------ |
| `apps/api`        | NestJS (Fastify) API, Drizzle schema |
| `apps/worker`     | BullMQ background jobs               |
| `apps/web`        | Next.js UI                           |
| `packages/shared` | Config schema and domain types       |
| `docs/adr`        | Architecture decision records        |
