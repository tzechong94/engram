import type { Queue, Store } from './interfaces.js';

/**
 * Postgres-backed queue. Used for the dead-letter queue on the write path: when
 * embedding/model calls fail after retries, the write is queued here transactionally
 * rather than dropped (the brief's "never drop a write" requirement). Backing the
 * DLQ with Postgres (not Redis) makes dead-lettering transactional with the write
 * itself and removes a Redis dependency from the memory core. Redis/Tair remains
 * available for the agent-runtime hot tier.
 *
 * Relies on the `queue_items` table (created in memory migrations).
 */
export class PgQueue implements Queue {
  constructor(private store: Store) {}

  async push(topic: string, payload: unknown): Promise<void> {
    await this.store.query(
      'INSERT INTO queue_items (topic, payload) VALUES ($1, $2::jsonb)',
      [topic, JSON.stringify(payload)],
    );
  }

  async pop(topic: string, max: number): Promise<unknown[]> {
    // Atomic claim-and-delete so two workers can't grab the same item.
    const rows = await this.store.query<{ payload: unknown }>(
      `DELETE FROM queue_items
       WHERE id IN (
         SELECT id FROM queue_items WHERE topic = $1
         ORDER BY created_at ASC LIMIT $2
         FOR UPDATE SKIP LOCKED
       )
       RETURNING payload`,
      [topic, max],
    );
    return rows.map((r) => r.payload);
  }

  async depth(topic: string): Promise<number> {
    const rows = await this.store.query<{ n: string }>(
      'SELECT COUNT(*)::text AS n FROM queue_items WHERE topic = $1',
      [topic],
    );
    return Number(rows[0]?.n ?? 0);
  }
}
