# ADR-0005: Uploads are one streaming request with an idempotency key

Status: accepted (Phase 2)

## Context

The brief asks for streaming, resumable, idempotent uploads. The original outline had a multi-request protocol
(`POST /uploads`, `PUT /uploads/:id/parts/:n`, `complete`) so that a browser could resume after a dropped connection.

## Decision

An upload is a single `POST /files/upload` whose body is the file (`application/octet-stream`), with an
`Idempotency-Key` header. The request stream is handed to the storage core without buffering (a raw content-type
parser bypasses Fastify's body limit and buffering).

- **Idempotent:** the `uploads` table has a unique `(owner_id, idempotency_key)`. Retrying a finished upload returns the
  same file and stores nothing twice. A retry while the original is still running gets `409 upload_in_progress`. The same
  key with a different name/size/folder gets `422`. A failed or crashed (expired lock) upload can be retried and takes over.
- **Atomic:** nothing is visible until the node and its chunk map commit in one transaction. If the stream breaks, the
  size is wrong, the name collides or the commit fails, every remote blob written so far is deleted, or queued in the
  `remote_cleanup` outbox for the worker.
- **Resumable where it matters:** the Drive side uploads in 8 MiB pieces and resumes from the offset Drive reports.

## Consequences

- Simple and robust: no server-side part bookkeeping, no half-assembled uploads to expire.
- A browser that loses its connection restarts that file from byte 0 (safely, thanks to the key). If large uploads over
  unreliable links become important, add tus-style part uploads on top; the storage core already writes chunk by chunk.
- Memory is flat: measured at 206 MB (plain) and 261 MB (encrypted) peak RSS for 5 GB, including the test client.

## Alternatives considered

- Multi-request part protocol now: more state, more failure modes, and only helps flaky clients.
- Buffering to local disk first: doubles I/O and needs a disk budget in the container.
