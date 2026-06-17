#!/usr/bin/env node
/**
 * Sleep-phase worker. Two modes:
 *   - scheduled (default): registers a per-tenant nightly cron + an inactivity
 *     check; runs a REM cycle when a tenant has been idle long enough or it's
 *     their nightly slot. Also drains the re-embed dead-letter each tick.
 *   - forced (FORCE=1 TENANT=<id>): runs one cycle immediately and prints the
 *     before/after report — this is what the 3-minute demo calls to "fast-forward
 *     a sleep phase".
 *
 * In cloud the scheduler is EventBridge → Function Compute; locally it's the
 * in-process LocalScheduler. Same code, swapped by ENGRAM_INFRA.
 */
import { createInfra, createQwenClient, createLogger, loadConfig } from '@engram/shared';
import { MemoryService } from './service.js';
import { SleepPhase } from './sleep.js';

const log = createLogger('sleep-worker');

async function runOnce(tenantId: string): Promise<void> {
  const cfg = loadConfig();
  const infra = createInfra(cfg);
  const qwen = createQwenClient(cfg.qwen);
  const sleep = new SleepPhase(infra.store, qwen, infra.blob, {
    costCapCents: cfg.sleep.costCapCents,
    forgetThreshold: cfg.sleep.forgetThreshold,
  });
  const report = await sleep.run(tenantId);
  // Human-readable before/after for the demo.
  process.stdout.write('\n=== SLEEP CYCLE REPORT ===\n' + JSON.stringify(report, null, 2) + '\n');
  await infra.store.close();
}

async function listTenants(): Promise<string[]> {
  const cfg = loadConfig();
  const infra = createInfra(cfg);
  try {
    const rows = await infra.store.query<{ id: string }>('SELECT id FROM tenants');
    return rows.map((r) => r.id);
  } finally {
    await infra.store.close();
  }
}

async function scheduled(): Promise<void> {
  const cfg = loadConfig();
  const infra = createInfra(cfg);
  const qwen = createQwenClient(cfg.qwen);
  const memory = new MemoryService(infra.store, qwen, infra.queue);
  const inactivityMs = cfg.sleep.inactivityMinutes * 60_000;

  const tick = async () => {
    await memory.drainReembedQueue().catch((err) => log.warn('reembed drain failed', { err: String(err) }));
    const rows = await infra.store.query<{ id: string }>('SELECT id FROM tenants');
    const now = Date.now();
    for (const { id } of rows) {
      const repo = memory.repository;
      const last = await repo.lastActivityMs(id);
      const latest = await repo.latestSleepCycle(id);
      const lastCycleMs = latest?.startedAt ? new Date(latest.startedAt).getTime() : 0;
      const idleLongEnough = last != null && now - last >= inactivityMs;
      const notRecentlyRun = now - lastCycleMs >= inactivityMs;
      // Reflection trigger (Generative Agents): enough accumulated importance since
      // the last cycle, even if the user isn't idle yet.
      const sinceIso = latest?.startedAt ?? new Date(0).toISOString();
      const accImportance = cfg.sleep.importanceThreshold > 0 ? await repo.importanceSince(id, sinceIso) : 0;
      const importantEnough = cfg.sleep.importanceThreshold > 0 && accImportance >= cfg.sleep.importanceThreshold;
      if ((idleLongEnough || importantEnough) && notRecentlyRun) {
        log.info('triggered sleep cycle', { tenantId: id, reason: importantEnough ? 'importance' : 'inactivity', accImportance });
        const sleep = new SleepPhase(infra.store, qwen, infra.blob, {
          costCapCents: cfg.sleep.costCapCents,
          forgetThreshold: cfg.sleep.forgetThreshold,
        });
        await sleep.run(id).catch((err) => log.error('cycle failed', { tenantId: id, err: String(err) }));
      }
    }
  };

  // Nightly cron for everyone + a frequent inactivity check.
  infra.scheduler.cron('nightly-sleep', cfg.sleep.cron, tick);
  infra.scheduler.every('inactivity-check', 60_000, tick);
  infra.scheduler.start();
  log.info('sleep scheduler started', { cron: cfg.sleep.cron, inactivityMinutes: cfg.sleep.inactivityMinutes });
}

async function main(): Promise<void> {
  if (process.env.FORCE === '1') {
    const tenant = process.env.TENANT;
    if (tenant) {
      await runOnce(tenant);
    } else {
      for (const t of await listTenants()) await runOnce(t);
    }
    process.exit(0);
  }
  await scheduled();
}

main().catch((err) => {
  log.error('sleep worker fatal', { err: String(err) });
  process.exit(1);
});
