import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';
import { LoginThrottle, MemoryCounterStore, RedisCounterStore } from './throttle.js';
import { csrfTokenFor, hashToken, newSessionToken, safeEqual } from './tokens.js';

describe('tokens', () => {
  it('generates unguessable, unique session tokens and stores only their hash', () => {
    const a = newSessionToken();
    expect(a).not.toBe(newSessionToken());
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(hashToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(a)).not.toContain(a);
  });

  it('binds CSRF tokens to the session and the server secret', () => {
    const s = 'x'.repeat(32);
    expect(csrfTokenFor(s, 'one')).toBe(csrfTokenFor(s, 'one'));
    expect(csrfTokenFor(s, 'one')).not.toBe(csrfTokenFor(s, 'two'));
    expect(csrfTokenFor(s, 'one')).not.toBe(csrfTokenFor('y'.repeat(32), 'one'));
  });

  it('compares in constant time and handles different lengths', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
  });
});

describe('password', () => {
  it('hashes with argon2id and verifies', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h.startsWith('$argon2id$')).toBe(true);
    expect(await verifyPassword(h, 'correct horse battery')).toBe(true);
    expect(await verifyPassword(h, 'wrong')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('LoginThrottle', () => {
  it('blocks an account after too many attempts and resets on success', async () => {
    const t = new LoginThrottle(new MemoryCounterStore(), 3, 60);
    for (let i = 0; i < 3; i++) expect(await t.allow('1.1.1.1', 'A@x.io')).toBe(true);
    expect(await t.allow('2.2.2.2', 'a@x.io')).toBe(false); // case-insensitive, any IP
    await t.succeeded('a@x.io');
    expect(await t.allow('2.2.2.2', 'a@x.io')).toBe(true);
  });

  it('blocks one address spraying many accounts', async () => {
    const t = new LoginThrottle(new MemoryCounterStore(), 1, 60); // 3 per IP
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await t.allow('9.9.9.9', `u${i}@x.io`));
    expect(results).toEqual([true, true, true, false, false]);
  });

  it('expires the window', async () => {
    let now = 0;
    const store = new MemoryCounterStore(() => now);
    const t = new LoginThrottle(store, 1, 10);
    expect(await t.allow('i', 'a@x.io')).toBe(true);
    expect(await t.allow('i', 'a@x.io')).toBe(false);
    now = 11_000;
    expect(await t.allow('i', 'a@x.io')).toBe(true);
  });

  it('redis store sets the expiry only on the first hit', async () => {
    const calls: string[] = [];
    let n = 0;
    const store = new RedisCounterStore({
      incr: () => Promise.resolve(++n),
      expire: (k, s) => (calls.push(`expire ${k} ${s}`), Promise.resolve(1)),
      del: (k) => (calls.push(`del ${k}`), Promise.resolve(1)),
    });
    await store.hit('k', 5);
    await store.hit('k', 5);
    await store.reset('k');
    expect(calls).toEqual(['expire k 5', 'del k']);
  });
});
