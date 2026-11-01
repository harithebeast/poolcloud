import { describe, expect, it } from 'vitest';
import { FakeProvider } from '../storage/fake-provider.js';
import { FakeLinkBackend, LinkError } from './link-backend.js';
import { decodeState, encodeState, newNonce } from './link-state.js';
import { ProviderRegistry } from './provider-registry.js';

const SECRET = 's'.repeat(40);
const state = (over = {}) => ({ uid: 'u1', nonce: newNonce(), exp: 1_000, ...over });

describe('OAuth state', () => {
  it('round-trips a valid state', () => {
    const s = state({ accountId: 'a1' });
    expect(decodeState(SECRET, encodeState(SECRET, s), 500)).toEqual(s);
  });

  it('rejects expired, forged, re-signed and malformed states', () => {
    const token = encodeState(SECRET, state());
    expect(decodeState(SECRET, token, 1_000)).toBeNull(); // expired
    expect(decodeState('x'.repeat(40), token, 500)).toBeNull(); // other secret
    const [body] = token.split('.');
    const forged = Buffer.from(JSON.stringify(state({ uid: 'attacker' }))).toString('base64url');
    expect(decodeState(SECRET, `${forged}.${token.split('.')[1]}`, 500)).toBeNull();
    expect(decodeState(SECRET, `${body}`, 500)).toBeNull();
    expect(decodeState(SECRET, `${token}.extra`, 500)).toBeNull();
    expect(decodeState(SECRET, 'not-a-state', 500)).toBeNull();
    const badJson = Buffer.from('{oops').toString('base64url');
    expect(decodeState(SECRET, `${badJson}.sig`, 500)).toBeNull();
  });
});

describe('ProviderRegistry', () => {
  const creds = { accountId: 'a1', refreshToken: 'r', appFolderId: 'f' };

  it('builds a provider once per account and reuses it', async () => {
    let loads = 0;
    const registry = new ProviderRegistry({
      load: () => (loads++, Promise.resolve(creds)),
      make: () => new FakeProvider({ limit: 100 }),
    });
    const p = registry.get('a1');
    expect(registry.get('a1')).toBe(p);
    expect(await p.getQuota()).toEqual({ limit: 100, usage: 0 });
    await p.healthCheck();
    const id = await p.allocateId();
    await p.upload(id, (await import('node:stream')).Readable.from([Buffer.from('hi')]), 2);
    expect((await p.download(id)).read()).toBeDefined();
    await p.delete(id);
    expect(loads).toBe(1);
  });

  it('does not cache a failed load and rebuilds after invalidate', async () => {
    let calls = 0;
    const registry = new ProviderRegistry({
      load: () => (++calls === 1 ? Promise.resolve(null) : Promise.resolve(creds)),
      make: () => new FakeProvider({ limit: 7 }),
    });
    await expect(registry.get('a1').getQuota()).rejects.toThrow(/Unknown storage account/);
    expect((await registry.get('a1').getQuota()).limit).toBe(7);
    registry.invalidate('a1');
    await registry.get('a1').getQuota();
    expect(calls).toBe(3);
  });
});

describe('FakeLinkBackend', () => {
  it('issues deterministic synthetic identities and rejects foreign codes', async () => {
    const b = new FakeLinkBackend('http://api/cb');
    const url = new URL(b.authUrl('STATE', 'me@pool.local'));
    expect(url.searchParams.get('state')).toBe('STATE');
    const id = await b.exchange(url.searchParams.get('code')!);
    expect(id).toMatchObject({ email: 'me@pool.local', sub: 'fake-sub:me@pool.local' });
    expect(new URL(b.authUrl('s')).searchParams.get('code')).toMatch(/^fake:fake-\d+@pool.local$/);
    expect(() => b.exchange('real-google-code')).toThrow(LinkError);
    await expect(b.createAppFolder()).resolves.toMatch(/^fake-folder-/);
  });
});
