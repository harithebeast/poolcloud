import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const key = Buffer.alloc(32, 1).toString('base64');
const base = {
  DATABASE_URL: 'postgres://u:p@localhost/db',
  REDIS_URL: 'redis://localhost:6379',
  SESSION_SECRET: 'x'.repeat(32),
  MASTER_KEYS: `k1:${key}`,
  STORAGE_PROVIDER: 'fake',
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    const cfg = loadConfig(base);
    expect(cfg.API_PORT).toBe(4000);
    expect(cfg.CHUNK_SIZE_BYTES).toBe(64 * 1024 * 1024);
    expect(cfg.HEADROOM_PERCENT).toBe(5);
    expect(cfg.TRASH_RETENTION_DAYS).toBe(30);
  });

  it('rejects a short session secret and a malformed master key', () => {
    expect(() => loadConfig({ ...base, SESSION_SECRET: 'short' })).toThrow(/SESSION_SECRET/);
    expect(() => loadConfig({ ...base, MASTER_KEYS: 'nope' })).toThrow(/MASTER_KEYS/);
  });

  it('boots without Google credentials so the first-run setup is reachable', () => {
    expect(() => loadConfig({ ...base, STORAGE_PROVIDER: 'google' })).not.toThrow();
  });

  it('treats an empty METRICS_TOKEN as unset but rejects a weak one', () => {
    expect(loadConfig({ ...base, METRICS_TOKEN: '' }).METRICS_TOKEN).toBeUndefined();
    expect(loadConfig({ ...base, METRICS_TOKEN: 'a'.repeat(16) }).METRICS_TOKEN).toBeDefined();
    expect(() => loadConfig({ ...base, METRICS_TOKEN: 'short' })).toThrow(/METRICS_TOKEN/);
  });

  it('does not echo secret values in errors', () => {
    try {
      loadConfig({ ...base, SESSION_SECRET: 'supersecret' });
    } catch (e) {
      expect(String(e)).not.toContain('supersecret');
    }
  });
});
