-- Core memory blocks (M3, MemGPT/Letta + Karpathy LLM-wiki) and note importance (M4).
-- Core blocks are a bounded, human-readable per-tenant profile the sleep phase
-- maintains and the agent reads first/cheaply. Additive + idempotent.

CREATE TABLE IF NOT EXISTS core_memory (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  text NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  label      text NOT NULL,                         -- e.g. 'profile', 'persona'
  body       text NOT NULL DEFAULT '',
  size_limit integer NOT NULL DEFAULT 2000,         -- max chars (bounds context cost)
  pinned     boolean NOT NULL DEFAULT false,        -- protected from decay/eviction
  read_only  boolean NOT NULL DEFAULT false,        -- only the developer/operator may edit
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, label)
);

-- M4: per-note importance (LLM-rated 1-10 → 0..1) so the budgeter scores notes
-- by their own importance instead of a hardcoded constant.
ALTER TABLE semantic_notes
  ADD COLUMN IF NOT EXISTS importance real NOT NULL DEFAULT 0.7;
