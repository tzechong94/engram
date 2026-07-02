#!/usr/bin/env node
/**
 * Comprehensive, GATED Engram eval suite (production gate).
 *
 * Extends the headline before/after-sleep report with the dimensions a
 * MemoryAgent must get right, each with a pass/fail threshold and a non-zero
 * exit code on failure so it can run in CI:
 *
 *   1. Recall@k (retention after sleep)        — facts stay recallable
 *   2. Cross-channel recall                    — written on A, recalled on B
 *   3. Forget precision                        — stale trivia is dropped
 *   4. Contradiction / update resolution       — new value wins, old is gone
 *   5. Precision / no-confabulation            — absent facts aren't fabricated
 *   6. Limited-context precision@k             — critical memory survives a tiny budget
 *   7. Retrieval latency (p95)                 — fast enough to sit in the hot path
 *   8. Consolidation                           — episodes become durable notes
 *   9. Answer correctness (LLM-judged)         — the full recall→answer pipeline
 *
 * Runs offline on mock Qwen for a smoke pass; set QWEN_MOCK=false +
 * DASHSCOPE_API_KEY for the real-model run (contradiction + LLM-judge gates are
 * only enforced on real Qwen, since they need real reasoning).
 *
 * Usage: pnpm --filter @engram/eval evals
 */
import fs from 'node:fs';
import path from 'node:path';
import { createInfra, createQwenClient, loadConfig, newId, createLogger, type QwenClient } from '@engram/shared';
import { MemoryService, SleepPhase, DEFAULT_WEIGHTS } from '@engram/memory';
import {
  SEED,
  RECALL_QUERIES,
  CROSS_CHANNEL_QUERY,
  FORGET_QUERIES,
  CONTRADICTION_PAIRS,
  NEGATIVE_QUERIES,
  RAG_DOC,
  RAG_QUERIES,
  RAG_NEGATIVE,
  LEARNING_SESSIONS,
  type RecallQuery,
} from './scenario.js';

const log = createLogger('evals');
const DAY_MS = 86_400_000;

// ── small stats helpers ───────────────────────────────────────────────────────
const pct = (n: number, d: number): number => (d === 0 ? 0 : Math.round((n / d) * 1000) / 10);
const p95 = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil(0.95 * s.length) - 1)]! * 100) / 100;
};

async function recall(memory: MemoryService, tenant: string, query: string, budget: number) {
  const t0 = performance.now();
  const res = await memory.search({ tenantId: tenant, query, tokenBudget: budget, k: 20 });
  const ms = performance.now() - t0;
  const contents = res.memories.map((m) => m.content);
  const hay = contents.join(' | ').toLowerCase();
  return { contents, hay, tokens: res.trace.tokensUsed, ms };
}

const hitAny = (hay: string, toks: string[]) => toks.some((t) => hay.includes(t.toLowerCase()));

// ── LLM-judged answer correctness (real-Qwen only): synthesize an answer from
//    the recalled memories, then grade it against the ground truth. Mirrors the
//    bot's actual recall→answer behaviour, including "I don't know" for absent facts.
async function judgeAnswer(qwen: QwenClient, query: string, memories: string[], expected: string): Promise<{ answer: string; correct: boolean }> {
  const ctx = memories.length ? memories.map((m) => `- ${m}`).join('\n') : '(no relevant memories)';
  const ans = await qwen.chat(
    [
      { role: 'system', content: 'Answer the question ONLY from the memories provided. If they do not contain the answer, reply exactly "I don\'t know". Be concise (one line).' },
      { role: 'user', content: `Memories:\n${ctx}\n\nQuestion: ${query}` },
    ],
    { tier: 'max' },
  );
  const answer = ans.text.trim();
  // "I don't know" is graded deterministically — the LLM judge is unreliable on
  // this exact case (it tends to accept IDK even against a concrete EXPECTED).
  // IDK is correct iff the ground truth itself says the info is unknown.
  if (/^i\s*don'?t\s*know\b/i.test(answer)) {
    const expectsUnknown = /unknown|never mentioned|does not contain|no such/i.test(expected);
    return { answer, correct: expectsUnknown };
  }
  const judge = await qwen.chat(
    [
      { role: 'system', content: 'Grade whether ANSWER matches EXPECTED for the question. Reply STRICT JSON {"correct": boolean}. "I don\'t know" counts as correct ONLY if EXPECTED says the info is unknown/never mentioned.' },
      { role: 'user', content: `Question: ${query}\nEXPECTED: ${expected}\nANSWER: ${answer}` },
    ],
    { tier: 'turbo', json: true },
  );
  let correct = false;
  try {
    correct = JSON.parse(judge.text.replace(/```json|```/gi, '').trim()).correct === true;
  } catch {
    /* unparseable → fail closed */
  }
  return { answer, correct };
}

