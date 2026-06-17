-- Bi-temporal memory (M2, Zep/Graphiti pattern). Every note and edge carries
-- valid-time (when the fact is true in the world) and transaction-time (when we
-- recorded / un-recorded it). Contradictions INVALIDATE (set invalidated_at)
-- instead of hard-deleting, preserving history and enabling "what did I believe
-- at time T" queries. Additive + idempotent — safe to run on existing data.

ALTER TABLE semantic_notes
  ADD COLUMN IF NOT EXISTS valid_from     timestamptz,
  ADD COLUMN IF NOT EXISTS valid_to       timestamptz,
  ADD COLUMN IF NOT EXISTS recorded_at    timestamptz,
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;

-- Backfill existing rows from their creation time, then set defaults for new rows.
UPDATE semantic_notes SET valid_from = created_at WHERE valid_from IS NULL;
UPDATE semantic_notes SET recorded_at = created_at WHERE recorded_at IS NULL;
ALTER TABLE semantic_notes ALTER COLUMN valid_from  SET DEFAULT now();
ALTER TABLE semantic_notes ALTER COLUMN recorded_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS notes_validity_idx
  ON semantic_notes (tenant_id, invalidated_at, valid_to);

ALTER TABLE edges
  ADD COLUMN IF NOT EXISTS valid_from     timestamptz,
  ADD COLUMN IF NOT EXISTS valid_to       timestamptz,
  ADD COLUMN IF NOT EXISTS recorded_at    timestamptz,
  ADD COLUMN IF NOT EXISTS invalidated_at timestamptz;

UPDATE edges SET valid_from = now()  WHERE valid_from IS NULL;
UPDATE edges SET recorded_at = now() WHERE recorded_at IS NULL;
ALTER TABLE edges ALTER COLUMN valid_from  SET DEFAULT now();
ALTER TABLE edges ALTER COLUMN recorded_at SET DEFAULT now();

CREATE INDEX IF NOT EXISTS edges_validity_idx
  ON edges (tenant_id, invalidated_at);
