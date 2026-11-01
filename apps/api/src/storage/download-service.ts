import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { chunkAad, decryptChunk, type KeyRing } from './crypto.js';
import { FileUnavailableError, IntegrityError, ProviderAuthError, StorageError } from './errors.js';
import type { ByteRange, ProviderResolver } from './provider.js';
import type { AccountStore } from './stores.js';
import type { ChunkRecord, StoredFile } from './upload-service.js';

export class RangeNotSupportedError extends StorageError {}

/** Accounts we can still read from: DRAINING accounts are being emptied, not broken. */
const READABLE = new Set(['HEALTHY', 'DRAINING']);

export class DownloadService {
  constructor(
    private readonly deps: {
      accounts: AccountStore;
      providers: ProviderResolver;
      keyRing: KeyRing;
      /** Called when Google rejects an account's credentials, so it can be taken out of rotation. */
      onAuthFailure?: (accountId: string, reason: string) => Promise<void>;
    },
  ) {}

  /** Ranges are only served for single-chunk, unencrypted files (whole-file storage). */
  supportsRange(file: StoredFile): boolean {
    return file.chunks.length === 1 && !file.encryption;
  }

  /**
   * Stream the file in order, verifying each chunk's SHA-256 and (when encrypted) its GCM tag.
   * Fails fast, before any byte is sent, if a holding account is unavailable.
   */
  async open(ownerId: string, file: StoredFile, range?: ByteRange): Promise<Readable> {
    if (range && !this.supportsRange(file))
      throw new RangeNotSupportedError('range requests need a whole, unencrypted file');

    const status = new Map((await this.deps.accounts.list(ownerId)).map((a) => [a.id, a.status]));
    const offline = new Set<string>();
    for (const c of file.chunks) {
      const s = status.get(c.accountId);
      if (!s || !READABLE.has(s)) offline.add(c.accountId);
    }
    if (offline.size > 0) throw new FileUnavailableError(file.fileId, [...offline]);

    const dek = file.encryption ? this.deps.keyRing.unwrap(file.encryption, file.fileId) : null;
    if (range) {
      const only = file.chunks[0]!;
      return this.fetch(only, range);
    }
    // Open the first chunk now: auth, availability and not-found errors then surface before any
    // response bytes are sent, so the caller can still answer with a proper error status.
    const ordered = [...file.chunks].sort((a, b) => a.index - b.index);
    const first = ordered[0] ? await this.fetch(ordered[0]) : undefined;
    return Readable.from(this.stream(file, dek, ordered, first), { objectMode: false });
  }

  private async *stream(
    file: StoredFile,
    dek: Buffer | null,
    ordered: ChunkRecord[],
    first: Readable | undefined,
  ): AsyncGenerator<Buffer> {
    for (const [i, chunk] of ordered.entries()) {
      const source = i === 0 && first ? first : await this.fetch(chunk);
      yield* dek ? this.decrypted(file, chunk, dek, source) : this.verified(chunk, source);
    }
  }

  private async fetch(chunk: ChunkRecord, range?: ByteRange): Promise<Readable> {
    try {
      return await this.deps.providers(chunk.accountId).download(chunk.remoteId, range);
    } catch (err) {
      if (err instanceof ProviderAuthError) {
        await this.deps.onAuthFailure?.(chunk.accountId, err.message);
      }
      throw err;
    }
  }

  /** Streams straight through; a mismatch is raised when the chunk ends, aborting the response. */
  private async *verified(chunk: ChunkRecord, source: Readable): AsyncGenerator<Buffer> {
    const hash = createHash('sha256');
    let length = 0;
    for await (const piece of source) {
      const buf = piece as Buffer;
      hash.update(buf);
      length += buf.length;
      yield buf;
    }
    assertChunk(chunk, hash.digest('hex'), length);
  }

  /** GCM must verify before releasing plaintext, so a chunk (bounded size) is buffered. */
  private async *decrypted(
    file: StoredFile,
    chunk: ChunkRecord,
    dek: Buffer,
    source: Readable,
  ): AsyncGenerator<Buffer> {
    const stored = await readInto(source, chunk);
    assertChunk(chunk, createHash('sha256').update(stored).digest('hex'), stored.length);
    if (!chunk.nonce) throw new IntegrityError(`chunk ${chunk.index} is missing its nonce`);
    yield decryptChunk(
      dek,
      Buffer.from(chunk.nonce, 'base64'),
      stored,
      chunkAad(file.fileId, chunk.index, chunk.index === file.chunks.length - 1),
    );
  }
}

function assertChunk(chunk: ChunkRecord, sha256: string, length: number): void {
  if (length !== chunk.size || sha256 !== chunk.sha256) {
    throw new IntegrityError(
      `chunk ${chunk.index} failed its integrity check (stored data was altered or truncated)`,
    );
  }
}

/**
 * Collect one stored chunk into a single buffer sized from the database record, so a record costs
 * one allocation instead of a piece list plus a concatenated copy. A source that sends more than
 * recorded is cut short; the length/hash check then fails the chunk.
 */
async function readInto(source: Readable, chunk: ChunkRecord): Promise<Buffer> {
  const buf = Buffer.allocUnsafe(chunk.size);
  let filled = 0;
  for await (const piece of source) {
    const b = piece as Buffer;
    if (filled + b.length > buf.length) {
      source.destroy();
      throw new IntegrityError(
        `chunk ${chunk.index} failed its integrity check (stored data was altered or truncated)`,
      );
    }
    b.copy(buf, filled);
    filled += b.length;
  }
  return filled === buf.length ? buf : buf.subarray(0, filled);
}
