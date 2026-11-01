# ADR-0008: Removing an account moves its files first

Status: accepted (Phase 4)

## Context

An administrator may want to take a Google account out of the pool (it is being closed, it is nearly full of other data,
or it was linked by mistake). Simply forgetting the account would orphan every file piece stored in it. With no
redundancy in v1, that means silent data loss.

## Decision

Removal is a **migration**, not a delete.

1. `DELETE /accounts/:id` marks a healthy account `DRAINING`. It no longer receives new uploads, but it stays readable, so
   every file keeps working while it is being emptied. The request is refused up front if the other accounts do not have
   enough free space in total, if the account is offline (its files cannot be read), or if it is already being removed.
2. The worker job `drain` (every 30 seconds) moves pieces off the account, a batch at a time:
   - reserve space on another healthy account (same reservation mechanism as uploads),
   - allocate an id and record it in the cleanup outbox **before** writing,
   - stream the piece across while hashing it, and **refuse** to continue if the SHA-256 differs from the recorded one
     (so damage is never copied),
   - queue the old copy for deletion (delayed, so a download already in progress can finish),
   - repoint the chunk map with a compare-and-swap on the old location. If the file was purged or changed meanwhile the
     swap fails and the new copy is discarded.
3. Pieces are copied exactly as stored. Encrypted pieces stay encrypted and never need the master key; the authenticated
   data binds to the file and position, not to the account, so they remain valid.
4. When the account holds nothing, it becomes `DISCONNECTED` (shown as "Removed"). Its credentials are kept until the old
   copies have been deleted by the cleanup job, then the admin can revoke access at Google.
5. If progress is blocked (for example no single account can hold a large whole-file piece), the job raises a
   `removal_stuck` alert with a plain explanation and retries; adding space resumes it. The admin can cancel removal at any
   time, and pieces already moved simply stay where they are.

In `STORAGE_PROVIDER=fake` mode the API performs the moving inline, because the worker has its own empty in-memory
accounts and cannot see the API's.

## Consequences

- No data is ever deleted or unreferenced until a verified copy exists elsewhere.
- Large accounts take time (bounded by Drive throughput); progress is visible on the Storage page.
- A single piece larger than the free space of every other account cannot be moved (pieces are not re-split). The admin is
  told to add space. Re-splitting during migration is possible future work.
- An offline account cannot be removed until it is re-authorised, because its bytes cannot be read.

## Alternatives considered

- Delete the account row and mark its files unavailable: simple, but loses data silently.
- Re-split oversized whole-file pieces while moving: more flexible, but needs a streaming re-chunker with the same
  atomicity guarantees; not needed for the common case.
