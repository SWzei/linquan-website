BEGIN;

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'member';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1;

UPDATE public.users SET account_type = 'member', is_admin = 1, role = 'member' WHERE role = 'admin';

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS public_id TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS photo_url TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS academy TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS hobbies TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS piano_interests TEXT;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS wechat_account TEXT;
UPDATE public.profiles
   SET public_id = md5(random()::text || clock_timestamp()::text || user_id::text)
 WHERE public_id IS NULL OR BTRIM(public_id) = '';

ALTER TABLE public.concerts ADD COLUMN IF NOT EXISTS attachment_path TEXT;
ALTER TABLE public.concert_applications ADD COLUMN IF NOT EXISTS applicant_name TEXT;
ALTER TABLE public.concert_applications ADD COLUMN IF NOT EXISTS applicant_student_number TEXT;
ALTER TABLE public.concert_applications ADD COLUMN IF NOT EXISTS piece_zh TEXT;
ALTER TABLE public.concert_applications ADD COLUMN IF NOT EXISTS piece_en TEXT;
ALTER TABLE public.concert_applications ADD COLUMN IF NOT EXISTS duration_min INTEGER;
ALTER TABLE public.concert_applications ADD COLUMN IF NOT EXISTS contact_qq TEXT;

CREATE TABLE IF NOT EXISTS public.gallery_items (
  id SERIAL PRIMARY KEY,
  src TEXT NOT NULL,
  fallback TEXT,
  title_zh TEXT NOT NULL,
  title_en TEXT NOT NULL,
  description_zh TEXT,
  description_en TEXT,
  alt_zh TEXT,
  alt_en TEXT,
  is_visible INTEGER NOT NULL DEFAULT 1,
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.schedule_operation_logs (
  id SERIAL PRIMARY KEY,
  batch_id INTEGER REFERENCES public.schedule_batches(id) ON DELETE SET NULL,
  semester_id INTEGER REFERENCES public.semesters(id) ON DELETE SET NULL,
  operation_type TEXT NOT NULL,
  payload_json TEXT,
  created_by INTEGER REFERENCES public.users(id),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.admin_privilege_audit (
  id SERIAL PRIMARY KEY,
  operator_user_id INTEGER NOT NULL REFERENCES public.users(id),
  target_user_id INTEGER NOT NULL REFERENCES public.users(id),
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_public_id ON public.profiles(public_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_active_maintainer ON public.users((1))
  WHERE account_type = 'maintainer' AND is_active = 1;
CREATE INDEX IF NOT EXISTS idx_users_member_admin ON public.users(account_type, is_admin, is_active);
CREATE INDEX IF NOT EXISTS idx_admin_privilege_audit_created ON public.admin_privilege_audit(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_items_order ON public.gallery_items(display_order, id);
CREATE INDEX IF NOT EXISTS idx_schedule_operation_logs_batch_time ON public.schedule_operation_logs(batch_id, created_at DESC, id DESC);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_account_type_check') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_account_type_check CHECK (account_type IN ('member', 'maintainer'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_is_admin_check') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_is_admin_check CHECK (is_admin IN (0, 1));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_maintainer_not_admin_check') THEN
    ALTER TABLE public.users ADD CONSTRAINT users_maintainer_not_admin_check CHECK (account_type <> 'maintainer' OR is_admin = 0);
  END IF;
END $$;

COMMIT;
