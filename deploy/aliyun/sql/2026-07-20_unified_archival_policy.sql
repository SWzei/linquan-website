BEGIN;

CREATE TABLE IF NOT EXISTS archive_records (
  id BIGSERIAL PRIMARY KEY,
  module TEXT NOT NULL CHECK (module IN ('publishing', 'scheduling', 'class_matching', 'concert_management', 'gallery_display', 'member_accounts')),
  record_type TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'archived' CHECK (status IN ('archived', 'restored', 'deletion_requested', 'permanently_deleted')),
  snapshot_json TEXT NOT NULL,
  archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restored_at TIMESTAMP,
  restored_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  deletion_requested_at TIMESTAMP,
  deletion_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  permanently_deleted_at TIMESTAMP,
  permanently_deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (module, record_type, record_id)
);

CREATE TABLE IF NOT EXISTS archive_history (
  id BIGSERIAL PRIMARY KEY,
  archive_id BIGINT NOT NULL REFERENCES archive_records(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('archive', 'restore', 'deletion_request', 'permanent_delete')),
  actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_account_type TEXT NOT NULL,
  actor_credential TEXT NOT NULL,
  reason TEXT,
  details_json TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS image_quarantine (
  id BIGSERIAL PRIMARY KEY,
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  original_value TEXT NOT NULL,
  quarantined_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  quarantined_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  restored_at TIMESTAMP,
  restored_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (owner_type, owner_id, field_name, original_value)
);

CREATE INDEX IF NOT EXISTS idx_archive_records_status_module
  ON archive_records(status, module, archived_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_archive_history_archive_time
  ON archive_history(archive_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_image_quarantine_owner
  ON image_quarantine(owner_type, owner_id, restored_at, id);

-- Preserve visible profile and gallery references before clearing them. Files are not deleted.
INSERT INTO image_quarantine (owner_type, owner_id, field_name, original_value)
SELECT 'profile', user_id, 'avatar_url', avatar_url
FROM profiles WHERE avatar_url IS NOT NULL AND BTRIM(avatar_url) <> ''
ON CONFLICT (owner_type, owner_id, field_name, original_value) DO NOTHING;

INSERT INTO image_quarantine (owner_type, owner_id, field_name, original_value)
SELECT 'profile', user_id, 'photo_url', photo_url
FROM profiles WHERE photo_url IS NOT NULL AND BTRIM(photo_url) <> ''
ON CONFLICT (owner_type, owner_id, field_name, original_value) DO NOTHING;

INSERT INTO image_quarantine (owner_type, owner_id, field_name, original_value)
SELECT 'gallery_item', id, 'src', src
FROM gallery_items WHERE src IS NOT NULL AND BTRIM(src) <> ''
ON CONFLICT (owner_type, owner_id, field_name, original_value) DO NOTHING;

INSERT INTO image_quarantine (owner_type, owner_id, field_name, original_value)
SELECT 'gallery_item', id, 'fallback', fallback
FROM gallery_items WHERE fallback IS NOT NULL AND BTRIM(fallback) <> ''
ON CONFLICT (owner_type, owner_id, field_name, original_value) DO NOTHING;

INSERT INTO archive_records (
  module, record_type, record_id, title, search_text, status, snapshot_json,
  archived_at, archived_by, updated_at
)
SELECT
  'gallery_display', 'gallery_item', id,
  COALESCE(NULLIF(BTRIM(title_zh), ''), NULLIF(BTRIM(title_en), ''), 'Gallery ' || id::text),
  CONCAT_WS(' ', title_zh, title_en, description_zh, description_en),
  'archived',
  (to_jsonb(gallery_items) || jsonb_build_object('src', '', 'fallback', NULL, 'is_visible', 0))::text,
  CURRENT_TIMESTAMP, NULL, CURRENT_TIMESTAMP
FROM gallery_items
ON CONFLICT (module, record_type, record_id) DO NOTHING;

INSERT INTO archive_history (
  archive_id, action, actor_user_id, actor_account_type, actor_credential, reason, details_json
)
SELECT ar.id, 'archive', NULL, 'system', 'system:migration',
  'Initial reversible image removal', '{"source":"2026-07-20_unified_archival_policy.sql"}'
FROM archive_records ar
WHERE ar.module = 'gallery_display' AND ar.record_type = 'gallery_item'
  AND NOT EXISTS (
    SELECT 1 FROM archive_history ah WHERE ah.archive_id = ar.id AND ah.action = 'archive'
  );

UPDATE profiles SET avatar_url = NULL, photo_url = NULL
WHERE avatar_url IS NOT NULL OR photo_url IS NOT NULL;

UPDATE gallery_items SET src = '', fallback = NULL, is_visible = 0, updated_at = CURRENT_TIMESTAMP
WHERE src <> '' OR fallback IS NOT NULL OR is_visible <> 0;

COMMIT;
