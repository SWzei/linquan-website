BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1;

ALTER TABLE public.activities
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMP NULL;

ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS attachment_path TEXT;

ALTER TABLE public.announcements
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMP NULL;

ALTER TABLE public.concert_applications
  DROP CONSTRAINT IF EXISTS concert_applications_concert_id_user_id_key;

DROP INDEX IF EXISTS public.idx_concert_applications_concert_user_unique;

CREATE INDEX IF NOT EXISTS idx_concert_applications_concert_user
  ON public.concert_applications(concert_id, user_id);

CREATE TABLE IF NOT EXISTS public.class_matching_terms (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.class_matching_slots (
  id SERIAL PRIMARY KEY,
  term_id INTEGER NOT NULL REFERENCES public.class_matching_terms(id) ON DELETE CASCADE,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  hour INTEGER NOT NULL CHECK (hour BETWEEN 8 AND 21),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (term_id, day_of_week, hour)
);

CREATE TABLE IF NOT EXISTS public.class_matching_profiles (
  id SERIAL PRIMARY KEY,
  term_id INTEGER NOT NULL REFERENCES public.class_matching_terms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('student', 'teacher')),
  matching_mode TEXT NOT NULL DEFAULT 'ranking' CHECK (matching_mode IN ('direct', 'ranking')),
  skill_level TEXT,
  learning_goals TEXT,
  budget_expectation TEXT,
  teaching_experience TEXT,
  skill_specialization TEXT,
  fee_expectation TEXT,
  capacity INTEGER,
  direct_target_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  qualification_status TEXT NOT NULL DEFAULT 'pending' CHECK (qualification_status IN ('pending', 'approved', 'rejected')),
  qualification_feedback TEXT,
  reviewed_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (term_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.class_matching_availability (
  id SERIAL PRIMARY KEY,
  term_id INTEGER NOT NULL REFERENCES public.class_matching_terms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  slot_id INTEGER NOT NULL REFERENCES public.class_matching_slots(id) ON DELETE CASCADE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (term_id, user_id, slot_id)
);

CREATE TABLE IF NOT EXISTS public.class_matching_rankings (
  id SERIAL PRIMARY KEY,
  term_id INTEGER NOT NULL REFERENCES public.class_matching_terms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  target_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  rank_order INTEGER NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (term_id, user_id, target_user_id),
  UNIQUE (term_id, user_id, rank_order)
);

CREATE TABLE IF NOT EXISTS public.class_matching_versions (
  id SERIAL PRIMARY KEY,
  term_id INTEGER NOT NULL REFERENCES public.class_matching_terms(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('algorithm', 'manual', 'incremental', 'restore')),
  change_summary TEXT,
  created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  based_on_version_id INTEGER REFERENCES public.class_matching_versions(id) ON DELETE SET NULL,
  is_current INTEGER NOT NULL DEFAULT 0,
  UNIQUE (term_id, version_number)
);

CREATE TABLE IF NOT EXISTS public.class_matching_matches (
  id SERIAL PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES public.class_matching_versions(id) ON DELETE CASCADE,
  term_id INTEGER NOT NULL REFERENCES public.class_matching_terms(id) ON DELETE CASCADE,
  student_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  teacher_user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  match_type TEXT NOT NULL CHECK (match_type IN ('locked', 'algorithm', 'manual')),
  matching_score DOUBLE PRECISION NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'matched',
  notes TEXT,
  admin_comment TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (version_id, student_user_id)
);

CREATE TABLE IF NOT EXISTS public.schedule_user_settings (
  id SERIAL PRIMARY KEY,
  semester_id INTEGER NOT NULL REFERENCES public.semesters(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  class_matching_priority INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (semester_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.content_attachments (
  id SERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT,
  created_by INTEGER REFERENCES public.users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_schedule_user_settings_semester_user
  ON public.schedule_user_settings(semester_id, user_id);

CREATE INDEX IF NOT EXISTS idx_class_matching_profiles_term_type
  ON public.class_matching_profiles(term_id, participant_type, qualification_status);

CREATE INDEX IF NOT EXISTS idx_class_matching_availability_term_user
  ON public.class_matching_availability(term_id, user_id, slot_id);

CREATE INDEX IF NOT EXISTS idx_class_matching_rankings_term_user
  ON public.class_matching_rankings(term_id, user_id, rank_order);

CREATE INDEX IF NOT EXISTS idx_class_matching_versions_term_current
  ON public.class_matching_versions(term_id, is_current, version_number DESC);

CREATE INDEX IF NOT EXISTS idx_class_matching_matches_version_teacher
  ON public.class_matching_matches(version_id, teacher_user_id, student_user_id);

CREATE INDEX IF NOT EXISTS idx_content_attachments_owner
  ON public.content_attachments(owner_type, owner_id, created_at, id);

COMMIT;
