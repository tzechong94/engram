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

export interface SleepCycle {
  id: string;
  tenantId: string;
  startedAt: string;
  finishedAt: string | null;
  status: SleepCycleStatus;
  checkpoint: Record<string, unknown>;
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
}

export interface SearchResult {
  memories: Array<{ kind: 'episode' | 'note' | 'core'; id: string; content: string }>;
  trace: PackingTrace;
}
