BEGIN;

LOCK TABLE concerts IN SHARE ROW EXCLUSIVE MODE;

CREATE TABLE IF NOT EXISTS legacy_concert_workflow_archive (
  id BIGSERIAL PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('audition_slot', 'concert_status')),
  source_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_type, source_id)
);

CREATE INDEX IF NOT EXISTS idx_legacy_concert_workflow_archive_source
  ON legacy_concert_workflow_archive(source_type, source_id);

-- Preserve obsolete per-audition rows before removing their live schema object.
DO $$
DECLARE
  source_count BIGINT;
  mismatched_count BIGINT;
BEGIN
  IF to_regclass('public.audition_slots') IS NOT NULL THEN
    EXECUTE $archive$
      INSERT INTO legacy_concert_workflow_archive (source_type, source_id, payload_json)
      SELECT 'audition_slot', id, to_jsonb(audition_slots)::text
      FROM audition_slots
      ON CONFLICT (source_type, source_id) DO NOTHING
    $archive$;

    EXECUTE 'SELECT COUNT(*) FROM audition_slots' INTO source_count;
    EXECUTE $verify$
      SELECT COUNT(*)
      FROM audition_slots source
      LEFT JOIN legacy_concert_workflow_archive archived
        ON archived.source_type = 'audition_slot'
       AND archived.source_id = source.id
       AND archived.payload_json::jsonb = to_jsonb(source)
      WHERE archived.id IS NULL
    $verify$ INTO mismatched_count;

    IF mismatched_count <> 0 THEN
      RAISE EXCEPTION
        'Legacy audition preservation failed: % of % rows are missing or mismatched',
        mismatched_count, source_count;
    END IF;

    DROP TABLE audition_slots;
  END IF;
END $$;

-- Preserve the original state before mapping retired concert lifecycle values to
-- the supported closed state. Application status/feedback remains authoritative
-- for result visibility.
INSERT INTO legacy_concert_workflow_archive (source_type, source_id, payload_json)
SELECT 'concert_status', id, to_jsonb(concerts)::text
FROM concerts
WHERE status IN ('audition', 'result')
ON CONFLICT (source_type, source_id) DO NOTHING;

UPDATE concerts
SET status = 'closed', updated_at = CURRENT_TIMESTAMP
WHERE status IN ('audition', 'result');

ALTER TABLE concerts DROP CONSTRAINT IF EXISTS concerts_status_check;
ALTER TABLE concerts
  ADD CONSTRAINT concerts_status_check
  CHECK (status IN ('draft', 'open', 'closed'));

COMMIT;
