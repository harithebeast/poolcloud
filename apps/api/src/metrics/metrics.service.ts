import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import { Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Db } from '../db/db.module.js';
import { storageAccounts } from '../db/schema.js';

/** Prometheus metrics. Labels are low-cardinality (route templates, status classes), never ids or names. */
export class MetricsService {
  readonly registry = new Registry();
  private readonly duration: Histogram<'method' | 'route' | 'status'>;

  constructor(db: Db) {
    collectDefaultMetrics({ register: this.registry, prefix: 'pooldrive_' });
    this.duration = new Histogram({
      name: 'pooldrive_http_request_duration_seconds',
      help: 'HTTP request duration',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 30, 300],
      registers: [this.registry],
    });

    // Pool figures are computed at scrape time so they are never stale.
    const totals = async () =>
      (
        await db
          .select({
            status: storageAccounts.status,
            n: sql<number>`count(*)::int`,
            limit: sql<number>`coalesce(sum(${storageAccounts.quotaLimit}), 0)::float8`,
            usage: sql<number>`coalesce(sum(${storageAccounts.quotaUsage}), 0)::float8`,
          })
          .from(storageAccounts)
          .groupBy(storageAccounts.status)
      ).map((r) => ({ ...r, n: Number(r.n), limit: Number(r.limit), usage: Number(r.usage) }));

    new Gauge({
      name: 'pooldrive_storage_accounts',
      help: 'Linked storage accounts by status',
      labelNames: ['status'],
      registers: [this.registry],
      async collect() {
        this.reset();
        for (const r of await totals()) this.set({ status: r.status }, r.n);
      },
    });
    new Gauge({
      name: 'pooldrive_pool_capacity_bytes',
      help: 'Pooled capacity of non-disconnected accounts',
      registers: [this.registry],
      async collect() {
        this.set(
          (await totals()).reduce((s, r) => s + (r.status === 'DISCONNECTED' ? 0 : r.limit), 0),
        );
      },
    });
    new Gauge({
      name: 'pooldrive_pool_used_bytes',
      help: 'Bytes used across non-disconnected accounts',
      registers: [this.registry],
      async collect() {
        this.set(
          (await totals()).reduce((s, r) => s + (r.status === 'DISCONNECTED' ? 0 : r.usage), 0),
        );
      },
    });
  }

  /** Record every response's duration against its route template. */
  attach(fastify: Pick<FastifyInstance, 'addHook'>): void {
    fastify.addHook('onResponse', (req, reply, done) => {
      const route = req.routeOptions?.url ?? 'unmatched';
      if (route !== '/metrics') {
        this.duration
          .labels(req.method, route, `${Math.floor(reply.statusCode / 100)}xx`)
          .observe(reply.elapsedTime / 1000);
      }
      done();
    });
  }
}
