BEGIN;

-- Repository-owned PostgreSQL baseline. It contains the tables that predate the
-- dated additive migrations. CREATE TABLE IF NOT EXISTS makes it safe to place
-- first in the ordered migration loop for an already-initialized database.
-- A fresh database reaches the current schema only after every later migration
-- in this directory has also run.

CREATE TABLE IF NOT EXISTS public.users (
  id SERIAL PRIMARY KEY,
  student_number TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  account_type TEXT NOT NULL DEFAULT 'member' CHECK (account_type IN ('member', 'maintainer')),
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0, 1)),
  auth_version INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  profile_reminder_pending INTEGER NOT NULL DEFAULT 0 CHECK (profile_reminder_pending IN (0, 1)),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (account_type <> 'maintainer' OR is_admin = 0)
);

CREATE TABLE IF NOT EXISTS public.profiles (
  user_id INTEGER PRIMARY KEY REFERENCES public.users(id) ON DELETE CASCADE,
  public_id TEXT UNIQUE,
  display_name TEXT,
  avatar_url TEXT,
  photo_url TEXT,
  bio TEXT,
  grade TEXT,
  major TEXT,
  academy TEXT,
  hobbies TEXT,
  piano_interests TEXT,
  wechat_account TEXT,
  phone TEXT,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.activities (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  event_time TIMESTAMP WITHOUT TIME ZONE,
  location TEXT,
  created_by INTEGER REFERENCES public.users(id),
  is_published INTEGER NOT NULL DEFAULT 1,
  published_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.announcements (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  attachment_path TEXT,
  created_by INTEGER REFERENCES public.users(id),
  is_published INTEGER NOT NULL DEFAULT 1,
  published_at TIMESTAMP WITHOUT TIME ZONE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.semesters (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.room_slots (
  id SERIAL PRIMARY KEY,
  semester_id INTEGER NOT NULL REFERENCES public.semesters(id) ON DELETE CASCADE,
  room_no INTEGER NOT NULL CHECK (room_no IN (1, 2)),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  hour INTEGER NOT NULL CHECK (hour BETWEEN 8 AND 21),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (semester_id, room_no, day_of_week, hour)
);

CREATE TABLE IF NOT EXISTS public.slot_preferences (
  id SERIAL PRIMARY KEY,
  semester_id INTEGER NOT NULL REFERENCES public.semesters(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  slot_id INTEGER NOT NULL REFERENCES public.room_slots(id) ON DELETE CASCADE,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (semester_id, user_id, slot_id)
);

CREATE TABLE IF NOT EXISTS public.schedule_batches (
  id SERIAL PRIMARY KEY,
  semester_id INTEGER NOT NULL REFERENCES public.semesters(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'published')),
  created_by INTEGER REFERENCES public.users(id),
  published_by INTEGER REFERENCES public.users(id),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TIMESTAMP WITHOUT TIME ZONE,
  note TEXT
);

CREATE TABLE IF NOT EXISTS public.schedule_assignments (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES public.schedule_batches(id) ON DELETE CASCADE,
  semester_id INTEGER NOT NULL REFERENCES public.semesters(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  slot_id INTEGER NOT NULL REFERENCES public.room_slots(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'published')),
  assigned_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (batch_id, user_id, slot_id)
);

CREATE TABLE IF NOT EXISTS public.concerts (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  announcement TEXT,
  application_deadline TIMESTAMP WITHOUT TIME ZONE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  attachment_path TEXT,
  created_by INTEGER REFERENCES public.users(id),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.concert_applications (
  id SERIAL PRIMARY KEY,
  concert_id INTEGER NOT NULL REFERENCES public.concerts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  applicant_name TEXT,
  applicant_student_number TEXT,
  piece_zh TEXT,
  piece_en TEXT,
  duration_min INTEGER,
  contact_qq TEXT,
  piece_title TEXT NOT NULL,
  composer TEXT,
  score_file_path TEXT,
  note TEXT,
  status TEXT NOT NULL DEFAULT 'submitted'
    CHECK (status IN ('submitted', 'accepted', 'rejected', 'waitlist')),
  feedback TEXT,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.notifications (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'system')),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  related_type TEXT,
  related_id INTEGER,
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TIMESTAMP WITHOUT TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_slot_preferences_semester_slot
  ON public.slot_preferences(semester_id, slot_id);
CREATE INDEX IF NOT EXISTS idx_slot_preferences_semester_user
  ON public.slot_preferences(semester_id, user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_assignments_semester_user
  ON public.schedule_assignments(semester_id, user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_assignments_semester_slot
  ON public.schedule_assignments(semester_id, slot_id);
CREATE INDEX IF NOT EXISTS idx_concert_applications_concert
  ON public.concert_applications(concert_id);
CREATE INDEX IF NOT EXISTS idx_concert_applications_concert_user
  ON public.concert_applications(concert_id, user_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON public.notifications(user_id, created_at DESC, id DESC);

COMMIT;
