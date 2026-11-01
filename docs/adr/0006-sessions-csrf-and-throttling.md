# ADR-0006: Session cookies, CSRF and throttling

Status: accepted (Phase 2)

## Decision

- **Passwords:** Argon2id (19 MiB, 2 passes, 1 lane, the OWASP baseline). Unknown emails are verified against a dummy hash so timing does not reveal which emails exist.
- **Sessions:** a random 256-bit token in an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production). Only its SHA-256 is stored, so a database leak does not yield usable sessions. 7-day lifetime; the worker purges expired rows.
- **CSRF:** every state-changing request needs `X-CSRF-Token`, an HMAC of the session id under `SESSION_SECRET`, which the web app reads from `/auth/me`. Requests with a foreign `Origin` are refused. `SameSite=Lax` is the second layer.
- **Secure by default:** a global guard authenticates every route; only routes marked `@Public()` (login, setup, health, metrics, public share links) skip it. Admin routes are marked `@AdminOnly()`.
- **First run:** the first user becomes admin through `/auth/setup`, serialised with a Postgres advisory lock so two concurrent first requests cannot both win. There is no public sign-up; admins create users.
- **Throttling:** failed logins and share-password guesses are counted per account/token and per client address in Redis (10 per 15 minutes per account, 30 per address), plus a global 300 requests/minute limit.
- **TOTP:** `FEATURE_TOTP` and the `totp_secret_enc` column are reserved; the second factor is a stub in v1.

## Consequences

Stateless API processes (sessions in Postgres, counters in Redis). Logging in again is needed after 7 days. Changing `SESSION_SECRET` invalidates every CSRF token (users reload) but not sessions.