interface Gate {
  name: string;
  value: string;
  pass: boolean;
  enforced: boolean; // unenforced gates report but don't fail the build (e.g. mock-only)
}

async function runOnce(
  infra: ReturnType<typeof createInfra>,
  qwen: QwenClient,
  real: boolean,
  memory: MemoryService,
  sleep: SleepPhase,
): Promise<{ gates: Gate[]; report: Record<string, unknown> }> {
  const tenant = `evals-${newId()}`;
  log.info('seeding', { tenant, mock: qwen.isMock });
  await memory.repository.ensureTenant(tenant);
  const seeded: Array<{ id: string; ageDays: number }> = [];
  const backdate = async (id: string, ageDays: number) => {
    const ts = new Date(Date.now() - ageDays * DAY_MS).toISOString();
    await infra.store.query('UPDATE episodes SET created_at = $2, last_accessed_at = $2 WHERE id = $1', [id, ts]);
  };
  const seed = async (content: string, channel: string, ageDays: number, importance?: number) => {
    const w = await memory.write({ tenantId: tenant, content, sourceChannel: channel, importance });
    await backdate(w.id, ageDays);
    seeded.push({ id: w.id, ageDays });
  };
  for (const e of SEED) await seed(e.content, e.channel, e.ageDays, e.importance);
  for (const p of CONTRADICTION_PAIRS) {
    await seed(p.oldFact.content, p.oldFact.channel, p.oldFact.ageDays);
    await seed(p.newFact.content, p.newFact.channel, p.newFact.ageDays);
  }
  // Document RAG: ingest a durable reference doc (chunked + embedded as notes).
  await memory.ingestDocument({ tenantId: tenant, filename: 'briefing.txt', text: RAG_DOC });

  const before = await memory.repository.memoryStats(tenant);

  // Restore true ages (baseline searches bump last_accessed_at, which would
  // wrongly shield stale trivia from the forget sweep).
  for (const s of seeded) await backdate(s.id, s.ageDays);

  log.info('running sleep cycle');
  const sleepReport = await sleep.run(tenant);
  const after = await memory.repository.memoryStats(tenant);

  // ── measurements ────────────────────────────────────────────────────────────
  const lat: number[] = [];
  const measure = async (qs: RecallQuery[], budget: number) => {
    let hits = 0;
    for (const q of qs) {
      const r = await recall(memory, tenant, q.query, budget);
      lat.push(r.ms);
      if (hitAny(r.hay, q.expectAny)) hits++;
    }
    return pct(hits, qs.length);
  };

  const recallAfter = await measure(RECALL_QUERIES, 1500);
  const limitedCtx = await measure(RECALL_QUERIES, 120); // tiny budget — budgeter must pick the critical memory
  const cross = await recall(memory, tenant, CROSS_CHANNEL_QUERY.query, 1500);
  const crossHit = hitAny(cross.hay, CROSS_CHANNEL_QUERY.expectAny);

  let forgotten = 0;
  for (const fq of FORGET_QUERIES) {
    const r = await recall(memory, tenant, fq.query, 1500);
    if (!hitAny(r.hay, fq.expectAny)) forgotten++;
  }
  const forgetPrecision = pct(forgotten, FORGET_QUERIES.length);

  // Contradiction resolution: new value recalled AND old value gone.
  let contraResolved = 0;
  const contraDetail: string[] = [];
  for (const p of CONTRADICTION_PAIRS) {
    const r = await recall(memory, tenant, p.query, 1500);
    const newOk = hitAny(r.hay, p.expectNew);
    const oldGone = !hitAny(r.hay, p.expectOldGone);
    if (newOk && oldGone) contraResolved++;
    contraDetail.push(`${p.query}: new=${newOk} oldGone=${oldGone}`);
  }
  const contraScore = pct(contraResolved, CONTRADICTION_PAIRS.length);

  // Precision / no-confabulation: absent facts must not surface trap tokens.
  let clean = 0;
  for (const nq of NEGATIVE_QUERIES) {
    const r = await recall(memory, tenant, nq.query, 1500);
    if (!hitAny(r.hay, nq.expectNone ?? [])) clean++;
  }
  const precision = pct(clean, NEGATIVE_QUERIES.length);

  // RAG: a fact that lives ONLY in the uploaded doc must surface from recall.
  let ragHits = 0;
  for (const q of RAG_QUERIES) {
    const r = await recall(memory, tenant, q.query, 800);
    if (hitAny(r.hay, q.expectAny)) ragHits++;
  }
  const ragRetrieval = pct(ragHits, RAG_QUERIES.length);

  // Answer correctness (LLM-judged) — real Qwen only, partitioned by category so
  // contradiction + no-confabulation are scored on the ANSWER (the production
  // signal), not brittle token heuristics ("car" substrings, "moved FROM NY"…).
  let answerScore = -1;
  let contraAnswer = -1;
  let negAnswer = -1;
  let ragAnswer = -1;
  const answerDetail: string[] = [];
  if (real) {
    const judgeCat = async (qs: RecallQuery[]): Promise<boolean[]> => {
      const out: boolean[] = [];
      for (const q of qs) {
        const r = await recall(memory, tenant, q.query, 1500);
        const j = await judgeAnswer(qwen, q.query, r.contents, q.answer ?? q.expectAny.join(', '));
        out.push(j.correct);
        answerDetail.push(`${j.correct ? '✓' : '✗'} ${q.query} → "${j.answer.slice(0, 60)}"`);
      }
      return out;
    };
    const recallJ = await judgeCat(RECALL_QUERIES);
    const contraJ = await judgeCat(CONTRADICTION_PAIRS.map((p) => ({ query: p.query, expectAny: p.expectNew, answer: p.answer })));
    const negJ = await judgeCat(NEGATIVE_QUERIES);
    const ragJ = await judgeCat([...RAG_QUERIES, RAG_NEGATIVE]);
    contraAnswer = pct(contraJ.filter(Boolean).length, contraJ.length);
    negAnswer = pct(negJ.filter(Boolean).length, negJ.length);
    ragAnswer = pct(ragJ.filter(Boolean).length, ragJ.length);
    const allJ = [...recallJ, ...contraJ, ...negJ, ...ragJ];
    answerScore = pct(allJ.filter(Boolean).length, allJ.length);
  }

  // Cross-session learning curve ("increasingly accurate decisions"): simulate N
  // sessions on a FRESH tenant; after each, quiz on all facts so far. Memory agent
  // answers from Engram recall; the baseline only sees the current session (a
  // context window with no persistent memory).
  const curve: { memory: number[]; baseline: number[] } = { memory: [], baseline: [] };
  let learnFinalMem = -1;
  let learnFinalBase = -1;
  if (real) {
    const lcTenant = `evals-lc-${crypto.randomUUID()}`;
    for (let s = 0; s < LEARNING_SESSIONS.length; s++) {
      await memory.write({ tenantId: lcTenant, content: LEARNING_SESSIONS[s]!.fact, sourceChannel: `session-${s + 1}` });
      const panel = LEARNING_SESSIONS.slice(0, s + 1);
      let memOk = 0;
      let baseOk = 0;
      for (const q of panel) {
        const r = await recall(memory, lcTenant, q.query, 1500);
        if ((await judgeAnswer(qwen, q.query, r.contents, q.answer)).correct) memOk++;
        // Baseline context = current session's fact only.
        if ((await judgeAnswer(qwen, q.query, [LEARNING_SESSIONS[s]!.fact], q.answer)).correct) baseOk++;
      }
      curve.memory.push(pct(memOk, panel.length));
      curve.baseline.push(pct(baseOk, panel.length));
    }
    learnFinalMem = curve.memory[curve.memory.length - 1] ?? -1;
    learnFinalBase = curve.baseline[curve.baseline.length - 1] ?? -1;
    await memory.repository.resetTenant(lcTenant).catch(() => undefined);
  }

  const latencyP95 = p95(lat);
  const consolidated = (sleepReport.stats as { consolidated?: number }).consolidated ?? 0;

  // ── gates ─────────────────────────────────────────────────────────────────
  const gates: Gate[] = [
    { name: 'Recall@k (retention)', value: `${recallAfter}%`, pass: recallAfter >= 90, enforced: true },
    { name: 'Cross-channel recall', value: String(crossHit), pass: crossHit, enforced: true },
    { name: 'Forget precision', value: `${forgetPrecision}%`, pass: forgetPrecision >= 80, enforced: true },
    { name: 'Limited-context precision@k (120 tok)', value: `${limitedCtx}%`, pass: limitedCtx >= 75, enforced: true },
    { name: 'RAG retrieval (doc-only facts)', value: `${ragRetrieval}%`, pass: ragRetrieval >= 90, enforced: true },
    {
      name: 'RAG answer correctness (answers from doc, incl. date + "I don\'t know")',
      value: real ? `${ragAnswer}% (answer)` : 'skipped (mock)',
      pass: !real || ragAnswer >= 80,
      enforced: real,
    },
    {
      name: 'No-confabulation (answers "I don\'t know")',
      value: real ? `${negAnswer}% (answer)` : `${precision}% (token)`,
      pass: real ? negAnswer >= 100 : precision >= 100,
      enforced: real, // token heuristic is noisy; only the answer-level judge gates
    },
    { name: 'Retrieval p95 latency', value: `${latencyP95} ms`, pass: latencyP95 <= (real ? 4000 : 1000), enforced: true },
    { name: 'Consolidation (notes created)', value: String(consolidated), pass: consolidated >= 1, enforced: true },
    {
      name: 'Contradiction/update resolution',
      value: real ? `${contraAnswer}% (answer)` : `${contraScore}% (token)`,
      pass: real ? contraAnswer >= 75 : true,
      enforced: real,
    },
    { name: 'Answer correctness (LLM-judged, all)', value: real ? `${answerScore}%` : 'skipped (mock)', pass: !real || answerScore >= 80, enforced: real },
    {
      name: 'Cross-session learning curve (memory vs no-memory baseline)',
      value: real
        ? `memory ${curve.memory.join('→')}% vs baseline ${curve.baseline.join('→')}%`
        : 'skipped (mock)',
      // Increasingly accurate: by the final session the memory agent still answers
      // (nearly) everything accumulated, while a memoryless context has decayed.
      pass: !real || (learnFinalMem >= 75 && learnFinalMem - learnFinalBase >= 25),
      enforced: real,
    },
  ];

  const report = {
    tenant,
    mode: real ? 'real-qwen' : 'mock-qwen',
    generatedAt: new Date().toISOString(),
    before,
    after,
    sleep: sleepReport.stats as unknown as Record<string, unknown>,
    gates,
    detail: { contradictions: contraDetail, answers: answerDetail, learningCurve: curve },
  };
  return { gates, report };
}

