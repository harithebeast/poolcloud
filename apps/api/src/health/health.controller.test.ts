import { ServiceUnavailableException } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { HealthController, runCheck } from './health.controller.js';

const pool = (ok: boolean) =>
  ({
    query: () => (ok ? Promise.resolve() : Promise.reject(new Error('db down'))),
  }) as unknown as Pool;
const redis = (ok: boolean) =>
  ({
    ping: () => (ok ? Promise.resolve('PONG') : Promise.reject(new Error('redis down'))),
  }) as unknown as Redis;

describe('HealthController', () => {
  it('live is always ok', () => {
    expect(new HealthController(pool(false), redis(false)).live()).toEqual({ status: 'ok' });
  });

  it('ready is ok when both dependencies respond', async () => {
    const res = await new HealthController(pool(true), redis(true)).ready();
    expect(res.status).toBe('ok');
  });

  it('ready returns 503 with per-dependency detail when one is down', async () => {
    const ctrl = new HealthController(pool(true), redis(false));
    await expect(ctrl.ready()).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(ctrl.ready()).rejects.toMatchObject({
      response: { checks: { database: { ok: true }, redis: { ok: false, error: 'redis down' } } },
    });
  });

  it('runCheck captures failures instead of throwing', async () => {
    expect(await runCheck(() => Promise.reject(new Error('x')))).toEqual({ ok: false, error: 'x' });
  });
});
