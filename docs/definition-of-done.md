# Definition of done: checklist against the original brief

What each requirement is backed by, and what has **not** been verified. "Verified" means a command was run and its
result observed; commands are listed so anyone can repeat them.

## Required outcomes

| Requirement                                                                 | Status                    | Evidence / how to check                                                                                                                                                                  |
| --------------------------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker compose up` gives a usable site at <http://localhost:3000>          | Verified                  | `docker compose up --build -d`, then all five services report healthy; the first visitor creates the admin                                                                               |
| First-run admin setup, no public sign-up                                    | Verified                  | Browser test "first run: create the admin"; API test "only one of two concurrent first-run requests wins"                                                                                |
| Link 3 or more Google accounts, shown as one pooled bar                     | Verified with fake Google | Browser test "link three Google accounts and see one pooled bar". **Real Google not verified by the author**: it needs your own OAuth client and browser consent (see `google-setup.md`) |
| 3 accounts nearly full, 3 GB upload succeeds (scaled)                       | Verified                  | `apps/api/src/storage/scenarios.test.ts` and the HTTP/Postgres variants. Needs `HEADROOM_PERCENT=0`; with the default 5% a 3 GB file cannot fit (documented in `PLAN.md`)                |
| Optional AES-256-GCM with envelope keys and tamper detection                | Verified                  | Scenario (d) tests: flipped bits, swapped chunks, dropped last chunk, wrapped key moved to another file all fail; keys never logged                                                      |
| An account going offline degrades gracefully                                | Verified                  | Scenario (b) tests and HTTP variants: excluded from placement, affected files return 503 with an explanation, alert raised once, re-authorise restores them, metadata never deleted      |
| Crash or abort mid-upload leaves no partial file; remote chunks are cleaned | Verified                  | Scenario (c) tests: connection failure, failed commit, failed rollback then cleanup, hard crash reaped after the grace period                                                            |
| Removing an account migrates its data first                                 | Verified                  | `drain-service.test.ts` (10 scenarios) and `removal.http.test.ts` on real Postgres; browser test "remove a Google account"                                                               |
| Orphan detector (report only)                                               | Verified                  | `maintenance.test.ts`: reports unknown and missing blobs, never deletes                                                                                                                  |
| 5 GB upload and download within about 300 MB of memory                      | Verified                  | `pnpm --filter @pooldrive/api test:memory`: plain 206 MB, encrypted 261 MB peak, byte-identical (measured in one process with the test client)                                           |
| CI green with 80% coverage, build, audit, secret scan                       | Verified on GitHub        | The workflow completed successfully on the pushed commit. Locally: 93% lines / 84% branches over the API, `pnpm audit` clean, gitleaks clean                                             |
| Documentation                                                               | Done                      | README, `architecture.md`, `google-setup.md`, `runbook.md`, `threat-model.md`, `PLAN.md`, ADRs 0001-0008                                                                                 |
| No secrets in the repository; `.env.example` complete                       | Verified                  | gitleaks over the full history; `.env` is ignored                                                                                                                                        |

## Quality gates

| Gate                                           | Result                                                                                                |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| API tests (Postgres-backed)                    | 192 passing                                                                                           |
| Browser tests (Playwright)                     | 27 passing, including drag and drop, sharing, encryption, account removal                             |
| Accessibility (axe, WCAG 2 A/AA, light + dark) | No violations on any screen                                                                           |
| Accessibility (Lighthouse)                     | 100 on login, files, storage, trash and the share page                                                |
| Load test (`scripts/load-test.mjs`)            | 300 x 128 KB plain and 100 x 512 KB encrypted: 0 failures, 0 byte mismatches (numbers in the runbook) |

## Known limits (accepted for v1)

- No redundancy: a file split across accounts is unavailable while any account holding a piece is offline.
- Uploads are one streaming request; a dropped connection restarts that file (safely, without duplicates).
- Folder sharing, TOTP and bulk key re-wrapping are not implemented (TOTP and key rotation have hooks).
- A single whole-file piece larger than the free space of every other account cannot be migrated during account removal.
- The Google connection was built from Google's documentation and exercised against a stand-in; the first real link is the one
  step only you can confirm.
