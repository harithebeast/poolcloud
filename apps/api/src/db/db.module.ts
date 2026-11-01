import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { APP_CONFIG, type AppConfig } from '../config/config.module.js';
import * as schema from './schema.js';

export const PG_POOL = Symbol('PG_POOL');
export const DB = Symbol('DB');
export type Db = NodePgDatabase<typeof schema>;

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [APP_CONFIG],
      useFactory: (cfg: AppConfig) => new Pool({ connectionString: cfg.DATABASE_URL, max: 10 }),
    },
    { provide: DB, inject: [PG_POOL], useFactory: (pool: Pool): Db => drizzle(pool, { schema }) },
  ],
  exports: [PG_POOL, DB],
})
export class DbModule implements OnApplicationShutdown {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
  }
}
