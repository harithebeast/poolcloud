import type { Readable } from 'node:stream';
import { ByteReader } from './byte-reader.js';
import { ProviderAuthError, ProviderUnavailableError, StorageError } from './errors.js';
import { retry, type RetryOptions } from './resilience.js';

const UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
/** Drive requires pieces to be multiples of 256 KiB (except the last). */
export const PIECE_BYTES = 8 * 1024 * 1024;

export interface ResumableDeps {
  fetch: typeof fetch;
  accessToken: () => Promise<string>;
  retry: Pick<RetryOptions, 'retries' | 'baseMs' | 'maxMs' | 'sleep' | 'random'>;
  pieceBytes?: number;
}

class TransientHttpError extends Error {
  constructor(readonly status: number) {
    super(`Drive upload responded ${status}`);
  }
}

/**
 * Drive resumable upload with bounded memory: one piece (<= 8 MiB) is held at a time, so a dropped
 * connection resumes from the offset Drive reports instead of restarting the whole blob.
 */
export class ResumableUploader {
  constructor(private readonly deps: ResumableDeps) {}

  async upload(
    meta: { id: string; name: string; parentId: string },
    data: Readable,
    size: number,
  ): Promise<void> {
    try {
      await this.run(meta, data, size);
    } catch (err) {
      if (err instanceof TransientHttpError || isNetworkError(err)) {
        throw new ProviderUnavailableError(`Drive upload kept failing: ${(err as Error).message}`);
      }
      throw err;
    }
  }

  private async run(
    meta: { id: string; name: string; parentId: string },
    data: Readable,
    size: number,
  ): Promise<void> {
    const session = await this.start(meta, size);
    const reader = new ByteReader(data);
    const pieceBytes = this.deps.pieceBytes ?? PIECE_BYTES;

    if (size === 0) {
      await reader.assertEnd();
      await this.putPiece(session, Buffer.alloc(0), 0, 0);
      return;
    }
    let offset = 0;
    while (offset < size) {
      const piece = await reader.readExact(Math.min(pieceBytes, size - offset));
      await this.putPiece(session, piece, offset, size);
      offset += piece.length;
    }
    await reader.assertEnd();
  }

  private async start(
    meta: { id: string; name: string; parentId: string },
    size: number,
  ): Promise<string> {
    const res = await this.call(async (token) =>
      this.deps.fetch(`${UPLOAD_URL}?uploadType=resumable&supportsAllDrives=false`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=UTF-8',
          'x-upload-content-type': 'application/octet-stream',
          'x-upload-content-length': String(size),
        },
        body: JSON.stringify({ id: meta.id, name: meta.name, parents: [meta.parentId] }),
      }),
    );
    const location = res.headers.get('location');
    if (!location) throw new StorageError('Drive did not return a resumable session URL');
    return location;
  }

  private async putPiece(
    session: string,
    piece: Buffer,
    offset: number,
    total: number,
  ): Promise<void> {
    let sent = 0; // bytes of this piece Drive has confirmed
    await retry(
      async () => {
        const body = piece.subarray(sent);
        const start = offset + sent;
        const range =
          total === 0
            ? '*/0'
            : `${body.length ? `${start}-${start + body.length - 1}` : '*'}/${total}`;
        let res: Response;
        try {
          res = await this.deps.fetch(session, {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${await this.deps.accessToken()}`,
              'content-range': `bytes ${range}`,
              'content-length': String(body.length),
            },
            body: body.length ? (body as unknown as BodyInit) : undefined,
          });
        } catch (err) {
          sent = await this.confirmedBytes(session, offset, total, sent);
          throw err;
        }
        if (res.status === 200 || res.status === 201 || res.status === 308) return;
        await this.throwFor(res);
      },
      {
        ...this.deps.retry,
        shouldRetry: (e) => e instanceof TransientHttpError || isNetworkError(e),
      },
    );
  }

  /** Ask Drive how much it has received so a retry resends only the missing tail of this piece. */
  private async confirmedBytes(
    session: string,
    offset: number,
    total: number,
    fallback: number,
  ): Promise<number> {
    try {
      const res = await this.deps.fetch(session, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${await this.deps.accessToken()}`,
          'content-range': `bytes */${total}`,
          'content-length': '0',
        },
      });
      const received = /bytes=0-(\d+)/.exec(res.headers.get('range') ?? '');
      return received ? Math.max(fallback, Number(received[1]) + 1 - offset) : fallback;
    } catch {
      return fallback;
    }
  }

  private async call(fn: (token: string) => Promise<Response>): Promise<Response> {
    return retry(
      async () => {
        const res = await fn(await this.deps.accessToken());
        if (res.ok) return res;
        return this.throwFor(res);
      },
      {
        ...this.deps.retry,
        shouldRetry: (e) => e instanceof TransientHttpError || isNetworkError(e),
      },
    );
  }

  private async throwFor(res: Response): Promise<never> {
    const { status } = res;
    if (status === 401) throw new ProviderAuthError('Google authorisation was revoked or expired');
    if (status === 429 || status >= 500) throw new TransientHttpError(status);
    if (status === 403) {
      const body = await res.text().catch(() => '');
      if (/rateLimitExceeded|userRateLimitExceeded/.test(body))
        throw new TransientHttpError(status);
    }
    throw new StorageError(`Drive upload failed with status ${status}`);
  }
}

function isNetworkError(err: unknown): boolean {
  return (
    err instanceof TypeError ||
    (err instanceof Error && /ECONNRESET|ETIMEDOUT|EPIPE|fetch failed/.test(err.message))
  );
}
