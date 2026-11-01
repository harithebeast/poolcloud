# Threat model

Scope: a self-hosted PoolDrive installation used by one person or a small group, reachable from a browser, with Google
Drive accounts as the backing store. The mindset is OWASP ASVS Level 2.

## Assets

| Asset                                  | Why it matters                                           |
| -------------------------------------- | -------------------------------------------------------- |
| File contents                          | The point of the product                                 |
| Google refresh tokens                  | Full `drive.file` access to each linked account          |
| Master encryption keys (`MASTER_KEYS`) | Decrypt every encrypted file; losing them loses the data |
| User passwords and session tokens      | Account takeover                                         |
| The metadata database                  | File names and structure; the only map to the blobs      |

## Trust boundaries

Browser to API (untrusted client) · public share visitor to API (anonymous) · API to Google (credentials) · API to
Postgres/Redis (trusted network) · operator to host (`.env`, backups).

## Threats and controls

| Threat                                               | Control                                                                                                                                            | Residual risk                                                                  |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Password guessing and credential stuffing            | Argon2id, per-account and per-address throttling, uniform error and timing for unknown emails, global rate limit                                   | Distributed attacks below the per-account limit; TOTP is only a stub in v1     |
| Session theft                                        | httpOnly, SameSite=Lax, Secure in production cookies; only a hash of the token is stored; 7-day expiry; logout deletes the session                 | Malware on the user's machine                                                  |
| CSRF                                                 | Per-session HMAC token header on every state-changing request, `Origin` check, SameSite=Lax                                                        |                                                                                |
| XSS via uploaded files                               | Only an allowlist of types renders inline (never HTML or SVG); everything else downloads; `nosniff` and a `sandbox` CSP on every content response  | A browser bug in an allowlisted viewer such as the PDF viewer                  |
| Access to other users' files                         | Every query is scoped by owner id; foreign ids return 404; tests cover files, trash, shares, alerts                                                | Application bugs; covered by tests, not formally verified                      |
| Share-link guessing                                  | 256-bit random tokens, stored hashed, constant 404 for unknown/expired/revoked, password attempts throttled, optional expiry and revocation        | Anyone who holds a link can use it until it expires or is revoked              |
| Theft of the database                                | Refresh tokens and per-file keys are encrypted with the master key; sessions and share tokens are stored as hashes; passwords are Argon2id         | File names and structure are readable. Encrypt the volume and backups          |
| Theft of the `.env` file                             | Secrets only in the environment, never in the repository or logs; `.env` is git-ignored; gitleaks runs in CI                                       | Whoever reads `.env` has the master key. Protect the host                      |
| Theft of Google Drive data directly                  | Blobs have random names, no folder structure, and no real file names. Files marked encrypted are AES-256-GCM, so Drive holds ciphertext            | Unencrypted files are readable by anyone with access to the Drive account      |
| Tampering with stored blobs                          | SHA-256 per chunk; GCM authentication with file id, index and last-flag bound into the tag; a failed check aborts the download                     | An attacker who can delete a blob can make a file unavailable                  |
| Forged or replayed OAuth callback                    | Signed `state` (HMAC, 10-minute expiry, bound to the user) plus a nonce cookie bound to the browser; the callback requires the same session        |                                                                                |
| Linking the wrong Google account when re-authorising | The returned account id must match the account being repaired                                                                                      |                                                                                |
| Resource exhaustion by uploads                       | Streaming with bounded memory (measured), declared size enforced, pool capacity checked first, reservations prevent oversubscription               | A user with a valid session can fill the pool; quotas per user are future work |
| Orphaned or leaked blobs after crashes               | Outbox written before upload, atomic metadata commit, worker cleanup, report-only orphan scan                                                      | Orphans can exist until the worker runs; the scan never auto-deletes           |
| Secrets in logs                                      | Redaction of cookies, authorization and password fields; keys and plaintext are never logged; errors from Google are mapped, not echoed to clients | Debug-level logs should still be treated as sensitive                          |
| Vulnerable dependencies                              | `pnpm audit` and gitleaks in CI, pinned lockfile                                                                                                   | Zero-days                                                                      |

## Explicit non-goals for v1

- Redundancy: losing access to an account makes the files that touch it unavailable.
- Protection from the server operator: the server holds the master key and sees plaintext in memory while serving.
- Multi-factor authentication beyond the reserved TOTP hook.
- Per-user quotas and abuse reporting.

## Operator checklist

1. Serve over HTTPS and set `NODE_ENV=production` so cookies are `Secure` and API docs are off.
2. Back up `MASTER_KEYS` somewhere separate from the database backup. Losing it makes encrypted files unrecoverable.
3. Keep `/metrics` internal, or set `METRICS_TOKEN`.
4. Restrict who can read `.env`, and encrypt the disk holding Postgres.
5. Publish the Google consent screen to avoid weekly token expiry (see `google-setup.md`).