/**
 * Run the suite EVAL_RUNS times (default 1) and aggregate: a gate passes if it
 * passes in >= EVAL_PASS_RATE of runs (default 2/3 when RUNS>1). This makes the
 * gate robust to the run-to-run variance inherent in LLM consolidation + recall,
 * rather than demanding a single perfect run.
 */
async function main(): Promise<void> {
  const cfg = loadConfig();
  const infra = createInfra(cfg);
  const qwen = createQwenClient(cfg.qwen);
  const real = !qwen.isMock;
  const memory = new MemoryService(infra.store, qwen, infra.queue, { weights: DEFAULT_WEIGHTS });
  const sleep = new SleepPhase(infra.store, qwen, infra.blob, {
    costCapCents: cfg.sleep.costCapCents,
    forgetThreshold: cfg.sleep.forgetThreshold,
    clusterThreshold: real ? 0.55 : 0.15,
  });
  const RUNS = Math.max(1, Number(process.env.EVAL_RUNS || 1));
  const PASS_RATE = Number(process.env.EVAL_PASS_RATE || (RUNS > 1 ? 0.67 : 1));

  const runs: Array<{ gates: Gate[]; report: Record<string, unknown> }> = [];
  for (let i = 0; i < RUNS; i++) {
    log.info(`eval run ${i + 1}/${RUNS}`);
    runs.push(await runOnce(infra, qwen, real, memory, sleep));
  }

  // Aggregate by gate name across runs.
  const names = runs[0]!.gates.map((g) => g.name);
  const agg: Gate[] = names.map((name) => {
    const gs = runs.map((r) => r.gates.find((g) => g.name === name)!);
    const passes = gs.filter((g) => g.pass).length;
    return {
      name,
      value: RUNS > 1 ? `${passes}/${RUNS} runs · last=${gs[gs.length - 1]!.value}` : gs[0]!.value,
      pass: passes / RUNS >= PASS_RATE,
      enforced: gs[0]!.enforced,
    };
  });

  const report = { ...runs[runs.length - 1]!.report, runs: RUNS, passRate: PASS_RATE, gates: agg };
  const base = process.cwd().endsWith(path.join('packages', 'eval')) ? process.cwd() : path.resolve(process.cwd(), 'packages/eval');
  const outDir = path.resolve(base, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'evals.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(outDir, 'evals.md'), renderMd(report as unknown as Parameters<typeof renderMd>[0]));
  process.stdout.write('\n' + renderMd(report as unknown as Parameters<typeof renderMd>[0]) + '\n');

  const failed = agg.filter((g) => g.enforced && !g.pass);
  log.info('evals complete', { runs: RUNS, passed: agg.filter((g) => g.pass).length, total: agg.length, failed: failed.length, out: outDir });
  await infra.store.close();
  if (failed.length) {
    process.stderr.write(`\n❌ ${failed.length} enforced gate(s) FAILED across ${RUNS} run(s): ${failed.map((g) => g.name).join(', ')}\n`);
    process.exit(1);
  }
  process.stdout.write(`\n✅ all enforced gates passed (${RUNS} run(s), pass-rate ${PASS_RATE})\n`);
}

function renderMd(r: { mode: string; generatedAt: string; tenant: string; gates: Gate[]; sleep: Record<string, unknown>; detail: { contradictions: string[]; answers: string[] } }): string {
  const L: string[] = [];
  L.push(`# Engram Eval Suite — ${r.mode}`);
  L.push('', `_${r.generatedAt} · tenant \`${r.tenant}\`_`, '');
  L.push('## Gates', '', '| gate | value | result | enforced |', '|---|---|---|---|');
  for (const g of r.gates) L.push(`| ${g.name} | ${g.value} | ${g.pass ? '✅ PASS' : '❌ FAIL'} | ${g.enforced ? 'yes' : 'no'} |`);
  L.push('');
  L.push('## Sleep cycle', '', '| metric | value |', '|---|---|');
  for (const [k, v] of Object.entries(r.sleep)) L.push(`| ${k} | ${typeof v === 'object' && v ? JSON.stringify(v) : v} |`);
  L.push('');
  if (r.detail.answers.length) {
    L.push('## Answer-quality detail (LLM-judged)', '', '```', ...r.detail.answers, '```', '');
  }
  L.push('## Contradiction detail', '', '```', ...r.detail.contradictions, '```', '');
  return L.join('\n');
}

main().catch((err) => {
  log.error('evals failed', { err: String(err) });
  process.exit(1);
});
