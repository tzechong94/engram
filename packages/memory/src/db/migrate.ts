/**
 * Migration runner. Applies src/db/migrations/*.sql in lexical order, each inside
 * a transaction, recording applied versions in schema_migrations. Idempotent:
 * re-running applies only new files. Run via `pnpm --filter @engram/memory migrate`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgStore, loadConfig, createLogger } from '@engram/shared';

const log = createLogger('migrate');
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function runMigrations(databaseUrl = loadConfig().databaseUrl): Promise<number> {
  const store = new PgStore(databaseUrl);
  try {
    await store.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const applied = new Set(
      (await store.query<{ version: string }>('SELECT version FROM schema_migrations')).map((r) => r.version),
    );

    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      log.info('applying migration', { version });
      await store.transaction(async (tx) => {
        await tx.query(sql);
        await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
      });
      count++;
    }
    log.info('migrations complete', { applied: count, total: files.length });
    return count;
  } finally {
    await store.close();
  }
}

// Run directly (tsx src/db/migrate.ts)
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then((n) => {
      log.info(`done (${n} new migration(s))`);
      process.exit(0);
    })
    .catch((err) => {
      log.error('migration failed', { err: String(err) });
      process.exit(1);
    });
}
