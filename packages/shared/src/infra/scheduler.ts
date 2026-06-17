import { createLogger } from '../log.js';
import type { Scheduler, ScheduledTask } from './interfaces.js';

const log = createLogger('scheduler');

interface Job {
  name: string;
  nextRun: number;
  intervalMs?: number;
  cron?: { minute: number; hour: number };
  task: ScheduledTask;
  running: boolean;
}

/**
 * In-process scheduler for local dev. Stands in for Function Compute + EventBridge
 * in cloud (where the sleep cron becomes an EventBridge rule invoking an FC
 * function). Supports `every(ms)` fully and a minimal daily-cron ("M H * * *"),
 * which is all the sleep schedule needs. A job never overlaps itself.
 */
export class LocalScheduler implements Scheduler {
  private jobs: Job[] = [];
  private timer: NodeJS.Timeout | null = null;
  private tickMs: number;

  constructor(tickMs = 15_000) {
    this.tickMs = tickMs;
  }

  cron(name: string, cronExpr: string, task: ScheduledTask): void {
    const parsed = parseDailyCron(cronExpr);
    if (!parsed) {
      log.warn('unsupported cron expr; falling back to hourly', { name, cronExpr });
      this.every(name, 60 * 60 * 1000, task);
      return;
    }
    this.jobs.push({ name, cron: parsed, nextRun: nextDailyRun(parsed), task, running: false });
    log.info('registered cron job', { name, cronExpr });
  }

  every(name: string, ms: number, task: ScheduledTask): void {
    this.jobs.push({ name, intervalMs: ms, nextRun: Date.now() + ms, task, running: false });
    log.info('registered interval job', { name, ms });
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    log.info('scheduler started', { jobs: this.jobs.length, tickMs: this.tickMs });
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async tick(): Promise<void> {
    const now = Date.now();
    for (const job of this.jobs) {
      if (job.running || now < job.nextRun) continue;
      job.running = true;
      try {
        await job.task();
      } catch (err) {
        log.error('scheduled task threw', { name: job.name, err: String(err) });
      } finally {
        job.running = false;
        job.nextRun = job.intervalMs ? now + job.intervalMs : nextDailyRun(job.cron!);
      }
    }
  }
}

/** Parse "M H * * *" (the only cron shape we need). Returns null otherwise. */
export function parseDailyCron(expr: string): { minute: number; hour: number } | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [m, h, dom, mon, dow] = parts;
  if (dom !== '*' || mon !== '*' || dow !== '*') return null;
  const minute = Number(m);
  const hour = Number(h);
  if (!Number.isInteger(minute) || !Number.isInteger(hour)) return null;
  if (minute < 0 || minute > 59 || hour < 0 || hour > 23) return null;
  return { minute, hour };
}

function nextDailyRun(cron: { minute: number; hour: number }): number {
  const now = new Date();
  const next = new Date(now);
  next.setSeconds(0, 0);
  next.setHours(cron.hour, cron.minute, 0, 0);
  if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
  return next.getTime();
}
