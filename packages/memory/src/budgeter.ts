import type { PackCandidate, PackingTrace } from '@engram/shared';

/**
 * Context budgeter — treats retrieval as a constrained packing problem.
 *
 * Each candidate is scored:
 *   score = w1·relevance + w2·recency_decay + w3·importance + w4·diversity
 * then we greedily pack under `tokenBudget`. `diversity` is computed MMR-style
 * relative to what's already been selected, so the pack doesn't fill up with five
 * near-duplicate memories — it recomputes each round. The full decision (every
 * candidate, its score breakdown, included or not) is returned as a trace so the
 * demo can show *why* each memory made the cut.
 *
 *        candidates ──score──▶ greedy pick highest ──fits budget?──▶ select
 *             ▲                                                         │
 *             └──────────── recompute diversity vs selected ◀──────────┘
 */

export interface BudgeterCandidate {
  kind: 'episode' | 'note' | 'core';
  id: string;
  content: string;
  tokens: number;
  /** 0..1 — how well it matches the query (from vector/keyword/rerank). */
  relevance: number;
  /** 0..1 — intrinsic importance. */
  importance: number;
  /** Age in ms (for recency decay). */
  ageMs: number;
  /** Optional embedding for diversity; falls back to token-overlap if absent. */
  embedding?: number[];
}

export interface BudgeterWeights {
  relevance: number;
  recency: number;
  importance: number;
  diversity: number;
}

export const DEFAULT_WEIGHTS: BudgeterWeights = {
  relevance: 0.5,
  recency: 0.2,
  importance: 0.2,
  diversity: 0.1,
};

export interface BudgeterOptions {
  tokenBudget: number;
  weights?: BudgeterWeights;
  recencyHalfLifeMs?: number;
}

const DAY_MS = 86_400_000;

export function packContext(candidates: BudgeterCandidate[], opts: BudgeterOptions): PackingTrace {
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const halfLife = opts.recencyHalfLifeMs ?? 7 * DAY_MS;

  const recencyRaw = (ageMs: number) => Math.pow(0.5, Math.max(0, ageMs) / halfLife);

  // Min-max normalize each component across the candidate set so the weights are
  // comparable (Generative Agents). Without this, a raw ts_rank ~0.05 and a cosine
  // ~0.8 would be weighted on incomparable scales.
  const normRelevance = minMax(candidates.map((c) => c.relevance));
  const normRecency = minMax(candidates.map((c) => recencyRaw(c.ageMs)));
  const normImportance = minMax(candidates.map((c) => c.importance));
  const comp = new Map<string, { relevance: number; recency: number; importance: number }>();
  candidates.forEach((c, i) => comp.set(c.id, { relevance: normRelevance[i]!, recency: normRecency[i]!, importance: normImportance[i]! }));

  const selected: BudgeterCandidate[] = [];
  const remaining = [...candidates];
  const traceById = new Map<string, PackCandidate>();
  let tokensUsed = 0;

  // Seed the trace so every candidate appears even if never selected.
  for (const c of candidates) {
    const k = comp.get(c.id)!;
    traceById.set(c.id, {
      kind: c.kind,
      id: c.id,
      content: c.content,
      tokens: c.tokens,
      relevance: round(k.relevance),
      recency: round(k.recency),
      importance: round(k.importance),
      diversity: 0,
      score: 0,
      included: false,
    });
  }

  while (remaining.length > 0) {
    let best: { idx: number; score: number; diversity: number } | null = null;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]!;
      const k = comp.get(c.id)!;
      const diversity = diversityVs(c, selected);
      const score =
        weights.relevance * k.relevance +
        weights.recency * k.recency +
        weights.importance * k.importance +
        weights.diversity * diversity;
      if (!best || score > best.score) best = { idx: i, score, diversity };
    }
    if (!best) break;
    const chosen = remaining[best.idx]!;
    // Update the trace entry with the diversity/score it had at decision time.
    const t = traceById.get(chosen.id)!;
    t.diversity = round(best.diversity);
    t.score = round(best.score);

    if (tokensUsed + chosen.tokens <= opts.tokenBudget) {
      t.included = true;
      tokensUsed += chosen.tokens;
      selected.push(chosen);
    }
    remaining.splice(best.idx, 1);
  }

  return {
    tokenBudget: opts.tokenBudget,
    tokensUsed,
    weights,
    candidates: candidates.map((c) => traceById.get(c.id)!),
  };
}

/** Diversity = 1 - max similarity to any already-selected candidate. */
function diversityVs(c: BudgeterCandidate, selected: BudgeterCandidate[]): number {
  if (selected.length === 0) return 1;
  let maxSim = 0;
  for (const s of selected) {
    const sim = c.embedding && s.embedding ? cosine(c.embedding, s.embedding) : jaccard(c.content, s.content);
    if (sim > maxSim) maxSim = sim;
  }
  return 1 - clamp01(maxSim);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function jaccard(a: string, b: string): number {
  const ta = new Set(tok(a));
  const tb = new Set(tok(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

function tok(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Min-max normalize an array to [0,1]; all-equal inputs map to 0.5 (neutral). */
function minMax(values: number[]): number[] {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const range = max - min;
  return values.map((v) => (range > 0 ? (v - min) / range : 0.5));
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** Cheap token estimate (~4 chars/token) used when packing by token budget. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}
