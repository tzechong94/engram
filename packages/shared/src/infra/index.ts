import { loadConfig, type EngramConfig } from '../config.js';
import { createLogger } from '../log.js';
import { FilesystemBlob } from './blob.js';
import { PgStore } from './pg.js';
import { PgQueue } from './queue.js';
import { LocalScheduler } from './scheduler.js';
import { EnvSecrets } from './secrets.js';
import type { Blob, Queue, Scheduler, Secrets, Store } from './interfaces.js';

export * from './interfaces.js';
export { PgStore, toVectorLiteral, parseVector } from './pg.js';
export { FilesystemBlob } from './blob.js';
export { PgQueue } from './queue.js';
export { LocalScheduler, parseDailyCron } from './scheduler.js';
export { EnvSecrets } from './secrets.js';

const log = createLogger('infra');

export interface Infra {
  store: Store;
  blob: Blob;
  queue: Queue;
  scheduler: Scheduler;
  secrets: Secrets;
}

/**
 * Build the infra bundle for the current ENGRAM_INFRA. `local` wires the
 * docker-compose stack; `alibaba` is the cloud swap (managed services). Today
 * both paths use the same Postgres-protocol Store/Vector and the same interfaces;
 * the cloud variant differs only in connection strings + (optionally) an S3/OSS
 * blob and KMS secrets, which slot in here without touching call sites.
 */
export function createInfra(cfg: EngramConfig = loadConfig()): Infra {
  log.info('building infra', { mode: cfg.infra });
  const store = new PgStore(cfg.databaseUrl);
  return {
    store,
    blob: new FilesystemBlob(),
    queue: new PgQueue(store),
    scheduler: new LocalScheduler(),
    secrets: new EnvSecrets(),
  };
}
