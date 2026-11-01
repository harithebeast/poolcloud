# ADR-0004: Envelope encryption with per-chunk AES-256-GCM

**Status:** accepted (design; implemented in Phase 1)

**Decision.**

- Per-file random 256-bit data key (DEK), wrapped with the active master key (AES-256-GCM, AAD = file id). `nodes.key_id` records which master key wrapped it, enabling rotation by re-wrapping DEKs only (no blob rewrite).
- Each chunk is encrypted with the DEK and a fresh random 96-bit nonce. AAD = `fileId | chunkIndex | isLast`, so chunks cannot be reordered, swapped between files, or truncated undetected. (A chunk count is not used because chunk sizes adapt to each account's remaining space, so the count is unknown when the first chunk is written.)
- The 16-byte GCM tag is appended to the stored chunk; `file_chunks.sha256` covers the **stored** bytes (detects remote corruption before decrypting); GCM detects tampering after.
- Master keys come only from `MASTER_KEYS` (`kid:base64`). Keys and plaintext are never logged.
- GCM must authenticate a whole record before releasing plaintext, so memory-bounded streaming requires records of bounded size. Therefore **encrypted** files larger than `CHUNK_SIZE_BYTES` are always split into chunk-size records, even if one account could hold the whole file. Unencrypted files keep the "whole unless it does not fit" rule. Encrypted files therefore do not support HTTP Range beyond chunk granularity in v1.

## Update (Phase 2): streaming encryption and record size

- **Upload** encrypts as a stream (`encryptChunkStream`): ciphertext pieces are hashed and uploaded as they are produced and the 16-byte tag, which GCM emits last, is appended. This is exactly the stored `ciphertext | tag` format, so nothing is buffered on upload.
- **Download** must hold one whole record, because the tag has to verify before any plaintext is released. To bound that, encrypted files are stored in records of at most `ENCRYPTED_CHUNK_BYTES` (default 16 MiB), separate from the 64 MiB `CHUNK_SIZE_BYTES` used for plain files. A download therefore holds roughly 2 x 16 MiB.
- Refresh tokens use the same master key ring (`sealSecret`/`openSecret`), with the owner and Google account id bound into the authenticated data so a token cannot be moved to another account's row.
