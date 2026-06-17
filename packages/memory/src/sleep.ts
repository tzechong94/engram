import {
  type Store,
  type QwenClient,
  type Blob,
  type SleepCycleStats,
  type Episode,
  type SemanticNote,
  createLogger,
  encrypt,
} from '@engram/shared';
import { MemoryRepo, emptyStats } from './repo.js';
import { cosine } from './budgeter.js';
import { decideForget } from './decay.js';

const log = createLogger('sleep');

export interface SleepOptions {
  costCapCents: number;
  forgetThreshold: number;
  /** cents per 1k tokens, for the cost ceiling (rough Qwen-Max blended rate). */
  centsPerKTok?: number;
  clusterThreshold?: number; // cosine sim to join a cluster
  maxReconcilePairs?: number;
  maxSynthesisPairs?: number;
}

const STEPS = ['forget', 'cluster', 'consolidate', 'graph', 'reconcile', 'synthesize', 'profile'] as const;
type Step = (typeof STEPS)[number];

/**
 * The sleep / REM cycle — the hero. Runs offline on durable memory during the
 * user's downtime. Each step checkpoints, the whole cycle is cost-bounded per
 * tenant, and it emits an observable stats report (consolidated / forgotten /
 * reconciled / connected) that the demo shows as before→after.
 *
 *  cluster → consolidate → graph-merge → forget → reconcile → synthesize
 *     │          │             │           │          │           │
 *     └──────────┴──── checkpoint after each; stop cleanly if cost cap hit ──┘
 */
export class SleepPhase {
  private repo: MemoryRepo;
  private centsPerKTok: number;
  private clusterThreshold: number;
  private maxReconcilePairs: number;
  private maxSynthesisPairs: number;

  constructor(
    private store: Store,
    private qwen: QwenClient,
    private blob: Blob,
    private opts: SleepOptions,
  ) {
    this.repo = new MemoryRepo(store);
    this.centsPerKTok = opts.centsPerKTok ?? 0.2;
    this.clusterThreshold = opts.clusterThreshold ?? 0.55;
    this.maxReconcilePairs = opts.maxReconcilePairs ?? 20;
    this.maxSynthesisPairs = opts.maxSynthesisPairs ?? 10;
  }

  /** Run a full cycle for one tenant. Returns the stats report. */
  async run(tenantId: string): Promise<{ cycleId: string; status: string; stats: SleepCycleStats; before: unknown; after: unknown }> {
    const before = await this.repo.memoryStats(tenantId);
    const cycleId = await this.repo.createSleepCycle(tenantId);
    const stats = emptyStats();
    const budget = { tokens: 0 };
    let status = 'completed';
    log.info('sleep cycle start', { tenantId, cycleId });

    try {
      // 1. FORGET SWEEP first — prune stale, low-value episodes before consolidation
      //    so junk never pollutes the durable notes (prune, then consolidate).
      stats.forgotten = await this.forgetSweep(tenantId);
      await this.checkpoint(cycleId, 'forget', stats);

      // 2. CLUSTER the survivors
      const episodes = await this.repo.recentActiveEpisodes(tenantId, 500);
      stats.episodesScanned = episodes.length;
      const clusters = clusterByEmbedding(episodes, this.clusterThreshold);
      stats.clusters = clusters.length;
      await this.checkpoint(cycleId, 'cluster', stats);

      // 2. CONSOLIDATE (+ collect notes for later steps)
      const newNotes: Array<{ id: string; title: string; body: string; embedding: number[] | null }> = [];
      for (const cluster of clusters) {
        if (cluster.length < 2) continue; // singletons stay as episodes
        if (this.overBudget(budget, stats)) {
          status = 'partial';
          break;
        }
        const note = await this.consolidate(tenantId, cluster, budget);
        if (note) {
          stats.consolidated++;
          newNotes.push(note);
        }
      }
      await this.checkpoint(cycleId, 'consolidate', stats);

      // 3. GRAPH MERGE
      if (status !== 'partial') {
        for (const note of newNotes) {
          if (this.overBudget(budget, stats)) {
            status = 'partial';
            break;
          }
          const merged = await this.graphMerge(tenantId, note, budget);
          stats.entitiesMerged += merged.entities;
          stats.edgesMerged += merged.edges;
        }
        await this.checkpoint(cycleId, 'graph', stats);
      }

      // 5. RECONCILE CONTRADICTIONS
      if (status !== 'partial') {
        stats.contradictionsResolved = await this.reconcile(tenantId, budget, stats);
        await this.checkpoint(cycleId, 'reconcile', stats);
      }

      // 6. SYNTHESIZE NEW CONNECTIONS
      if (status !== 'partial') {
        stats.connectionsSynthesized = await this.synthesize(tenantId, budget, stats);
        await this.checkpoint(cycleId, 'synthesize', stats);
      }

      // 7. CORE PROFILE — maintain the bounded human-readable per-tenant profile
      //    (the "learned context" the agent reads first). Cheap, always attempted.
      if (!this.overBudget(budget, stats)) {
        await this.maintainCoreProfile(tenantId, budget);
        await this.checkpoint(cycleId, 'profile', stats);
      }
    } catch (err) {
      log.error('sleep cycle error', { tenantId, cycleId, err: String(err) });
      status = 'failed';
    }

    stats.tokensUsed = budget.tokens;
    stats.costCents = this.cents(budget.tokens);
    // Mem0-style op accounting: consolidations + syntheses are ADDs; reconcile
    // deletes/noops were tallied during that step.
    stats.memoryOps.add = stats.consolidated + stats.connectionsSynthesized;
    await this.repo.finishSleepCycle(cycleId, status, stats);
    const after = await this.repo.memoryStats(tenantId);
    log.info('sleep cycle done', { tenantId, cycleId, status, stats });
    return { cycleId, status, stats, before, after };
  }

