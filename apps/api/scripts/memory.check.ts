/**
 * Streams a large file through the real HTTP API and measures the process's peak RSS.
 *
 *   TEST_DATABASE_URL=postgres://test:test@localhost:55432/test pnpm --filter @pooldrive/api test:memory
 *   SIZE_GB=5 (default) | LIMIT_MB=300 (default) | MODES=plain,encrypted (default)
 *
 * Runs under Vitest (SWC) because Nest needs decorator metadata, which esbuild/tsx does not emit.
 *
 * Server and client share this process, so the figure is an upper bound for the API alone. Bytes
 * are produced and checked on the fly (SHA-256), and storage is a disk-backed provider, so nothing
 * here can hide a buffering bug by holding the file in memory.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { DiskProvider } from '../src/testing/disk-provider.js';
import { createHarness } from '../src/testing/http-harness.js';

const url = process.env.TEST_DATABASE_URL;
const SIZE = Math.round(Number(process.env.SIZE_GB ?? 5) * 1024 ** 3);
const LIMIT = Number(process.env.LIMIT_MB ?? 300) * 1024 * 1024;
const MODES = (process.env.MODES ?? 'plain,encrypted').split(',');
const PIECE = 1024 * 1024;
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;

/** Deterministic, incompressible-enough bytes, generated lazily one MiB at a time. */
function source(total: number, hash: ReturnType<typeof createHash>): Readable {
  const seed = Buffer.alloc(PIECE);
  for (let i = 0; i < PIECE; i++) seed[i] = (i * 2654435761) >>> 24;
  let sent = 0;
  let n = 0;
  return new Readable({
    read() {
      if (sent >= total) return void this.push(null);
      const len = Math.min(PIECE, total - sent);
      const piece = Buffer.from(seed.subarray(0, len));
      piece.writeUInt32LE(n++, 0);
      sent += len;
      hash.update(piece);
      this.push(piece);
    },
  });
}

function request(port: number, opts: http.RequestOptions, body?: Readable) {
  return new Promise<http.IncomingMessage>((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, ...opts }, resolve);
    req.on('error', reject);
    if (body) body.pipe(req);
    else req.end();
  });
}

async function readJson(res: http.IncomingMessage): Promise<Record<string, unknown>> {
  const parts: Buffer[] = [];
  for await (const p of res) parts.push(p as Buffer);
  return JSON.parse(Buffer.concat(parts).toString('utf8')) as Record<string, unknown>;
}

async function run(mode: string): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), 'pooldrive-5gb-'));
  const encrypt = mode === 'encrypted';
  const accounts = 3;
  const perAccount = Math.ceil((SIZE * (encrypt ? 1.01 : 1)) / 2) + 1024 ** 3; // 3 accounts, split across them
  const h = await createHarness(url!, {
    // Production defaults: 64 MiB plain chunks, 16 MiB encrypted records.
    settings: {
      chunkSize: 64 * 1024 * 1024,
      encryptedChunkSize: 16 * 1024 * 1024,
      headroom: { percent: 0, minBytes: 0 },
    },
    providerFor: (i, spec) => new DiskProvider(join(dir, `acct-${i}`), spec.limit),
  });
  let peak = 0;
  const sampler = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 25);
  try {
    const owner = await h.login(`mem-${mode}@x.io`, true);
    for (let i = 0; i < accounts; i++) await h.linkAccount(owner, { limit: perAccount });
    await h.app.listen({ port: 0, host: '127.0.0.1' });
    const port = (h.app.getHttpServer().address() as { port: number }).port;
    const cookie = `pd_sid=${owner.cookie}`;

    global.gc?.();
    const baseline = process.memoryUsage().rss;
    peak = baseline;
    console.log(
      `\n[${mode}] ${mb(SIZE)} across ${accounts} accounts; baseline RSS ${mb(baseline)}`,
    );

    // Upload
    const sent = createHash('sha256');
    let t = Date.now();
    const upRes = await request(
      port,
      {
        method: 'POST',
        path: `/files/upload?name=big.bin&encrypt=${encrypt}`,
        headers: {
          cookie,
          'x-csrf-token': owner.csrf,
          'content-type': 'application/octet-stream',
          'content-length': SIZE,
          'idempotency-key': `mem-check-${mode}-0001`,
        },
      },
      source(SIZE, sent),
    );
    const node = await readJson(upRes);
    if (upRes.statusCode !== 201)
      throw new Error(`upload failed: ${upRes.statusCode} ${JSON.stringify(node)}`);
    const upSeconds = (Date.now() - t) / 1000;
    const upPeak = peak;
    console.log(
      `  upload   ${upSeconds.toFixed(1)}s (${(SIZE / 1024 ** 2 / upSeconds).toFixed(0)} MB/s)  peak RSS ${mb(upPeak)}`,
    );

    // Download and verify the bytes
    t = Date.now();
    const dlRes = await request(port, {
      method: 'GET',
      path: `/files/${node.id}/content?download=1`,
      headers: { cookie },
    });
    if (dlRes.statusCode !== 200) throw new Error(`download failed: ${dlRes.statusCode}`);
    const got = createHash('sha256');
    let bytes = 0;
    for await (const p of dlRes) {
      got.update(p as Buffer);
      bytes += (p as Buffer).length;
    }
    const dlSeconds = (Date.now() - t) / 1000;
    console.log(
      `  download ${dlSeconds.toFixed(1)}s (${(SIZE / 1024 ** 2 / dlSeconds).toFixed(0)} MB/s)  peak RSS ${mb(peak)}`,
    );

    const identical = bytes === SIZE && got.digest('hex') === sent.digest('hex');
    const withinBudget = peak <= LIMIT;
    console.log(
      `  bytes identical: ${identical ? 'yes' : 'NO'}   peak RSS ${mb(peak)} (limit ${mb(LIMIT)}): ${withinBudget ? 'OK' : 'OVER'}`,
    );
    return identical && withinBudget;
  } finally {
    clearInterval(sampler);
    await h.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!url)(
  `streaming ${process.env.SIZE_GB ?? 5} GB within ${LIMIT / 1024 / 1024} MB RSS`,
  () => {
    for (const mode of MODES) {
      it(
        `${mode}: uploads and downloads byte-for-byte`,
        async () => {
          expect(await run(mode)).toBe(true);
        },
        30 * 60_000,
      );
    }
  },
);
