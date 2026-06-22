import {
  type Store,
  type Queue,
  type QwenClient,
  createLogger,
  type SearchResult,
} from '@engram/shared';
import { MemoryRepo } from './repo.js';
import { packContext, estimateTokens, type BudgeterCandidate, DEFAULT_WEIGHTS, type BudgeterWeights } from './budgeter.js';
import { personalizedPageRank, normalizeScores } from './ppr.js';

const log = createLogger('memory');
const DLQ_TOPIC = 'dead_letter';
/** Below this edge count, PPR adds little over 1-hop expansion — use the fallback. */
const PPR_MIN_EDGES = 2;

export interface WriteResult {
  id: string;
  deduped: boolean;
  embedded: boolean;
  queued: boolean;
}

export interface MemoryServiceOptions {
  weights?: BudgeterWeights;
  recencyHalfLifeMs?: number;
}

/**
 * The online path. Fast and cheap by design — capture + retrieve only. All heavy
 * cognition (consolidation, contradiction, synthesis) is deferred to the sleep
 * phase. This class is the surface the MCP server wraps and is fully usable as a
 * library (Desk reuse) and testable with the agent turned off.
 */
export class MemoryService {
  private repo: MemoryRepo;
  private weights: BudgeterWeights;
  private recencyHalfLifeMs: number;

  constructor(
    private store: Store,
    private qwen: QwenClient,
    private queue: Queue,
    opts: MemoryServiceOptions = {},
  ) {
    this.repo = new MemoryRepo(store);
    this.weights = opts.weights ?? DEFAULT_WEIGHTS;
    this.recencyHalfLifeMs = opts.recencyHalfLifeMs ?? 7 * 86_400_000;
  }

  get repository(): MemoryRepo {
    return this.repo;
  }

  /**
   * Episodic write: embed + idempotent insert. If embedding fails after retries,
   * the episode is still inserted (embedding NULL) and a re-embed job is queued
   * to the dead-letter — a write is never dropped (brief's hardening requirement).
   */
  async write(args: {
    tenantId: string;
    content: string;
    sourceChannel?: string;
    importance?: number;
  }): Promise<WriteResult> {
    const tenantId = args.tenantId;
    const content = args.content.trim();
    if (!content) throw new Error('memory.write: content is empty');
    await this.repo.ensureTenant(tenantId);

    const importance = args.importance ?? heuristicImportance(content);
    const sourceChannel = args.sourceChannel ?? 'unknown';

    let embedding: number[] | null = null;
    let embedded = false;
    let queued = false;
    try {
      const [vec] = await this.qwen.embed([content]);
      embedding = vec ?? null;
      embedded = embedding != null;
    } catch (err) {
      log.warn('embed failed on write; inserting without embedding + queueing re-embed', {
        tenantId,
        err: String(err),
      });
    }

    const { id, deduped } = await this.repo.insertEpisode({
      tenantId,
      content,
      embedding,
      sourceChannel,
      importance,
    });

    if (!embedded && !deduped) {
      await this.queue.push(DLQ_TOPIC, { op: 'reembed', tenantId, episodeId: id });
      queued = true;
    }

    log.info('memory.write', { tenantId, id, deduped, embedded, sourceChannel, importance });
    return { id, deduped, embedded, queued };
  }

  /**
   * Ingest an uploaded document as durable, searchable knowledge (the RAG path).
   * Chunks the text, embeds each chunk, and stores them as semantic notes with
   * kind 'document'. Durable by design: documents are reference material, so the
   * forget sweep and the sleep reconcile both skip kind 'document' — they are
   * never decayed or rewritten. The chunks join the SAME recall candidate pool
   * the agent already searches every turn, so retrieval is automatic: ask about
   * something only in the file and the matching chunk surfaces in context. No
   * separate RAG pipeline.
   */
  async ingestDocument(args: {
    tenantId: string;
    filename: string;
    text: string;
  }): Promise<{ filename: string; chunks: number; embedded: number }> {
    const tenantId = args.tenantId;
    const text = args.text.replace(/\r\n/g, '\n').trim();
    if (!text) throw new Error('ingestDocument: empty text');
    await this.repo.ensureTenant(tenantId);

    const chunks = this.chunkText(text);
    let embeddings: number[][] = [];
    try {
      embeddings = await this.qwen.embed(chunks);
    } catch (err) {
      log.warn('embed failed on document ingest; storing chunks without embeddings', {
        tenantId,
        err: String(err),
      });
    }

    let embedded = 0;
    for (let i = 0; i < chunks.length; i++) {
      const emb = embeddings[i] ?? null;
      if (emb) embedded++;
      await this.repo.insertNote({
        tenantId,
        title: `${args.filename} · part ${i + 1}/${chunks.length}`,
        body: chunks[i]!,
        embedding: emb,
        confidence: 0.9,
        importance: 0.8,
        sourceEpisodeIds: [],
        kind: 'document',
      });
    }

    log.info('memory.ingestDocument', { tenantId, filename: args.filename, chunks: chunks.length, embedded });
    return { filename: args.filename, chunks: chunks.length, embedded };
  }

