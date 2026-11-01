import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { join } from 'node:path';
import { Pool } from 'pg';
import { loadConfig } from '@pooldrive/shared';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const pool = new Pool({ connectionString: cfg.DATABASE_URL, max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: join(import.meta.dirname, '../../drizzle') });
    process.stdout.write(JSON.stringify({ level: 'info', msg: 'migrations applied' }) + '\n');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(
    JSON.stringify({ level: 'fatal', msg: 'migration failed', err: String(err) }) + '\n',
  );
  process.exit(1);
});
