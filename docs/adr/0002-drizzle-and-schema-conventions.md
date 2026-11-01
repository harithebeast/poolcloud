# ADR-0002: Drizzle ORM, bigint-as-number, partial unique index for names

**Status:** accepted (Phase 0)

**Decision.**

- Drizzle ORM + `drizzle-kit` SQL migrations, applied by `dist/db/migrate.js` before the API starts (the API container runs it in its start command).
- Byte counts use Postgres `bigint` mapped to JS `number`. Safe up to 2^53 (~9 PB), far beyond a pool of consumer Drive accounts.
- Name uniqueness: partial unique index `(owner_id, coalesce(parent_id, <zero-uuid>), name) WHERE trashed_at IS NULL`. The `coalesce` makes root-level names unique (plain NULLs are distinct in unique indexes); trashed nodes do not block reuse of a name.
- Every domain row carries `owner_id`; all queries must filter by it (multi-tenancy readiness).
- `remote_cleanup` is an outbox written **before** any remote upload starts, so a crash can never leak an untracked remote blob.
