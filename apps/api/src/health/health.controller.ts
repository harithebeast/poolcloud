import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { Public } from '../auth/auth.guard.js';
import { REDIS } from '../common/redis.module.js';
import { PG_POOL } from '../db/db.module.js';

export type Check = { ok: boolean; error?: string };

export async function runCheck(fn: () => Promise<unknown>): Promise<Check> {
  try {
    await fn();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'unknown error' };
  }
}

@ApiTags('health')
@Public()
@Controller('health')
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: the process is up and the event loop responds. */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** Readiness: dependencies are reachable. */
  @Get('ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, Check> }> {
    const [database, redis] = await Promise.all([
      runCheck(() => this.pool.query('select 1')),
      runCheck(() => this.redis.ping()),
    ]);
    const checks = { database, redis };
    if (!database.ok || !redis.ok) {
      throw new ServiceUnavailableException({ status: 'unavailable', checks });
    }
    return { status: 'ok', checks };
  }
}
