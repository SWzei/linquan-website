BEGIN;

LOCK TABLE schedule_batches, schedule_assignments, class_matching_terms,
  class_matching_versions, class_matching_matches IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM schedule_assignments
    GROUP BY batch_id, slot_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce Piano Time room uniqueness: duplicate batch/slot assignments exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM schedule_batches
    WHERE status = 'proposed'
    GROUP BY semester_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one Piano Time draft per semester: duplicate proposed batches exist';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM class_matching_versions
    WHERE is_current = 1
    GROUP BY term_id
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce one current Class Matching version per term: duplicates exist';
  END IF;
END $$;

ALTER TABLE class_matching_terms
  ADD COLUMN IF NOT EXISTS semester_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'class_matching_terms_semester_id_fkey'
  ) THEN
    ALTER TABLE class_matching_terms
      ADD CONSTRAINT class_matching_terms_semester_id_fkey
      FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE RESTRICT;
  END IF;
END $$;

UPDATE class_matching_terms AS term
SET semester_id = (
  SELECT semester.id
  FROM semesters AS semester
  WHERE semester.start_date <= term.start_date
    AND semester.end_date >= term.end_date
  ORDER BY
    CASE WHEN semester.start_date = term.start_date AND semester.end_date = term.end_date THEN 0 ELSE 1 END,
    semester.is_active DESC,
    semester.id DESC
  LIMIT 1
)
WHERE term.semester_id IS NULL;

INSERT INTO class_matching_slots (term_id, day_of_week, hour)
SELECT DISTINCT term.id, slot.day_of_week, slot.hour
FROM class_matching_terms AS term
JOIN room_slots AS slot ON slot.semester_id = term.semester_id
WHERE term.semester_id IS NOT NULL
ON CONFLICT (term_id, day_of_week, hour) DO NOTHING;

ALTER TABLE class_matching_matches
  ADD COLUMN IF NOT EXISTS room_slot_id INTEGER;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'class_matching_matches_room_slot_id_fkey'
  ) THEN
    ALTER TABLE class_matching_matches
      ADD CONSTRAINT class_matching_matches_room_slot_id_fkey
      FOREIGN KEY (room_slot_id) REFERENCES room_slots(id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_class_matching_terms_semester
  ON class_matching_terms(semester_id, is_active);

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_assignments_batch_slot_unique
  ON schedule_assignments(batch_id, slot_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_class_matching_matches_version_room_unique
  ON class_matching_matches(version_id, room_slot_id)
  WHERE room_slot_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_class_matching_versions_one_current
  ON class_matching_versions(term_id)
  WHERE is_current = 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_batches_one_proposed
  ON schedule_batches(semester_id)
  WHERE status = 'proposed';

COMMIT;
