-- Engram memory schema. Postgres + pgvector locally; AnalyticDB for PostgreSQL in
-- cloud (same DDL). Embedding dim is fixed at 1024 to match QWEN_EMBED_DIM; keep
-- them in sync. Content is stored plaintext so keyword search + embeddings + LLM
-- consolidation work; encryption-at-rest is provided by storage-layer TDE (cloud)
-- / disk encryption (local), and the cold-archive blob is app-encrypted separately.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS tenants (
  id              text PRIMARY KEY,
  tz              text NOT NULL DEFAULT 'UTC',
  cost_budget_cents integer NOT NULL DEFAULT 1000,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ── episodes: raw episodic capture (the online write path) ──────────────────
CREATE TABLE IF NOT EXISTS episodes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content           text NOT NULL,
  content_tsv       tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  embedding         vector(1024),
  source_channel    text NOT NULL DEFAULT 'unknown',
  importance        real NOT NULL DEFAULT 0.5,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_accessed_at  timestamptz NOT NULL DEFAULT now(),
  access_count      integer NOT NULL DEFAULT 0,
  content_hash      text NOT NULL,
  consolidated_into uuid,
  status            text NOT NULL DEFAULT 'active',   -- active | archived | forgotten
  pinned            boolean NOT NULL DEFAULT false,
  UNIQUE (tenant_id, content_hash)                    -- idempotent writes
);
CREATE INDEX IF NOT EXISTS episodes_tenant_status_idx ON episodes (tenant_id, status);
CREATE INDEX IF NOT EXISTS episodes_tsv_idx ON episodes USING gin (content_tsv);
CREATE INDEX IF NOT EXISTS episodes_embedding_idx ON episodes USING hnsw (embedding vector_cosine_ops);

-- ── semantic_notes: durable consolidated knowledge (sleep output) ───────────
CREATE TABLE IF NOT EXISTS semantic_notes (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title             text NOT NULL,
  body              text NOT NULL,
  body_tsv          tsvector GENERATED ALWAYS AS (to_tsvector('english', title || ' ' || body)) STORED,
  embedding         vector(1024),
  confidence        real NOT NULL DEFAULT 0.7,
  source_episode_ids uuid[] NOT NULL DEFAULT '{}',
  kind              text NOT NULL DEFAULT 'consolidation', -- consolidation | synthesis
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  superseded_by     uuid
);
CREATE INDEX IF NOT EXISTS notes_tenant_idx ON semantic_notes (tenant_id);
CREATE INDEX IF NOT EXISTS notes_tsv_idx ON semantic_notes USING gin (body_tsv);
CREATE INDEX IF NOT EXISTS notes_embedding_idx ON semantic_notes USING hnsw (embedding vector_cosine_ops);

-- ── knowledge graph: entities + edges (plain tables, no graph DB) ───────────
CREATE TABLE IF NOT EXISTS entities (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       text NOT NULL,
  type       text NOT NULL DEFAULT 'concept',
  embedding  vector(1024),
  salience   real NOT NULL DEFAULT 0.5,
  UNIQUE (tenant_id, name, type)
);
CREATE INDEX IF NOT EXISTS entities_tenant_idx ON entities (tenant_id);

CREATE TABLE IF NOT EXISTS edges (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  src_entity       uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dst_entity       uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation         text NOT NULL,
  weight           real NOT NULL DEFAULT 1.0,
  evidence_note_ids uuid[] NOT NULL DEFAULT '{}',
  UNIQUE (tenant_id, src_entity, dst_entity, relation)
);
CREATE INDEX IF NOT EXISTS edges_src_idx ON edges (tenant_id, src_entity);
CREATE INDEX IF NOT EXISTS edges_dst_idx ON edges (tenant_id, dst_entity);

-- ── contradictions reconciled by the sleep phase ────────────────────────────
CREATE TABLE IF NOT EXISTS contradictions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  note_id_a   uuid NOT NULL,
  note_id_b   uuid NOT NULL,
  resolution  text NOT NULL DEFAULT '',
  resolved_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ── sleep_cycles: the observable before/after record (the demo payload) ──────
CREATE TABLE IF NOT EXISTS sleep_cycles (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status      text NOT NULL DEFAULT 'running',  -- running | completed | partial | failed
  checkpoint  jsonb NOT NULL DEFAULT '{}',
  stats       jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS sleep_cycles_tenant_idx ON sleep_cycles (tenant_id, started_at DESC);

-- ── generic durable queue (backs the dead-letter on the write path) ─────────
CREATE TABLE IF NOT EXISTS queue_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic      text NOT NULL,
  payload    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS queue_topic_idx ON queue_items (topic, created_at);
