import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { patterned } from '../storage/testing/harness.js';
import { createHarness, type Harness } from '../testing/http-harness.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('metrics', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness(url!);
    const u = await h.login('m@x.io', true);
    await h.linkAccount(u, { limit: 5_000, usage: 1_000 });
    await h.linkAccount(u, { limit: 7_000, usage: 500 });
    await h.upload(u, 'a.txt', patterned(10));
    await h.call('GET', '/files', u);
  });
  afterAll(() => h.close());

  it('exposes pool gauges computed at scrape time and request timings by route template', async () => {
    const res = await h.call('GET', '/metrics');
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/plain/);
    expect(res.body).toMatch(/pooldrive_storage_accounts\{status="HEALTHY"\} 2/);
    expect(res.body).toMatch(/pooldrive_pool_capacity_bytes 12000/);
    expect(res.body).toMatch(/pooldrive_pool_used_bytes 1510/);
    expect(res.body).toMatch(/pooldrive_http_request_duration_seconds_count\{[^}]*route="\/files"/);
    expect(res.body).toMatch(/pooldrive_process_cpu/);
    expect(res.body).not.toMatch(/route="\/metrics"/);
  });

  it('never labels with ids, names or emails', async () => {
    const res = await h.call('GET', '/metrics');
    expect(res.body).not.toMatch(/a\.txt|m@x\.io|[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it('requires the bearer token when METRICS_TOKEN is configured', async () => {
    const strict = await createHarness(url!, { env: { METRICS_TOKEN: 'a-very-secret-token' } });
    try {
      expect((await strict.call('GET', '/metrics')).statusCode).toBe(401);
      const bad = await strict.call('GET', '/metrics', undefined, {
        headers: { authorization: 'Bearer nope' },
      });
      expect(bad.statusCode).toBe(401);
      const ok = await strict.call('GET', '/metrics', undefined, {
        headers: { authorization: 'Bearer a-very-secret-token' },
      });
      expect(ok.statusCode).toBe(200);
    } finally {
      await strict.close();
    }
  });
});