  // ── steps ───────────────────────────────────────────────────────────────

  private async consolidate(
    tenantId: string,
    cluster: Episode[],
    budget: { tokens: number },
  ): Promise<{ id: string; title: string; body: string; embedding: number[] | null } | null> {
    const bullets = cluster.map((e) => `- ${e.content}`).join('\n');
    const res = await this.qwen.chat(
      [
        { role: 'system', content: 'You consolidate raw episodic memories into one durable semantic note about the user. Reply with strict JSON: {"title": string, "body": string, "confidence": number 0..1, "importance": integer 1..10}. The body should be a concise, general fact or preference, not a transcript. Importance = how central this is to understanding the user (10 = defining trait/relationship, 1 = trivia).' },
        { role: 'user', content: `Consolidate these related memories into one semantic note:\n${bullets}` },
      ],
      { tier: 'max', json: true },
    );
    budget.tokens += res.promptTokens + res.completionTokens;
    const parsed = safeJson<{ title: string; body: string; confidence: number; importance?: number }>(res.text);
    if (!parsed?.title || !parsed?.body) {
      log.warn('consolidate: bad JSON, skipping cluster', { size: cluster.length });
      return null;
    }
    const [embedding] = await this.qwen.embed([`${parsed.title}: ${parsed.body}`]).catch(() => [null]);
    const noteId = await this.repo.insertNote({
      tenantId,
      title: parsed.title,
      body: parsed.body,
      embedding: embedding ?? null,
      confidence: clamp01(parsed.confidence ?? 0.7),
      importance: clamp01((parsed.importance ?? 7) / 10), // LLM 1-10 → 0..1 (M4)
      sourceEpisodeIds: cluster.map((e) => e.id),
      kind: 'consolidation',
    });
    await this.repo.markConsolidated(tenantId, cluster.map((e) => e.id), noteId);

    // Archive the raw episodic content to encrypted cold blob (recoverable, off hot path).
    await this.blob
      .put(`${tenantId}/episodes/${noteId}.json`, encrypt(JSON.stringify(cluster.map((e) => ({ id: e.id, content: e.content })))))
      .catch((err) => log.warn('cold archive failed (non-fatal)', { err: String(err) }));

    return { id: noteId, title: parsed.title, body: parsed.body, embedding: embedding ?? null };
  }

