import { loadConfig } from '@pooldrive/shared';
import { createMaintenanceJobs, JOB_NAMES, schedule, type JobName } from '@pooldrive/api/jobs';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { createServer } from 'node:http';
import pg from 'pg';
import { pino } from 'pino';

const MAINTENANCE_QUEUE = 'maintenance';
const HEALTH_PORT = 4001;

const cfg = loadConfig();
const log = pino({ level: cfg.LOG_LEVEL, base: { service: 'worker' } });

const redis = new Redis(cfg.REDIS_URL, { maxRetriesPerRequest: null });
const pool = new pg.Pool({ connectionString: cfg.DATABASE_URL, max: 2 });
const { jobs, close: closeJobs } = createMaintenanceJobs(cfg, (event, data) =>
  log.info(data, event),
);

const isJob = (name: string): name is JobName => (JOB_NAMES as readonly string[]).includes(name);

const worker = new Worker(
  MAINTENANCE_QUEUE,
  async (job) => {
    if (!isJob(job.name)) throw new Error(`unknown job ${job.name}`);
    const started = Date.now();
    const result = await jobs.run(job.name);
    log.info({ job: job.name, ms: Date.now() - started, result }, 'job finished');
  },
  { connection: redis, concurrency: 2 },
);
worker.on('failed', (job, err) => log.error({ job: job?.name, err: err.message }, 'job failed'));

// Repeatable schedules live in Redis, so restarting or running several workers never duplicates them.
const queue = new Queue(MAINTENANCE_QUEUE, { connection: redis });
const everySeconds = schedule(cfg.QUOTA_SYNC_INTERVAL_SECONDS);
for (const name of JOB_NAMES) {
  await queue.upsertJobScheduler(
    name,
    { every: everySeconds[name] * 1000 },
    { name, opts: { removeOnComplete: 50, removeOnFail: 200 } },
  );
}

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
health.listen(HEALTH_PORT, '0.0.0.0', () =>
  log.info({ port: HEALTH_PORT, jobs: everySeconds }, 'worker started'),
);

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  health.close();
  await worker.close();
  await queue.close();
  await closeJobs();
  await pool.end();
  await redis.quit();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
