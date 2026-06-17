/**
 * Infrastructure interfaces. Every external dependency the system touches sits
 * behind one of these so the same code runs against the local docker-compose
 * stack or against Alibaba managed services by switching ENGRAM_INFRA.
 *
 *   Store     ->  Postgres            /  AnalyticDB for PostgreSQL
 *   Vector    ->  pgvector            /  AnalyticDB pgvector / DashVector
 *   Blob      ->  MinIO (S3)          /  OSS
 *   Queue     ->  Redis lists         /  Tair
 *   Scheduler ->  node-cron/interval  /  Function Compute + EventBridge
 *   Secrets   ->  env / file          /  KMS / OneCLI vault
 *
 * Store and Vector are intentionally one Postgres connection locally (pgvector
 * lives in the same DB), but kept as separate interfaces so a cloud deployment
 * can split them (e.g. DashVector for vectors) without touching call sites.
 */

export interface QueryRow {
  [column: string]: unknown;
}

export interface Store {
  query<T extends QueryRow = QueryRow>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run fn inside a transaction; rolls back on throw. */
  transaction<T>(fn: (tx: Store) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface VectorSearchHit {
  id: string;
  distance: number;
}

export interface Blob {
  put(key: string, body: Buffer | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export interface Queue {
  push(topic: string, payload: unknown): Promise<void>;
  /** Pop up to `max` items (non-blocking). */
  pop(topic: string, max: number): Promise<unknown[]>;
  depth(topic: string): Promise<number>;
}

export type ScheduledTask = () => Promise<void>;

export interface Scheduler {
  /** Register a cron-scheduled task. */
  cron(name: string, cronExpr: string, task: ScheduledTask): void;
  /** Register a task to run every N ms. */
  every(name: string, ms: number, task: ScheduledTask): void;
  start(): void;
  stop(): void;
}

export interface Secrets {
  get(name: string): Promise<string | null>;
}
