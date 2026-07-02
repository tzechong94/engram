/** Shared domain types used across memory, eval, and the agent glue. */

export type EpisodeStatus = 'active' | 'archived' | 'forgotten';

export interface Episode {
  id: string;
  tenantId: string;
  content: string;
  embedding: number[] | null;
  sourceChannel: string;
  importance: number;
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  contentHash: string;
  consolidatedInto: string | null;
  status: EpisodeStatus;
}

export interface SemanticNote {
  id: string;
  tenantId: string;
  title: string;
  body: string;
  embedding: number[] | null;
  confidence: number;
  importance: number;
  sourceEpisodeIds: string[];
  kind: string; // consolidation | synthesis | document
  createdAt: string;
  updatedAt: string;
  version: number;
  supersededBy: string | null;
}

/** A bounded, human-readable core memory block (per-tenant profile). */
export interface CoreBlock {
  label: string;
  body: string;
  sizeLimit: number;
  pinned: boolean;
  readOnly: boolean;
  updatedAt: string;
}

export interface Entity {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  embedding: number[] | null;
  salience: number;
}

export interface Edge {
  id: string;
  tenantId: string;
  srcEntity: string;
  dstEntity: string;
  relation: string;
  weight: number;
  evidenceNoteIds: string[];
}

export interface Contradiction {
  id: string;
  tenantId: string;
  noteIdA: string;
  noteIdB: string;
  resolution: string;
  resolvedAt: string | null;
}

export type SleepCycleStatus = 'running' | 'completed' | 'partial' | 'failed';

export interface SleepCycleStats {
  episodesScanned: number;
  clusters: number;
  consolidated: number;
  entitiesMerged: number;
  edgesMerged: number;
  forgotten: number;
  contradictionsResolved: number;
  connectionsSynthesized: number;
  tokensUsed: number;
  costCents: number;
  /** Mem0-style reconciliation ops (auditable record of what changed). */
  memoryOps: { add: number; update: number; delete: number; noop: number };
}

/** One line of the "dreaming" narration — what the LLM did, at which step, when.
 *  Persisted in the cycle checkpoint so the viewer can replay the cycle step by step. */
export interface SleepTraceEntry {
  at: string; // ISO timestamp
  step: string; // which dream step emitted this line (forget | cluster | …)
  msg: string; // the human-readable narration line
}

/** The recoverable checkpoint stored per cycle: last step reached + the full
 *  narration trace accumulated so far. Loosely typed (jsonb) but shaped here. */
export interface SleepCheckpoint {
  lastStep?: string;
  at?: string;
  trace?: SleepTraceEntry[];
}

export interface SleepCycle {
  id: string;
  tenantId: string;
  startedAt: string;
  finishedAt: string | null;
  status: SleepCycleStatus;
  checkpoint: SleepCheckpoint & Record<string, unknown>;
  stats: SleepCycleStats;
}

/** A single candidate considered by the context budgeter, with its score breakdown. */
export interface PackCandidate {
  kind: 'episode' | 'note' | 'core';
  id: string;
  content: string;
  tokens: number;
  relevance: number;
  recency: number;
  importance: number;
  diversity: number;
  score: number;
  included: boolean;
}

/** The exposed packing decision — the demo surfaces this verbatim. */
export interface PackingTrace {
  tokenBudget: number;
  tokensUsed: number;
  weights: { relevance: number; recency: number; importance: number; diversity: number };
  candidates: PackCandidate[];
  /** True when active-set recall came up empty and the search auto-escalated to
   *  the cold tier (forgotten/archived) — the agentic "let me dig deeper" path. */
  deepened?: boolean;
}

export interface SearchResult {
  /** `recordedAt` (ISO) is when the memory was captured — lets a consumer resolve
   *  relative dates ("tomorrow") and always answer with an absolute date. Core
   *  (profile) memories have no single date and omit it. */
  memories: Array<{ kind: 'episode' | 'note' | 'core'; id: string; content: string; recordedAt?: string }>;
  trace: PackingTrace;
}