  private async graphMerge(
    tenantId: string,
    note: { id: string; title: string; body: string },
    budget: { tokens: number },
  ): Promise<{ entities: number; edges: number }> {
    const res = await this.qwen.chat(
      [
        { role: 'system', content: 'Extract a small knowledge graph from the note. Reply strict JSON: {"entities":[{"name":string,"type":string}],"edges":[{"src":string,"dst":string,"relation":string}]}. Names are canonical (lowercase, singular).' },
        { role: 'user', content: `Note: ${note.title}: ${note.body}` },
      ],
      { tier: 'turbo', json: true },
    );
    budget.tokens += res.promptTokens + res.completionTokens;
    const parsed = safeJson<{ entities?: Array<{ name: string; type: string }>; edges?: Array<{ src: string; dst: string; relation: string }> }>(res.text);
    if (!parsed) return { entities: 0, edges: 0 };

    const entityIds = new Map<string, string>();
    const names = (parsed.entities ?? []).map((e) => e.name).filter(Boolean);
    const embeddings = names.length ? await this.qwen.embed(names).catch(() => names.map(() => null)) : [];
    let ei = 0;
    for (const ent of parsed.entities ?? []) {
      if (!ent.name) continue;
      const id = await this.repo.upsertEntity(tenantId, ent.name.toLowerCase(), ent.type || 'concept', embeddings[ei] ?? null);
      entityIds.set(ent.name.toLowerCase(), id);
      ei++;
    }
    let edges = 0;
    for (const edge of parsed.edges ?? []) {
      const src = entityIds.get((edge.src ?? '').toLowerCase());
      const dst = entityIds.get((edge.dst ?? '').toLowerCase());
      if (!src || !dst || src === dst) continue;
      await this.repo.upsertEdge({ tenantId, src, dst, relation: edge.relation || 'related', evidenceNoteId: note.id });
      edges++;
    }
    return { entities: entityIds.size, edges };
  }

  private async forgetSweep(tenantId: string): Promise<number> {
    const episodes = await this.repo.allActiveEpisodesForDecay(tenantId);
    const now = Date.now();
    const toForget: string[] = [];
    for (const e of episodes) {
      const d = decideForget(
        {
          importance: e.importance,
          ageMs: now - new Date(e.createdAt).getTime(),
          accessCount: e.accessCount,
          lastAccessedAgeMs: now - new Date(e.lastAccessedAt).getTime(),
        },
        this.opts.forgetThreshold,
      );
      if (d.forget) toForget.push(e.id);
    }
    await this.repo.forgetEpisodes(tenantId, toForget);
    return toForget.length;
  }

  private async reconcile(tenantId: string, budget: { tokens: number }, stats: SleepCycleStats): Promise<number> {
    const notes = await this.repo.activeNotes(tenantId);
    const pairs = highSimilarityPairs(notes, 0.6, this.maxReconcilePairs);
    let resolved = 0;
    for (const [a, b] of pairs) {
      if (this.overBudget(budget, stats)) break;
      const res = await this.qwen.chat(
        [
          { role: 'system', content: 'Two notes may conflict. Reply strict JSON: {"contradictory": boolean, "keep": "a"|"b", "resolution": string}. If both can be true, contradictory=false.' },
          { role: 'user', content: `A: ${a.title}: ${a.body}\nB: ${b.title}: ${b.body}` },
        ],
        { tier: 'turbo', json: true },
      );
      budget.tokens += res.promptTokens + res.completionTokens;
      const parsed = safeJson<{ contradictory: boolean; keep: 'a' | 'b'; resolution: string }>(res.text);
      if (parsed?.contradictory) {
        const loser = parsed.keep === 'a' ? b : a;
        const winner = parsed.keep === 'a' ? a : b;
        await this.repo.recordContradiction(tenantId, a.id, b.id, parsed.resolution || `kept ${parsed.keep}`);
        await this.repo.supersedeNote(tenantId, loser.id, winner.id); // invalidates (bi-temporal)
        stats.memoryOps.delete++; // Mem0-style: the stale memory is removed from the active set
        resolved++;
      } else {
        stats.memoryOps.noop++;
      }
    }
    return resolved;
  }

  private async synthesize(tenantId: string, budget: { tokens: number }, stats: SleepCycleStats): Promise<number> {
    const notes = await this.repo.activeNotes(tenantId);
    // Candidate pairs: moderately related (some overlap) but not near-duplicate.
    const pairs = midSimilarityPairs(notes, 0.3, 0.6, this.maxSynthesisPairs);
    let created = 0;
    for (const [a, b] of pairs) {
      if (this.overBudget(budget, stats)) break;
      const res = await this.qwen.chat(
        [
          { role: 'system', content: 'Find a non-obvious connection between two notes that neither states alone. Reply strict JSON: {"connection": boolean, "title": string, "body": string}. Only connection=true if there is a genuine new insight.' },
          { role: 'user', content: `Note 1: ${a.title}: ${a.body}\nNote 2: ${b.title}: ${b.body}` },
        ],
        { tier: 'max', json: true },
      );
      budget.tokens += res.promptTokens + res.completionTokens;
      const parsed = safeJson<{ connection: boolean; title: string; body: string }>(res.text);
      if (parsed?.connection && parsed.title && parsed.body) {
        const [embedding] = await this.qwen.embed([`${parsed.title}: ${parsed.body}`]).catch(() => [null]);
        await this.repo.insertNote({
          tenantId,
          title: parsed.title,
          body: parsed.body,
          embedding: embedding ?? null,
          confidence: 0.6,
          sourceEpisodeIds: [],
          kind: 'synthesis',
        });
        created++;
      }
    }
    return created;
  }

