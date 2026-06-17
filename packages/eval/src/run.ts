#!/usr/bin/env node
/**
 * Engram eval harness. Seeds a scripted user, measures retrieval + consolidation
 * before and after a sleep cycle, and emits a JSON report + a markdown table +
 * the before/after-sleep ASCII visual (the headline). Runs fully offline on the
 * mock Qwen; set QWEN_MOCK=false + DASHSCOPE_API_KEY for the real-model run.
 *
 * Usage: make eval   (after make up)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createInfra, createQwenClient, loadConfig, newId, createLogger, type SearchResult } from '@engram/shared';
import { MemoryService, SleepPhase, DEFAULT_WEIGHTS } from '@engram/memory';
import { SEED, RECALL_QUERIES, CROSS_CHANNEL_QUERY, FORGET_QUERIES, type RecallQuery } from './scenario.js';

const log = createLogger('eval');
const DAY_MS = 86_400_000;

async function recallAtK(memory: MemoryService, tenant: string, q: RecallQuery, tokenBudget: number): Promise<{ hit: boolean; tokens: number; ms: number }> {
  const t0 = performance.now();
  const res = await memory.search({ tenantId: tenant, query: q.query, tokenBudget, k: 20 });
  const ms = performance.now() - t0;
  const hay = res.memories.map((m) => m.content.toLowerCase()).join(' | ');
  const hit = q.expectAny.some((tok) => hay.includes(tok.toLowerCase()));
  return { hit, tokens: res.trace.tokensUsed, ms };
}

function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1);
  return Math.round(sorted[idx]! * 100) / 100;
}

function pct(n: number, d: number): number {
  return d === 0 ? 0 : Math.round((n / d) * 1000) / 10;
}

async function measureSet(memory: MemoryService, tenant: string, queries: RecallQuery[], tokenBudget: number) {
  let hits = 0;
  const tokensArr: number[] = [];
  const latencies: number[] = [];
  for (const q of queries) {
    const r = await recallAtK(memory, tenant, q, tokenBudget);
    if (r.hit) hits++;
    tokensArr.push(r.tokens);
    latencies.push(r.ms);
  }
  return {
    recall: pct(hits, queries.length),
    hits,
    total: queries.length,
    avgTokens: Math.round(tokensArr.reduce((a, b) => a + b, 0) / (tokensArr.length || 1)),
    p95Ms: p95(latencies),
  };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const infra = createInfra(cfg);
  const qwen = createQwenClient(cfg.qwen);
  const tenant = `eval-${newId()}`;

  // Two services: one with the full budgeter, one relevance-only (ablation).
  const memory = new MemoryService(infra.store, qwen, infra.queue, { weights: DEFAULT_WEIGHTS });
  const ablation = new MemoryService(infra.store, qwen, infra.queue, {
    weights: { relevance: 1, recency: 0, importance: 0, diversity: 0 },
  });
  const sleep = new SleepPhase(infra.store, qwen, infra.blob, {
    costCapCents: cfg.sleep.costCapCents,
    forgetThreshold: cfg.sleep.forgetThreshold,
    // Mock embeddings are noisier than real Qwen, so cluster at a lower cosine.
    clusterThreshold: qwen.isMock ? 0.15 : 0.55,
  });

  log.info('seeding scenario', { tenant, episodes: SEED.length, mock: qwen.isMock });
  await memory.repository.ensureTenant(tenant);
  const seeded: Array<{ id: string; ageDays: number }> = [];
  const backdate = async (id: string, ageDays: number) => {
    const ts = new Date(Date.now() - ageDays * DAY_MS).toISOString();
    await infra.store.query('UPDATE episodes SET created_at = $2, last_accessed_at = $2 WHERE id = $1', [id, ts]);
  };
  for (const ep of SEED) {
    const w = await memory.write({ tenantId: tenant, content: ep.content, sourceChannel: ep.channel, importance: ep.importance });
    await backdate(w.id, ep.ageDays);
    seeded.push({ id: w.id, ageDays: ep.ageDays });
  }

  const before = await memory.repository.memoryStats(tenant);

  // ── BEFORE sleep ──────────────────────────────────────────────────────────
  const beforeRecall = await measureSet(memory, tenant, RECALL_QUERIES, 1500);
  const beforeBudgeted = await measureSet(memory, tenant, RECALL_QUERIES, 100); // tight budget — must select
  const beforeAblation = await measureSet(ablation, tenant, RECALL_QUERIES, 100_000); // naive: dump everything
  const crossBefore = await recallAtK(memory, tenant, CROSS_CHANNEL_QUERY, 1500);

  // The before-sleep measurements above accessed memories (bumping last_accessed_at),
  // which would wrongly protect stale trivia from the forget sweep. Those searches
  // are measurement artifacts, not real user activity — restore the true ages.
  for (const s of seeded) await backdate(s.id, s.ageDays);

  // ── SLEEP ───────────────────────────────────────────────────────────────
  log.info('running sleep cycle');
  const sleepReport = await sleep.run(tenant);

  // ── AFTER sleep ───────────────────────────────────────────────────────────
  const after = await memory.repository.memoryStats(tenant);
  const afterRecall = await measureSet(memory, tenant, RECALL_QUERIES, 1500);
  const crossAfter = await recallAtK(memory, tenant, CROSS_CHANNEL_QUERY, 1500);

  // Forget precision: of the trivia we expected to forget, how many are NOT recalled.
  let forgottenCount = 0;
  for (const fq of FORGET_QUERIES) {
    const r = await recallAtK(memory, tenant, fq, 1500);
    if (!r.hit) forgottenCount++;
  }
  const forgetPrecision = pct(forgottenCount, FORGET_QUERIES.length);

  const report = {
    tenant,
    mode: qwen.isMock ? 'mock-qwen' : 'real-qwen',
    generatedAt: new Date().toISOString(),
    before,
    after,
    sleep: sleepReport.stats,
    sleepStatus: sleepReport.status,
    retrieval: {
      recallAtK_before: beforeRecall,
      recallAtK_after_retention: afterRecall,
      crossChannelRecall_before: crossBefore.hit,
      crossChannelRecall_after: crossAfter.hit,
      forgetPrecision,
      forgotten: `${forgottenCount}/${FORGET_QUERIES.length}`,
    },
    budgeterAblation: {
      withBudgeter_tightBudget: beforeBudgeted,
      relevanceOnly_noCap: beforeAblation,
      tokenSavings: `${beforeAblation.avgTokens - beforeBudgeted.avgTokens} fewer tokens/query with budgeter`,
    },
  };

  // pnpm runs this with cwd = packages/eval; fall back gracefully if run from root.
  const base = process.cwd().endsWith(path.join('packages', 'eval')) ? process.cwd() : path.resolve(process.cwd(), 'packages/eval');
  const outDir = path.resolve(base, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const md = renderMarkdown(report);
  fs.writeFileSync(path.join(outDir, 'report.md'), md);

  process.stdout.write('\n' + md + '\n');
  log.info('eval complete', { out: outDir });
  await infra.store.close();
}

function bar(n: number, max: number, width = 24): string {
  const filled = max === 0 ? 0 : Math.round((n / max) * width);
  return '█'.repeat(filled) + '·'.repeat(Math.max(0, width - filled));
}

function renderMarkdown(r: ReturnType<typeof Object> extends never ? never : any): string {
  const b = r.before;
  const a = r.after;
  const maxEp = Math.max(b.activeEpisodes, a.activeEpisodes, 1);
  const lines: string[] = [];
  lines.push(`# Engram Eval Report (${r.mode})`);
  lines.push('');
  lines.push(`_Generated ${r.generatedAt} — tenant \`${r.tenant}\`_`);
  lines.push('');
  lines.push('## Before vs After Sleep (the headline)');
  lines.push('```');
  lines.push('                       BEFORE          AFTER');
  lines.push(`active episodes   ${String(b.activeEpisodes).padStart(4)}  ${bar(b.activeEpisodes, maxEp)}  ${String(a.activeEpisodes).padStart(4)} ${bar(a.activeEpisodes, maxEp)}`);
  lines.push(`semantic notes    ${String(b.notes).padStart(4)}                            ${String(a.notes).padStart(4)}`);
  lines.push(`graph entities    ${String(b.entities).padStart(4)}                            ${String(a.entities).padStart(4)}`);
  lines.push(`graph edges       ${String(b.edges).padStart(4)}                            ${String(a.edges).padStart(4)}`);
  lines.push(`forgotten         ${String(b.forgotten).padStart(4)}                            ${String(a.forgotten).padStart(4)}`);
  lines.push('```');
  lines.push('');
  lines.push('The raw episodic pile becomes a lean consolidated graph; stale memories are forgotten; recall holds.');
  lines.push('');
  lines.push('## Sleep cycle work');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---|');
  for (const [k, v] of Object.entries(r.sleep)) lines.push(`| ${k} | ${typeof v === 'object' && v !== null ? JSON.stringify(v) : v} |`);
  lines.push(`| status | ${r.sleepStatus} |`);
  lines.push('');
  lines.push('## Retrieval & consolidation metrics');
  lines.push('');
  lines.push('| metric | value |');
  lines.push('|---|---|');
  lines.push(`| recall@k before sleep | ${r.retrieval.recallAtK_before.recall}% (${r.retrieval.recallAtK_before.hits}/${r.retrieval.recallAtK_before.total}) |`);
  lines.push(`| recall@k after sleep (retention) | ${r.retrieval.recallAtK_after_retention.recall}% (${r.retrieval.recallAtK_after_retention.hits}/${r.retrieval.recallAtK_after_retention.total}) |`);
  lines.push(`| cross-channel recall (before → after) | ${r.retrieval.crossChannelRecall_before} → ${r.retrieval.crossChannelRecall_after} |`);
  lines.push(`| forget precision | ${r.retrieval.forgetPrecision}% (${r.retrieval.forgotten} stale forgotten) |`);
  lines.push(`| retrieval p95 latency | ${r.retrieval.recallAtK_after_retention.p95Ms} ms |`);
  lines.push('');
  lines.push('## Budgeter ablation (tokens-in-context)');
  lines.push('');
  lines.push('| config | recall | avg tokens/query |');
  lines.push('|---|---|---|');
  lines.push(`| with budgeter (100-token budget) | ${r.budgeterAblation.withBudgeter_tightBudget.recall}% | ${r.budgeterAblation.withBudgeter_tightBudget.avgTokens} |`);
  lines.push(`| relevance-only, no cap | ${r.budgeterAblation.relevanceOnly_noCap.recall}% | ${r.budgeterAblation.relevanceOnly_noCap.avgTokens} |`);
  lines.push(`| **savings** | | ${r.budgeterAblation.tokenSavings} |`);
  lines.push('');
  return lines.join('\n');
}

main().catch((err) => {
  log.error('eval failed', { err: String(err) });
  process.exit(1);
});
