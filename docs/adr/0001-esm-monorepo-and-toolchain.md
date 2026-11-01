# ADR-0001: ESM everywhere, TypeScript 6, pnpm workspaces

**Status:** accepted (Phase 0)

**Context.** NestJS 12, Drizzle and Next 16 are ESM-first; `@nestjs/common` 12 cannot be `require`d from CommonJS. TypeScript 7 (native) is installed by default but `typescript-eslint` does not yet support it.

**Decision.**

- Every package is `"type": "module"`, compiled with `module: Node16`; relative imports carry `.js` suffixes.
- TypeScript is pinned to `6.x` until `typescript-eslint` supports 7.
- `packages/shared` is built to `dist/` and consumed as a compiled workspace dependency (root `typecheck` builds it first).
- NestJS runs on the Fastify adapter (streaming-friendly, lower overhead for large uploads).
- Tests use Vitest; `unplugin-swc` is used where Nest decorators need metadata.

**Consequences.** Lint/typecheck are reproducible. Revisit the TS pin when typescript-eslint adds TS 7 support.