  private async maintainCoreProfile(tenantId: string, budget: { tokens: number }): Promise<void> {
    const notes = await this.repo.activeNotes(tenantId);
    if (notes.length === 0) return;
    const top = [...notes].sort((a, b) => b.importance - a.importance).slice(0, 15);
    const bullets = top.map((n) => `- ${n.title}: ${n.body}`).join('\n');
    const res = await this.qwen.chat(
      [
        { role: 'system', content: 'Write a concise profile of the user from their semantic notes — the durable facts, preferences, and relationships an assistant should always know. Plain prose, <= 1200 chars. Reply with strict JSON: {"profile": string}.' },
        { role: 'user', content: bullets },
      ],
      { tier: 'max', json: true },
    );
    budget.tokens += res.promptTokens + res.completionTokens;
    const parsed = safeJson<{ profile: string }>(res.text);
    if (parsed?.profile) {
      await this.repo.upsertCoreBlock({ tenantId, label: 'profile', body: parsed.profile, sizeLimit: 2000, fromSleep: true });
    }
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private overBudget(budget: { tokens: number }, stats: SleepCycleStats): boolean {
    const over = this.cents(budget.tokens) >= this.opts.costCapCents;
    if (over) log.warn('sleep cost cap reached; stopping cleanly', { cents: this.cents(budget.tokens), cap: this.opts.costCapCents });
    return over;
  }

  private cents(tokens: number): number {
    return (tokens / 1000) * this.centsPerKTok;
  }

  private async checkpoint(cycleId: string, step: Step, stats: SleepCycleStats): Promise<void> {
    await this.repo.saveCheckpoint(cycleId, { lastStep: step, at: new Date().toISOString() }, stats);
  }
}

/** Greedy single-pass clustering on embeddings (cosine). Episodes without an
 *  embedding each form their own singleton (so they're never lost, just not merged). */
export function clusterByEmbedding(episodes: Episode[], threshold: number): Episode[][] {
  const clusters: { centroid: number[]; items: Episode[] }[] = [];
  for (const e of episodes) {
    if (!e.embedding) {
      clusters.push({ centroid: [], items: [e] });
      continue;
    }
    let best: { idx: number; sim: number } | null = null;
    for (let i = 0; i < clusters.length; i++) {
      const c = clusters[i]!;
      if (c.centroid.length === 0) continue;
      const sim = cosine(e.embedding, c.centroid);
      if (!best || sim > best.sim) best = { idx: i, sim };
    }
    if (best && best.sim >= threshold) {
      const c = clusters[best.idx]!;
      c.items.push(e);
      c.centroid = meanVec(c.items.map((x) => x.embedding!).filter(Boolean));
    } else {
      clusters.push({ centroid: e.embedding.slice(), items: [e] });
    }
  }
  return clusters.map((c) => c.items);
}

function meanVec(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]!.length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) out[i]! += v[i] ?? 0;
  for (let i = 0; i < dim; i++) out[i]! /= vectors.length;
  return out;
}

function notePairsBySim(
  notes: SemanticNote[],
  pred: (sim: number) => boolean,
  max: number,
): Array<[SemanticNote, SemanticNote]> {
  const out: Array<[SemanticNote, SemanticNote, number]> = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const a = notes[i]!;
      const b = notes[j]!;
      if (!a.embedding || !b.embedding) continue;
      const sim = cosine(a.embedding, b.embedding);
      if (pred(sim)) out.push([a, b, sim]);
    }
  }
  out.sort((x, y) => y[2] - x[2]);
  return out.slice(0, max).map(([a, b]) => [a, b]);
}

export function highSimilarityPairs(notes: SemanticNote[], min: number, max: number): Array<[SemanticNote, SemanticNote]> {
  return notePairsBySim(notes, (s) => s >= min, max);
}

export function midSimilarityPairs(notes: SemanticNote[], lo: number, hi: number, max: number): Array<[SemanticNote, SemanticNote]> {
  return notePairsBySim(notes, (s) => s >= lo && s < hi, max);
}

function safeJson<T>(text: string): T | null {
  try {
    const cleaned = text.trim().replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    return JSON.parse(cleaned) as T;
  } catch {
    return null;
  }
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
