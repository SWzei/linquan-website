BEGIN;

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS must_change_password INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'users_must_change_password_check'
      AND conrelid = 'public.users'::regclass
  ) THEN
    ALTER TABLE public.users
      ADD CONSTRAINT users_must_change_password_check
      CHECK (must_change_password IN (0, 1));
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.auth_security_audit (
  id BIGSERIAL PRIMARY KEY,
  actor_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  target_user_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
  actor_account_type TEXT NOT NULL CHECK (actor_account_type IN ('member', 'maintainer')),
  actor_credential TEXT NOT NULL,
  target_credential TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('admin_password_reset', 'member_password_change')),
  created_at TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_auth_security_audit_target_created
  ON public.auth_security_audit(target_user_id, created_at DESC, id DESC);

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

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON public.notifications(user_id, created_at DESC, id DESC);

COMMIT;
