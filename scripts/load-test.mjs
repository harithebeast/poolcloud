#!/usr/bin/env node
/**
 * Load test for a running PoolDrive API.
 *
 * Signs in, uploads many files concurrently, lists them, downloads every one and checks its SHA-256,
 * then reports throughput, latency percentiles and error counts. Exits non-zero on any failed
 * request or any download that differs from what was uploaded.
 *
 *   E2E_EMAIL=you@example.com E2E_PASSWORD=... node scripts/load-test.mjs
 *
 * Settings (environment): API_URL (default http://localhost:4400/api/v1), FILES (default 100),
 * SIZE_KB (default 256), CONCURRENCY (default 8), ENCRYPT (default false), CLEANUP (default true:
 * the test files are moved to the trash and purged afterwards).
 *
 * Run it against the fake-storage test stack, or against your own pool (it creates and then removes
 * a folder named "load-test-<time>", and uses real quota while it runs).
 */
import { createHash, randomUUID } from 'node:crypto';

const API = process.env.API_URL ?? 'http://localhost:4400/api/v1';
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const FILES = Number(process.env.FILES ?? 100);
const SIZE = Math.round(Number(process.env.SIZE_KB ?? 256) * 1024);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const ENCRYPT = process.env.ENCRYPT === 'true';
const CLEANUP = process.env.CLEANUP !== 'false';

if (!EMAIL || !PASSWORD) {
  console.error('Set E2E_EMAIL and E2E_PASSWORD (the account to test with).');
  process.exit(2);
}

let cookie = '';
let csrf = '';
const latencies = { upload: [], download: [], list: [] };
const failures = [];

async function call(method, path, { body, headers = {}, raw = false } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { cookie, ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}), ...headers },
    body,
  });
  if (raw) return res;
  const text = await res.text();
  const json = text ? JSON.parse(text) : {};
  if (!res.ok)
    throw new Error(`${method} ${path} -> ${res.status} ${json.message ?? text.slice(0, 120)}`);
  return json;
}

async function login() {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status}): check E2E_EMAIL / E2E_PASSWORD`);
  csrf = (await res.json()).csrfToken;
  cookie = res.headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
}

/** Deterministic content so a download can be checked without keeping every file in memory. */
function content(i) {
  const buf = Buffer.alloc(SIZE);
  let h = createHash('sha256').update(`load-${i}`).digest();
  for (let o = 0; o < SIZE; o += h.length) {
    h.copy(buf, o, 0, Math.min(h.length, SIZE - o));
    h = createHash('sha256').update(h).digest();
  }
  return buf;
}

const sha = (b) => createHash('sha256').update(b).digest('hex');
const pct = (arr, p) => {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

/** Run `tasks` with at most `limit` in flight. */
async function pool(tasks, limit) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, tasks.length) }, async () => {
      while (next < tasks.length) await tasks[next++]();
    }),
  );
}

async function timed(kind, fn) {
  const t = performance.now();
  try {
    return await fn();
  } catch (err) {
    failures.push(`${kind}: ${err.message}`);
    return undefined;
  } finally {
    latencies[kind].push(performance.now() - t);
  }
}

await login();
const folder = await call('POST', '/folders', {
  body: JSON.stringify({ name: `load-test-${Date.now()}`, parentId: null }),
  headers: { 'content-type': 'application/json' },
});
console.log(
  `Uploading ${FILES} files of ${(SIZE / 1024).toFixed(0)} KB (${CONCURRENCY} at a time${ENCRYPT ? ', encrypted' : ''})...`,
);

const ids = new Map();
const started = performance.now();
await pool(
  Array.from({ length: FILES }, (_, i) => async () => {
    const data = content(i);
    const node = await timed('upload', () =>
      call(
        'POST',
        `/files/upload?name=f${String(i).padStart(5, '0')}.bin&parentId=${folder.id}&encrypt=${ENCRYPT}`,
        {
          body: data,
          headers: { 'content-type': 'application/octet-stream', 'idempotency-key': randomUUID() },
        },
      ),
    );
    if (node) ids.set(i, { id: node.id, digest: sha(data) });
  }),
  CONCURRENCY,
);
const uploadSeconds = (performance.now() - started) / 1000;

await timed('list', async () => {
  const { items } = await call('GET', `/files?parentId=${folder.id}`);
  if (items.length !== ids.size)
    throw new Error(`listing shows ${items.length} files, expected ${ids.size}`);
});

const dlStarted = performance.now();
let mismatches = 0;
await pool(
  [...ids.entries()].map(([i, { id, digest }]) => async () => {
    await timed('download', async () => {
      const res = await call('GET', `/files/${id}/content`, { raw: true });
      if (!res.ok) throw new Error(`GET content -> ${res.status}`);
      if (sha(Buffer.from(await res.arrayBuffer())) !== digest) {
        mismatches += 1;
        throw new Error(`file ${i} downloaded with different bytes`);
      }
    });
  }),
  CONCURRENCY,
);
const downloadSeconds = (performance.now() - dlStarted) / 1000;

if (CLEANUP) {
  await call('DELETE', `/files/${folder.id}`).catch((e) => failures.push(`cleanup: ${e.message}`));
  await call('DELETE', `/trash/${folder.id}`).catch((e) => failures.push(`cleanup: ${e.message}`));
}

const mb = (FILES * SIZE) / 1024 / 1024;
const line = (name, arr, seconds) =>
  `${name.padEnd(9)} ${String(arr.length).padStart(5)} requests  p50 ${pct(arr, 50).toFixed(0).padStart(5)} ms  p95 ${pct(arr, 95).toFixed(0).padStart(5)} ms  p99 ${pct(arr, 99).toFixed(0).padStart(5)} ms${
    seconds ? `  ${(mb / seconds).toFixed(1)} MB/s` : ''
  }`;
console.log('');
console.log(line('upload', latencies.upload, uploadSeconds));
console.log(line('download', latencies.download, downloadSeconds));
console.log(line('list', latencies.list));
console.log('');
console.log(
  `uploaded ${ids.size}/${FILES}, byte mismatches ${mismatches}, failed requests ${failures.length}`,
);
for (const f of failures.slice(0, 10)) console.log(`  - ${f}`);
console.log(failures.length === 0 && ids.size === FILES ? 'PASS' : 'FAIL');
process.exit(failures.length === 0 && ids.size === FILES ? 0 : 1);
