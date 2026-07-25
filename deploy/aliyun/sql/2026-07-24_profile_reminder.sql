BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS profile_reminder_pending INTEGER NOT NULL DEFAULT 0;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_profile_reminder_pending_check;
ALTER TABLE users
  ADD CONSTRAINT users_profile_reminder_pending_check
  CHECK (profile_reminder_pending IN (0, 1));

COMMIT;
