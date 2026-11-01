import { randomBytes, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { ByteReader } from './byte-reader.js';
import {
  KeyRing,
  chunkAad,
  decryptChunk,
  encryptChunk,
  generateDataKey,
  GCM_TAG_BYTES,
} from './crypto.js';
import { IntegrityError, SizeMismatchError } from './errors.js';
import { MemoryAccountStore } from './memory-stores.js';
import {
  MostFreeSpaceStrategy,
  availableBytes,
  headroomBytes,
  type PlacementCandidate,
} from './placement.js';
import { Semaphore, backoffDelay, retry } from './resilience.js';
import { pieces } from './testing/harness.js';

describe('crypto', () => {
  const key = generateDataKey();
  const aad = chunkAad('file', 0, true);

  it('round-trips and appends a 16-byte tag', () => {
    const plain = randomBytes(1000);
    const { nonce, data } = encryptChunk(key, plain, aad);
    expect(data.length).toBe(plain.length + GCM_TAG_BYTES);
    expect(decryptChunk(key, nonce, data, aad)).toEqual(plain);
  });

  it('uses a fresh nonce every time', () => {
    const nonces = new Set(
      Array.from({ length: 50 }, () =>
        encryptChunk(key, Buffer.from('x'), aad).nonce.toString('hex'),
      ),
    );
    expect(nonces.size).toBe(50);
  });

  it('rejects tampered data, wrong key, wrong aad and wrong nonce', () => {
    const { nonce, data } = encryptChunk(key, randomBytes(64), aad);
    const flipped = Buffer.from(data);
    flipped[3] = (flipped[3] ?? 0) ^ 1;
    expect(() => decryptChunk(key, nonce, flipped, aad)).toThrow(IntegrityError);
    expect(() => decryptChunk(generateDataKey(), nonce, data, aad)).toThrow(IntegrityError);
    expect(() => decryptChunk(key, nonce, data, chunkAad('file', 0, false))).toThrow(
      IntegrityError,
    );
    expect(() => decryptChunk(key, randomBytes(12), data, aad)).toThrow(IntegrityError);
    expect(() => decryptChunk(key, nonce, Buffer.alloc(5), aad)).toThrow(IntegrityError);
  });

  it('does not put key material in error messages', () => {
    try {
      decryptChunk(generateDataKey(), Buffer.alloc(12), Buffer.alloc(40), aad);
    } catch (e) {
      expect(String(e)).not.toMatch(/[0-9a-f]{32}/);
    }
  });

  describe('KeyRing', () => {
    const k = (n: number) => Buffer.alloc(32, n).toString('base64');

    it('wraps with the active key and unwraps with the matching key id after rotation', () => {
      const dek = generateDataKey();
      const old = KeyRing.parse(`k1:${k(1)}`);
      const wrapped = old.wrap(dek, 'f1');
      expect(wrapped.keyId).toBe('k1');

      const rotated = KeyRing.parse(`k2:${k(2)},k1:${k(1)}`);
      expect(rotated.activeKeyId).toBe('k2');
      expect(rotated.unwrap(wrapped, 'f1')).toEqual(dek);
      expect(rotated.wrap(dek, 'f1').keyId).toBe('k2');
    });

    it('fails for unknown key ids, other files, and malformed config', () => {
      const ring = KeyRing.parse(`k1:${k(1)}`);
      const wrapped = ring.wrap(generateDataKey(), 'f1');
      expect(() => ring.unwrap({ ...wrapped, keyId: 'gone' }, 'f1')).toThrow(IntegrityError);
      expect(() => ring.unwrap(wrapped, 'f2')).toThrow(IntegrityError);
      expect(() => KeyRing.parse('k1:short')).toThrow();
      expect(() => KeyRing.parse(`a:${k(1)},a:${k(2)}`)).toThrow(/Duplicate/);
    });
  });
});

describe('placement', () => {
  const policy = { percent: 2, minBytes: 100 };

  it('computes headroom as the larger of the percentage and the floor', () => {
    expect(headroomBytes(15_000, policy)).toBe(300);
    expect(headroomBytes(1_000, policy)).toBe(100);
    expect(headroomBytes(0, { percent: 0, minBytes: 0 })).toBe(0);
  });

  it('subtracts usage, reservations and headroom, and never goes negative', () => {
    expect(availableBytes({ limit: 15_000, usage: 10_000, reserved: 1_000 }, policy)).toBe(3_700);
    expect(availableBytes({ limit: 15_000, usage: 14_900, reserved: 500 }, policy)).toBe(0);
  });

  it('chooses the account with the most space that can hold the bytes, with deterministic ties', () => {
    const s = new MostFreeSpaceStrategy();
    const c: PlacementCandidate[] = [
      { accountId: 'b', available: 500 },
      { accountId: 'a', available: 500 },
      { accountId: 'c', available: 100 },
    ];
    expect(s.choose(c, 50)).toBe('a');
    expect(s.choose(c, 501)).toBeNull();
    expect(s.choose([], 1)).toBeNull();
    expect(s.choose([{ accountId: 'x', available: 10 }], 10)).toBe('x');
  });
});

describe('quota reservations', () => {
  const policy = { percent: 0, minBytes: 0 };
  const owner = randomUUID();

  it('never lets concurrent reservations oversubscribe an account', async () => {
    const store = new MemoryAccountStore();
    store.addAccount({ id: 'a', ownerId: owner, limit: 1000, usage: 0 });
    const results = await Promise.all(
      Array.from({ length: 20 }, () => store.tryReserve(owner, 'a', 100, 60_000, policy)),
    );
    expect(results.filter(Boolean)).toHaveLength(10);
    expect((await store.list(owner))[0]!.reserved).toBe(1000);
  });

  it('releases and expires reservations', async () => {
    let t = 0;
    const store = new MemoryAccountStore(() => t);
    store.addAccount({ id: 'a', ownerId: owner, limit: 100, usage: 0 });
    const r = await store.tryReserve(owner, 'a', 100, 1000, policy);
    expect(await store.tryReserve(owner, 'a', 1, 1000, policy)).toBeNull();
    await store.release(r!.id);
    expect(await store.tryReserve(owner, 'a', 100, 1000, policy)).not.toBeNull();
    t += 2000; // reservation expires (crashed uploader)
    expect(await store.tryReserve(owner, 'a', 100, 1000, policy)).not.toBeNull();
  });

  it('refuses unhealthy accounts and other owners', async () => {
    const store = new MemoryAccountStore();
    store.addAccount({ id: 'a', ownerId: owner, limit: 100, usage: 0, status: 'DEGRADED' });
    expect(await store.tryReserve(owner, 'a', 1, 1000, policy)).toBeNull();
    store.addAccount({ id: 'b', ownerId: owner, limit: 100, usage: 0 });
    expect(await store.tryReserve(randomUUID(), 'b', 1, 1000, policy)).toBeNull();
    expect(await store.list(randomUUID())).toEqual([]);
  });
});

describe('ByteReader', () => {
  it('splits an arbitrary stream into exact slices', async () => {
    const data = randomBytes(1000);
    const r = new ByteReader(pieces(data, 77));
    expect(await r.readExact(300)).toEqual(data.subarray(0, 300));
    expect(await r.readExact(700)).toEqual(data.subarray(300));
    await r.assertEnd();
  });

  it('detects short and long streams', async () => {
    await expect(new ByteReader(pieces(randomBytes(10), 4)).readExact(11)).rejects.toBeInstanceOf(
      SizeMismatchError,
    );
    const r = new ByteReader(pieces(randomBytes(10), 4));
    await r.readExact(9);
    await expect(r.assertEnd()).rejects.toBeInstanceOf(SizeMismatchError);
  });

  it('accepts string pieces and skips empty ones', async () => {
    const r = new ByteReader(Readable.from(['', 'ab', '', 'c']));
    expect((await r.readExact(3)).toString()).toBe('abc');
  });
});

describe('resilience', () => {
  it('uses exponential, capped, jittered delays', () => {
    expect(backoffDelay(0, 100, 10_000, () => 0.999)).toBe(99);
    expect(backoffDelay(3, 100, 10_000, () => 0.5)).toBe(400);
    expect(backoffDelay(20, 100, 1_000, () => 0.999)).toBe(999);
    expect(backoffDelay(5, 100, 10_000, () => 0)).toBe(0);
  });

  it('retries retryable errors with backoff, then succeeds', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const result = await retry(
      () => (++n < 3 ? Promise.reject(new Error('429')) : Promise.resolve('ok')),
      {
        retries: 5,
        baseMs: 100,
        maxMs: 1000,
        shouldRetry: () => true,
        sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
        random: () => 0.5,
      },
    );
    expect(result).toBe('ok');
    expect(sleeps).toEqual([50, 100]);
  });

  it('gives up after the retry budget and does not retry fatal errors', async () => {
    let n = 0;
    const opts = { retries: 2, baseMs: 1, maxMs: 1, sleep: () => Promise.resolve() };
    await expect(
      retry(() => (n++, Promise.reject(new Error('x'))), { ...opts, shouldRetry: () => true }),
    ).rejects.toThrow('x');
    expect(n).toBe(3);
    n = 0;
    await expect(
      retry(() => (n++, Promise.reject(new Error('fatal'))), { ...opts, shouldRetry: () => false }),
    ).rejects.toThrow('fatal');
    expect(n).toBe(1);
  });

  it('semaphore caps concurrency', async () => {
    const sem = new Semaphore(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 8 }, () =>
        sem.run(async () => {
          peak = Math.max(peak, ++active);
          await new Promise((r) => setTimeout(r, 5));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });
});
