import pg from 'pg';
import type { Store, QueryRow } from './interfaces.js';

/**
 * Postgres-backed Store. Locally this is the docker-compose pgvector container;
 * in cloud it's AnalyticDB for PostgreSQL — same wire protocol, swap DATABASE_URL.
 *
 * pgvector returns vector columns as a string like "[0.1,0.2,...]"; callers that
 * need the array parse with `parseVector`. Writes use the `::vector` cast with a
 * JSON-ish array literal built by `toVectorLiteral`.
 */
export class PgStore implements Store {
  private pool: pg.Pool;
  private client: pg.PoolClient | null;

  constructor(connectionString: string, client?: pg.PoolClient) {
    // When constructed for a transaction we wrap an existing client.
    this.pool = client ? (undefined as unknown as pg.Pool) : new pg.Pool({ connectionString, max: 10 });
    this.client = client ?? null;
  }

  async query<T extends QueryRow = QueryRow>(sql: string, params: unknown[] = []): Promise<T[]> {
    const runner = this.client ?? this.pool;
    const res = await runner.query(sql, params);
    return res.rows as T[];
  }

  async transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T> {
    if (this.client) {
      // Already inside a transaction — just run (nested savepoints omitted for simplicity).
      return fn(this);
    }
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx = new PgStore('', client);
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    if (this.pool) await this.pool.end();
  }
}

/** Build a pgvector literal from a number[] — e.g. [0.1, 0.2] -> "[0.1,0.2]". */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}

/** Parse a pgvector text representation back into number[]. */
export function parseVector(raw: unknown): number[] | null {
  if (raw == null) return null;
  if (Array.isArray(raw)) return raw as number[];
  const s = String(raw).trim();
  if (!s.startsWith('[')) return null;
  return s
    .slice(1, -1)
    .split(',')
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));
}
