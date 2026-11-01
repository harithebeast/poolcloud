import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { join } from 'node:path';
import { Pool } from 'pg';
import * as schema from '../db/schema.js';

/**
 * A private, migrated database for one test file, so files can run in parallel without seeing each
 * other's rows. Requires TEST_DATABASE_URL to point at a server where the user may CREATE DATABASE.
 */
export async function createTestDb(baseUrl: string) {
  const name = `t_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  await admin.query(`create database ${name}`);

  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const pool = new Pool({ connectionString: url.toString(), max: 10 });
  const db = drizzle(pool, { schema });
  await migrate(db, { migrationsFolder: join(import.meta.dirname, '../../drizzle') });

  return {
    url: url.toString(),
    pool,
    db,
    async drop(): Promise<void> {
      await pool.end();
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}
