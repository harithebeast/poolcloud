import { loadConfig } from '@pooldrive/shared';
import { Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createServer } from 'node:http';
import pg from 'pg';
import { pino } from 'pino';

const MAINTENANCE_QUEUE = 'maintenance';
const HEALTH_PORT = 4001;

const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { service: 'worker' } });

const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 4 });

const worker = new Worker(
  MAINTENANCE_QUEUE,
  (job) => {
    // Job handlers (quota sync, trash purge, chunk cleanup, orphan scan) are registered per phase.
    log.warn({ jobId: job.id, name: job.name }, 'no handler registered for job');
    return Promise.resolve();
  },
  { connection: redis },
);
worker.on('failed', (job, err) => log.error({ jobId: job?.id, err: err.message }, 'job failed'));

const health = createServer((req, res) => {
  const send = (code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health/live') return send(200, { status: 'ok' });
  if (req.url === '/health/ready') {
    Promise.all([pool.query('select 1'), redis.ping()])
      .then(() => send(200, { status: 'ok' }))
      .catch(() => send(503, { status: 'unavailable' }));
    return;
  }
  send(404, { error: 'not found' });
});
health.listen(HEALTH_PORT, '0.0.0.0', () => log.info({ port: HEALTH_PORT }, 'worker started'));

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  health.close();
  await worker.close();
  await pool.end();
  await redis.quit();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
