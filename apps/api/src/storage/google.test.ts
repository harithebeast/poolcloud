import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  ProviderAuthError,
  ProviderUnavailableError,
  RemoteNotFoundError,
  StorageError,
} from './errors.js';
import { isRetryableGoogleError, mapGoogleError } from './google-errors.js';
import { ResumableUploader } from './google-resumable.js';
import { patterned } from './testing/harness.js';

describe('Google error mapping', () => {
  it('maps revoked/expired credentials to ProviderAuthError and never retries them', () => {
    const invalidGrant = { response: { status: 400, data: { error: 'invalid_grant' } } };
    expect(mapGoogleError(invalidGrant)).toBeInstanceOf(ProviderAuthError);
    expect(mapGoogleError({ code: 401 })).toBeInstanceOf(ProviderAuthError);
    expect(isRetryableGoogleError(invalidGrant)).toBe(false);
  });

  it('treats rate limits, 5xx and network errors as retryable', () => {
    const rate = { code: 403, errors: [{ reason: 'userRateLimitExceeded' }] };
    expect(isRetryableGoogleError(rate)).toBe(true);
    expect(isRetryableGoogleError({ response: { status: 429 } })).toBe(true);
    expect(isRetryableGoogleError({ code: 503 })).toBe(true);
    expect(isRetryableGoogleError({ code: 'ECONNRESET' })).toBe(true);
    expect(mapGoogleError(rate)).toBeInstanceOf(ProviderUnavailableError);
  });

  it('does not retry a full account or a permission error', () => {
    const full = { code: 403, errors: [{ reason: 'storageQuotaExceeded' }] };
    expect(isRetryableGoogleError(full)).toBe(false);
    expect(mapGoogleError(full)).toBeInstanceOf(StorageError);
    expect(mapGoogleError(full)).not.toBeInstanceOf(ProviderUnavailableError);
  });

  it('maps 404 to RemoteNotFoundError and passes through domain errors and unknowns', () => {
    expect(mapGoogleError({ code: 404 })).toBeInstanceOf(RemoteNotFoundError);
    const own = new ProviderAuthError('x');
    expect(mapGoogleError(own)).toBe(own);
    expect(mapGoogleError(undefined)).toBeInstanceOf(StorageError);
    expect(isRetryableGoogleError(null)).toBe(false);
  });
});

describe('ResumableUploader', () => {
  type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

  function harness(handler: Handler, pieceBytes = 256) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = ((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(handler(url, init));
    }) as unknown as typeof fetch;
    const uploader = new ResumableUploader({
      fetch: fakeFetch,
      accessToken: () => Promise.resolve('tok'),
      retry: { retries: 3, baseMs: 1, maxMs: 1, sleep: () => Promise.resolve(), random: () => 0 },
      pieceBytes,
    });
    return { uploader, calls };
  }

  const meta = { id: 'rid', name: 'uuid-name', parentId: 'folder' };
  const session = (url: string) =>
    url.includes('uploadType=resumable')
      ? new Response(null, { status: 200, headers: { location: 'https://upload/session' } })
      : undefined;
  const header = (init: RequestInit, name: string) =>
    (init.headers as Record<string, string>)[name];

  it('creates a session with the pre-allocated id and an opaque name, then sends bounded pieces', async () => {
    const received: Buffer[] = [];
    const { uploader, calls } = harness((url, init) => {
      const s = session(url);
      if (s) return s;
      received.push(Buffer.from(init.body as Uint8Array));
      return new Response(null, { status: received.length === 3 ? 200 : 308 });
    });
    const data = patterned(600);
    await uploader.upload(meta, Readable.from([data]), 600);

    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({
      id: 'rid',
      name: 'uuid-name',
      parents: ['folder'],
    });
    expect(header(calls[0]!.init, 'x-upload-content-length')).toBe('600');
    expect(received.map((b) => b.length)).toEqual([256, 256, 88]);
    expect(Buffer.concat(received)).toEqual(data);
    expect(header(calls[3]!.init, 'content-range')).toBe('bytes 512-599/600');
    expect(header(calls[1]!.init, 'authorization')).toBe('Bearer tok');
  });

  it('retries a throttled piece with backoff instead of failing the upload', async () => {
    let failures = 2;
    const { uploader } = harness((url) => {
      const s = session(url);
      if (s) return s;
      return failures-- > 0
        ? new Response('{}', { status: 503 })
        : new Response(null, { status: 200 });
    });
    await expect(
      uploader.upload(meta, Readable.from([patterned(100)]), 100),
    ).resolves.toBeUndefined();
  });

  it('resumes from the offset Drive reports after a dropped connection', async () => {
    const bodies: number[] = [];
    let dropped = false;
    const { uploader, calls } = harness((url, init) => {
      const s = session(url);
      if (s) return s;
      const range = header(init, 'content-range')!;
      if (range.startsWith('bytes */')) {
        return new Response(null, { status: 308, headers: { range: 'bytes=0-149' } });
      }
      if (!dropped) {
        dropped = true;
        throw new TypeError('fetch failed');
      }
      bodies.push((init.body as Uint8Array).length);
      return new Response(null, { status: 200 });
    });
    await uploader.upload(meta, Readable.from([patterned(200)]), 200);

    expect(bodies).toEqual([50]); // only the missing tail is resent
    expect(header(calls.at(-1)!.init, 'content-range')).toBe('bytes 150-199/200');
  });

  it('fails fast with ProviderAuthError on 401 and gives up with ProviderUnavailableError', async () => {
    const auth = harness((url) => session(url) ?? new Response(null, { status: 401 }));
    await expect(
      auth.uploader.upload(meta, Readable.from([patterned(10)]), 10),
    ).rejects.toBeInstanceOf(ProviderAuthError);
    expect(auth.calls).toHaveLength(2);

    const down = harness((url) => session(url) ?? new Response(null, { status: 500 }));
    await expect(
      down.uploader.upload(meta, Readable.from([patterned(10)]), 10),
    ).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it('does not retry a full account (403 quota)', async () => {
    const { uploader, calls } = harness(
      (url) =>
        session(url) ??
        new Response('{"error":{"errors":[{"reason":"storageQuotaExceeded"}]}}', { status: 403 }),
    );
    const err = await uploader
      .upload(meta, Readable.from([patterned(10)]), 10)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StorageError);
    expect(err).not.toBeInstanceOf(ProviderUnavailableError);
    expect(calls).toHaveLength(2);
  });

  it('uploads empty blobs', async () => {
    const { uploader, calls } = harness(
      (url) => session(url) ?? new Response(null, { status: 200 }),
    );
    await uploader.upload(meta, Readable.from([]), 0);
    expect(header(calls[1]!.init, 'content-range')).toBe('bytes */0');
  });

  it('rejects when the stream is shorter than declared', async () => {
    const { uploader } = harness((url) => session(url) ?? new Response(null, { status: 308 }));
    await expect(uploader.upload(meta, Readable.from([patterned(10)]), 20)).rejects.toBeInstanceOf(
      StorageError,
    );
  });
});
