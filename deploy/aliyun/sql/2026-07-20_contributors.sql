BEGIN;

CREATE TABLE IF NOT EXISTS public.contributors (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL CHECK (CHAR_LENGTH(BTRIM(name)) BETWEEN 1 AND 80),
  github_url TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_contributors_order
  ON public.contributors(display_order, id);

INSERT INTO public.contributors (name, github_url, display_order)
VALUES ('SWzei', 'https://github.com/swzei', 0)
ON CONFLICT (github_url) DO NOTHING;

COMMIT;