  /** Split text into ~maxChars chunks on paragraph boundaries, with overlap for context continuity. */
  private chunkText(text: string, maxChars = 2400, overlap = 200): string[] {
    const clean = text.replace(/\n{3,}/g, '\n\n').trim();
    if (!clean) return [];
    if (clean.length <= maxChars) return [clean];
    const paras = clean.split(/\n\n+/);
    const chunks: string[] = [];
    let cur = '';
    const flush = (): void => {
      if (cur.trim()) chunks.push(cur.trim());
      cur = '';
    };
    for (const p of paras) {
      if (p.length > maxChars) {
        flush();
        for (let i = 0; i < p.length; i += maxChars - overlap) chunks.push(p.slice(i, i + maxChars));
        continue;
      }
      if ((cur + '\n\n' + p).length > maxChars) flush();
      cur = cur ? cur + '\n\n' + p : p;
    }
    flush();
    return chunks;
  }

  /**
   * Hybrid recall → rerank → context budgeter. Returns the packed memories AND
   * the full packing trace (the demo surfaces the trace). Bumps access on every
   * episode that made the pack (feeds the decay/forget signal).
   */
  async search(args: {
    tenantId: string;
    query: string;
    tokenBudget?: number;
    k?: number;
  }): Promise<SearchResult> {
    const { tenantId, query } = args;
    const tokenBudget = args.tokenBudget ?? 1500;
    const k = args.k ?? 20;

    let queryEmbedding: number[] | null = null;
    try {
      const [vec] = await this.qwen.embed([query]);
      queryEmbedding = vec ?? null;
    } catch (err) {
      log.warn('embed failed on search; keyword-only fallback', { err: String(err) });
    }

    // Gather candidates from all three recall modes.
    const byId = new Map<string, BudgeterCandidate & { createdMs: number }>();
    const add = (
      kind: 'episode' | 'note',
      id: string,
      content: string,
      relevance: number,
      createdAt: string,
      importance: number,
      embedding: number[] | null,
    ) => {
      const createdMs = new Date(createdAt).getTime();
      const existing = byId.get(id);
      if (existing) {
        existing.relevance = Math.max(existing.relevance, relevance);
        return;
      }
      byId.set(id, {
        kind,
        id,
        content,
        tokens: estimateTokens(content),
        relevance,
        importance,
        ageMs: Date.now() - createdMs,
        embedding: embedding ?? undefined,
        createdMs,
      });
    };

    if (queryEmbedding) {
      for (const r of await this.repo.vectorSearchEpisodes(tenantId, queryEmbedding, k)) {
        add('episode', r.id, r.content, r.relevance, r.createdAt, r.importance, r.embedding);
      }
      for (const r of await this.repo.vectorSearchNotes(tenantId, queryEmbedding, k)) {
        add('note', r.id, r.content, r.relevance, r.createdAt, r.importance, r.embedding);
      }
    }
    for (const r of await this.repo.keywordSearchEpisodes(tenantId, query, k)) {
      add('episode', r.id, r.content, r.relevance, r.createdAt, r.importance, r.embedding);
    }

    // Multi-hop graph recall via Personalized PageRank (M1): seed PPR from the
    // query's entities, spread across the knowledge graph, aggregate node mass
    // back onto notes. Falls back to 1-hop expansion when the graph is too small
    // for PPR to add signal.
    const graph = await this.repo.getGraphForPPR(tenantId);
    if (graph.edges.length >= PPR_MIN_EDGES) {
      const seeds = await this.repo.findSeedEntities(tenantId, queryEmbedding, query, k);
      if (seeds.length > 0) {
        const seedMap = new Map(seeds.map((s) => [s.id, s.score]));
        const norm = normalizeScores(personalizedPageRank(graph.entityIds, graph.edges, seedMap));
        // Aggregate entity mass onto notes via edge evidence.
        const noteMass = new Map<string, number>();
        for (const e of graph.edges) {
          const m = ((norm.get(e.src) ?? 0) + (norm.get(e.dst) ?? 0)) / 2;
          if (m <= 0) continue;
          for (const noteId of e.evidenceNoteIds) {
            noteMass.set(noteId, Math.max(noteMass.get(noteId) ?? 0, m));
          }
        }
        const top = [...noteMass.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
        const massById = new Map(top);
        const fetchIds = top.map(([id]) => id).filter((id) => !byId.has(id));
        for (const nrow of await this.repo.getNotesByIds(tenantId, fetchIds)) {
          const relevance = Math.max(0, Math.min(1, 0.3 + 0.6 * (massById.get(nrow.id) ?? 0)));
          add('note', nrow.id, nrow.content, relevance, nrow.createdAt, nrow.importance, nrow.embedding);
        }
      }
    } else {
      const seedNoteIds = [...byId.values()].filter((c) => c.kind === 'note').map((c) => c.id);
      for (const r of await this.repo.graphExpandNotes(tenantId, seedNoteIds, k)) {
        add('note', r.id, r.content, 0.4, r.createdAt, 0.6, null);
      }
    }

    // Core memory: the always-on, bounded, human-readable profile (M3). Prepended
    // to every pack and budget-counted, so the agent always sees it first/cheaply.
    const coreBlocks = await this.repo.getCoreMemory(tenantId);
    const coreMemories = coreBlocks
      .filter((b) => b.body.trim())
      .map((b) => ({ kind: 'core' as const, id: `core:${b.label}`, content: `[${b.label}] ${b.body}` }));
    const coreTokens = coreMemories.reduce((s, m) => s + estimateTokens(m.content), 0);
    const coreTrace = coreMemories.map((m) => ({
      kind: 'core' as const, id: m.id, content: m.content, tokens: estimateTokens(m.content),
      relevance: 1, recency: 1, importance: 1, diversity: 1, score: 1, included: true,
    }));

    const candidates = [...byId.values()];
    if (candidates.length === 0) {
      return {
        memories: coreMemories,
        trace: { tokenBudget, tokensUsed: coreTokens, weights: this.weights, candidates: coreTrace },
      };
    }

    // Rerank to sharpen relevance (blend rerank score with recall relevance).
    try {
      const ranked = await this.qwen.rerank(query, candidates.map((c) => c.content));
      for (const { index, score } of ranked) {
        const c = candidates[index];
        if (c) c.relevance = 0.5 * c.relevance + 0.5 * score;
      }
    } catch (err) {
      log.warn('rerank failed; using recall relevance only', { err: String(err) });
    }

    const trace = packContext(candidates, {
      tokenBudget: Math.max(0, tokenBudget - coreTokens),
      weights: this.weights,
      recencyHalfLifeMs: this.recencyHalfLifeMs,
    });

    const included = trace.candidates.filter((c) => c.included);
    const includedEpisodeIds = included.filter((c) => c.kind === 'episode').map((c) => c.id);
    await this.repo.bumpAccess(tenantId, includedEpisodeIds).catch(() => undefined);

    log.info('memory.search', { tenantId, candidates: candidates.length, included: included.length, core: coreMemories.length, tokensUsed: trace.tokensUsed + coreTokens });
    return {
      memories: [...coreMemories, ...included.map((c) => ({ kind: c.kind, id: c.id, content: c.content }))],
      trace: {
        tokenBudget,
        tokensUsed: trace.tokensUsed + coreTokens,
        weights: trace.weights,
        candidates: [...coreTrace, ...trace.candidates],
      },
    };
  }

  async forget(args: { tenantId: string; episodeId?: string; query?: string }): Promise<{ forgotten: number }> {
    if (args.episodeId) {
      const ok = await this.repo.forgetEpisode(args.tenantId, args.episodeId);
      return { forgotten: ok ? 1 : 0 };
    }
    if (args.query) {
      const n = await this.repo.forgetByQuery(args.tenantId, args.query);
      return { forgotten: n };
    }
    throw new Error('memory.forget: provide episodeId or query');
  }

  /** Drain the re-embed dead-letter (called by the sleep worker maintenance tick). */
  async drainReembedQueue(max = 50): Promise<number> {
    const items = (await this.queue.pop(DLQ_TOPIC, max)) as Array<{ op: string; tenantId: string; episodeId: string }>;
    let fixed = 0;
    for (const item of items) {
      if (item.op !== 'reembed') continue;
      try {
        const rows = await this.store.query<{ content: string }>(
          `SELECT content FROM episodes WHERE tenant_id = $1 AND id = $2`,
          [item.tenantId, item.episodeId],
        );
        const content = rows[0]?.content;
        if (!content) continue;
        const [vec] = await this.qwen.embed([content]);
        if (vec) {
          await this.store.query(
            `UPDATE episodes SET embedding = $3::vector WHERE tenant_id = $1 AND id = $2`,
            [item.tenantId, item.episodeId, `[${vec.join(',')}]`],
          );
          fixed++;
        }
      } catch (err) {
        // Re-queue for a later attempt rather than lose it.
        await this.queue.push(DLQ_TOPIC, item);
        log.warn('reembed retry failed; requeued', { episodeId: item.episodeId, err: String(err) });
      }
    }
    if (fixed > 0) log.info('reembed drained', { fixed });
    return fixed;
  }
}

/**
 * Cheap, no-LLM importance heuristic for the hot write path. Personal/temporal
 * markers and longer statements skew higher; trivial chatter lower. The sleep
 * phase can later refine importance during consolidation.
 */
export function heuristicImportance(content: string): number {
  const c = content.toLowerCase();
  let score = 0.4;
  if (/\b(i|my|me|we|our)\b/.test(c)) score += 0.15;
  if (/\b(always|never|prefer|favorite|hate|love|allergic|birthday|anniversary|deadline|remember)\b/.test(c)) score += 0.2;
  if (/\d{1,2}(:\d{2})?\s*(am|pm)\b|\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(c)) score += 0.1;
  if (content.length > 120) score += 0.1;
  if (content.length < 20) score -= 0.1;
  return Math.max(0.05, Math.min(1, score));
}
