/**
 * Personalized PageRank over the per-tenant knowledge graph — single-pass
 * multi-hop retrieval (HippoRAG). Probability mass starts on the query's seed
 * entities and spreads across the graph; nodes that are reachable from many seeds
 * (multi-hop associations) accumulate mass. This replaces naive 1-hop expansion
 * with associative recall in one shot.
 *
 *   seeds (query entities) ──teleport──┐
 *                                       ▼
 *          r = α·s + (1-α)·Wᵀr   (power iteration; W = row-normalized adjacency)
 *                                       ▼
 *                       node scores → aggregated onto notes
 *
 * Pure + deterministic so it's unit-testable with no DB. The graph is treated as
 * undirected (associative memory spreads both ways); edge weight scales transition.
 */

export interface PprNode {
  id: string;
}
export interface PprEdge {
  src: string;
  dst: string;
  weight: number;
}

export interface PprOptions {
  /** Teleport-to-seeds probability (restart). Higher = stay closer to seeds.
   *  Default 0.5 = strong personalization (seeds stay dominant) while still
   *  spreading multi-hop; lower values let graph degree dominate. */
  alpha?: number;
  maxIters?: number;
  tolerance?: number;
}

/**
 * @param nodeIds all node ids in the tenant graph
 * @param edges   undirected associations (each counted both directions internally)
 * @param seeds   map of seedNodeId -> seed weight (need not be normalized)
 * @returns map of nodeId -> PageRank score (sums to ~1 over reachable mass)
 */
export function personalizedPageRank(
  nodeIds: string[],
  edges: PprEdge[],
  seeds: Map<string, number>,
  opts: PprOptions = {},
): Map<string, number> {
  const alpha = opts.alpha ?? 0.5;
  const maxIters = opts.maxIters ?? 50;
  const tol = opts.tolerance ?? 1e-6;

  const n = nodeIds.length;
  const result = new Map<string, number>();
  if (n === 0) return result;

  const index = new Map<string, number>();
  nodeIds.forEach((id, i) => index.set(id, i));

  // Build undirected weighted adjacency (out-neighbors with weights).
  const out: Array<Array<{ j: number; w: number }>> = Array.from({ length: n }, () => []);
  const outWeight = new Array<number>(n).fill(0);
  for (const e of edges) {
    const i = index.get(e.src);
    const j = index.get(e.dst);
    if (i === undefined || j === undefined || i === j) continue;
    const w = e.weight > 0 ? e.weight : 1;
    out[i]!.push({ j, w });
    out[j]!.push({ j: i, w });
    outWeight[i]! += w;
    outWeight[j]! += w;
  }

  // Restart distribution s from seeds (normalized). If no valid seeds, uniform.
  const s = new Array<number>(n).fill(0);
  let seedSum = 0;
  for (const [id, w] of seeds) {
    const i = index.get(id);
    if (i === undefined) continue;
    const ww = w > 0 ? w : 0;
    s[i]! += ww;
    seedSum += ww;
  }
  if (seedSum === 0) {
    for (let i = 0; i < n; i++) s[i] = 1 / n;
  } else {
    for (let i = 0; i < n; i++) s[i]! /= seedSum;
  }

  // Power iteration: r = α·s + (1-α)·(W r), W row-normalized by out-weight.
  // Dangling nodes (no out-weight) teleport their mass back via s.
  let r = s.slice();
  for (let iter = 0; iter < maxIters; iter++) {
    const next = new Array<number>(n).fill(0);
    let dangling = 0;
    for (let i = 0; i < n; i++) {
      if (outWeight[i] === 0) {
        dangling += r[i]!;
        continue;
      }
      const share = r[i]! / outWeight[i]!;
      for (const { j, w } of out[i]!) next[j]! += share * w;
    }
    let diff = 0;
    for (let i = 0; i < n; i++) {
      const val = alpha * s[i]! + (1 - alpha) * (next[i]! + dangling * s[i]!);
      diff += Math.abs(val - r[i]!);
      next[i] = val;
    }
    r = next;
    if (diff < tol) break;
  }

  for (let i = 0; i < n; i++) result.set(nodeIds[i]!, r[i]!);
  return result;
}

/** Min-max normalize a score map to [0,1]. */
export function normalizeScores(scores: Map<string, number>): Map<string, number> {
  let min = Infinity;
  let max = -Infinity;
  for (const v of scores.values()) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const out = new Map<string, number>();
  const range = max - min;
  for (const [k, v] of scores) out.set(k, range > 0 ? (v - min) / range : 0);
  return out;
}
