# ADR-0003: Use the `drive.file` scope

**Status:** accepted (Phase 0)

**Context.** PoolDrive only ever reads and writes blobs it created itself, inside its own app folder in each account.

**Decision.** Request `https://www.googleapis.com/auth/drive.file` (plus `openid email` to identify the account). It is non-sensitive-adjacent, grants access only to files created by this OAuth client, and cannot see the user's other Drive content. `about.get` (quota) works with it.

**Consequences.**

- Re-authorising an account must use the same OAuth client ID, otherwise previously created blobs become invisible to the app.
- The orphan detector can only list files created by this app, which is exactly the set we care about.
- No Google app verification is needed for a handful of personal accounts; refresh tokens in "Testing" publishing status still expire after 7 days (see `docs/google-setup.md`).
