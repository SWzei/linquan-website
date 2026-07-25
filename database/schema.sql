PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
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
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (account_type <> 'maintainer' OR is_admin = 0)
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
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
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS admin_privilege_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  operator_user_id INTEGER NOT NULL,
  target_user_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (operator_user_id) REFERENCES users(id),
  FOREIGN KEY (target_user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS auth_security_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  target_user_id INTEGER,
  actor_account_type TEXT NOT NULL CHECK (actor_account_type IN ('member', 'maintainer')),
  actor_credential TEXT NOT NULL,
  target_credential TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('admin_password_reset', 'member_password_change')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS activities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  event_time TEXT,
  location TEXT,
  created_by INTEGER,
  is_published INTEGER NOT NULL DEFAULT 1,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  attachment_path TEXT,
  created_by INTEGER,
  is_published INTEGER NOT NULL DEFAULT 1,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS semesters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS class_matching_terms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester_id INTEGER,
  name TEXT NOT NULL UNIQUE,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS class_matching_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL,
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  hour INTEGER NOT NULL CHECK (hour BETWEEN 8 AND 21),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (term_id) REFERENCES class_matching_terms(id) ON DELETE CASCADE,
  UNIQUE (term_id, day_of_week, hour)
);

CREATE TABLE IF NOT EXISTS class_matching_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  participant_type TEXT NOT NULL CHECK (participant_type IN ('student', 'teacher')),
  matching_mode TEXT NOT NULL DEFAULT 'ranking' CHECK (matching_mode IN ('direct', 'ranking')),
  skill_level TEXT,
  learning_goals TEXT,
  budget_expectation TEXT,
  teaching_experience TEXT,
  skill_specialization TEXT,
  fee_expectation TEXT,
  capacity INTEGER,
  direct_target_user_id INTEGER,
  qualification_status TEXT NOT NULL DEFAULT 'pending' CHECK (qualification_status IN ('pending', 'approved', 'rejected')),
  qualification_feedback TEXT,
  reviewed_by INTEGER,
  reviewed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (term_id) REFERENCES class_matching_terms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (direct_target_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (term_id, user_id)
);

CREATE TABLE IF NOT EXISTS class_matching_availability (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  slot_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (term_id) REFERENCES class_matching_terms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (slot_id) REFERENCES class_matching_slots(id) ON DELETE CASCADE,
  UNIQUE (term_id, user_id, slot_id)
);

CREATE TABLE IF NOT EXISTS class_matching_rankings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  target_user_id INTEGER NOT NULL,
  rank_order INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (term_id) REFERENCES class_matching_terms(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (target_user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (term_id, user_id, target_user_id),
  UNIQUE (term_id, user_id, rank_order)
);

CREATE TABLE IF NOT EXISTS class_matching_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term_id INTEGER NOT NULL,
  version_number INTEGER NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('algorithm', 'manual', 'incremental', 'restore')),
  change_summary TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  based_on_version_id INTEGER,
  is_current INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (term_id) REFERENCES class_matching_terms(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (based_on_version_id) REFERENCES class_matching_versions(id) ON DELETE SET NULL,
  UNIQUE (term_id, version_number)
);

CREATE TABLE IF NOT EXISTS class_matching_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version_id INTEGER NOT NULL,
  term_id INTEGER NOT NULL,
  student_user_id INTEGER NOT NULL,
  teacher_user_id INTEGER NOT NULL,
  room_slot_id INTEGER,
  match_type TEXT NOT NULL CHECK (match_type IN ('locked', 'algorithm', 'manual')),
  matching_score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'matched',
  notes TEXT,
  admin_comment TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (version_id) REFERENCES class_matching_versions(id) ON DELETE CASCADE,
  FOREIGN KEY (term_id) REFERENCES class_matching_terms(id) ON DELETE CASCADE,
  FOREIGN KEY (student_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (teacher_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (room_slot_id) REFERENCES room_slots(id) ON DELETE RESTRICT,
  UNIQUE (version_id, student_user_id)
);

CREATE TABLE IF NOT EXISTS room_slots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester_id INTEGER NOT NULL,
  room_no INTEGER NOT NULL CHECK (room_no IN (1, 2)),
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  hour INTEGER NOT NULL CHECK (hour BETWEEN 8 AND 21),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE,
  UNIQUE (semester_id, room_no, day_of_week, hour)
);

CREATE TABLE IF NOT EXISTS slot_preferences (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  slot_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (slot_id) REFERENCES room_slots(id) ON DELETE CASCADE,
  UNIQUE (semester_id, user_id, slot_id)
);

CREATE TABLE IF NOT EXISTS schedule_user_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  class_matching_priority INTEGER NOT NULL DEFAULT 0 CHECK (class_matching_priority IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE (semester_id, user_id)
);

CREATE TABLE IF NOT EXISTS schedule_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  semester_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'published')),
  created_by INTEGER,
  published_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at TEXT,
  note TEXT,
  FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id),
  FOREIGN KEY (published_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS schedule_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER NOT NULL,
  semester_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  slot_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'published')),
  assigned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES schedule_batches(id) ON DELETE CASCADE,
  FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (slot_id) REFERENCES room_slots(id) ON DELETE CASCADE,
  UNIQUE (batch_id, user_id, slot_id)
);

CREATE TABLE IF NOT EXISTS concerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  announcement TEXT,
  application_deadline TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
  attachment_path TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS concert_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  concert_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
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
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'accepted', 'rejected', 'waitlist')),
  feedback TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (concert_id) REFERENCES concerts(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schedule_operation_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id INTEGER,
  semester_id INTEGER,
  operation_type TEXT NOT NULL,
  payload_json TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (batch_id) REFERENCES schedule_batches(id) ON DELETE SET NULL,
  FOREIGN KEY (semester_id) REFERENCES semesters(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS content_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('activity', 'announcement')),
  owner_id INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  file_size INTEGER NOT NULL DEFAULT 0,
  mime_type TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (created_by) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'system')),
  subject TEXT NOT NULL,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  related_type TEXT,
  related_id INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS gallery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src TEXT NOT NULL,
  fallback TEXT,
  title_zh TEXT NOT NULL,
  title_en TEXT NOT NULL,
  description_zh TEXT,
  description_en TEXT,
  alt_zh TEXT,
  alt_en TEXT,
  is_visible INTEGER NOT NULL DEFAULT 1 CHECK (is_visible IN (0, 1)),
  display_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS contributors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL CHECK (LENGTH(TRIM(name)) BETWEEN 1 AND 80),
  github_url TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS archive_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  module TEXT NOT NULL CHECK (module IN ('publishing', 'scheduling', 'class_matching', 'concert_management', 'gallery_display', 'member_accounts')),
  record_type TEXT NOT NULL,
  record_id INTEGER NOT NULL,
  title TEXT NOT NULL,
  search_text TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'archived' CHECK (status IN ('archived', 'restored', 'deletion_requested', 'permanently_deleted')),
  snapshot_json TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  archived_by INTEGER,
  restored_at TEXT,
  restored_by INTEGER,
  deletion_requested_at TEXT,
  deletion_requested_by INTEGER,
  permanently_deleted_at TEXT,
  permanently_deleted_by INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (archived_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (restored_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (deletion_requested_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (permanently_deleted_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (module, record_type, record_id)
);

CREATE TABLE IF NOT EXISTS archive_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  archive_id INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('archive', 'restore', 'deletion_request', 'permanent_delete')),
  actor_user_id INTEGER,
  actor_account_type TEXT NOT NULL,
  actor_credential TEXT NOT NULL,
  reason TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (archive_id) REFERENCES archive_records(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS image_quarantine (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_type TEXT NOT NULL,
  owner_id INTEGER NOT NULL,
  field_name TEXT NOT NULL,
  original_value TEXT NOT NULL,
  quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  quarantined_by INTEGER,
  restored_at TEXT,
  restored_by INTEGER,
  FOREIGN KEY (quarantined_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (restored_by) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE (owner_type, owner_id, field_name, original_value)
);

CREATE TABLE IF NOT EXISTS legacy_concert_workflow_archive (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL CHECK (source_type IN ('audition_slot', 'concert_status')),
  source_id INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  archived_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source_type, source_id)
);

INSERT OR IGNORE INTO contributors (name, github_url, display_order)
VALUES ('SWzei', 'https://github.com/swzei', 0);

CREATE INDEX IF NOT EXISTS idx_slot_preferences_semester_slot ON slot_preferences(semester_id, slot_id);
CREATE INDEX IF NOT EXISTS idx_slot_preferences_semester_user ON slot_preferences(semester_id, user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_user_settings_semester_user ON schedule_user_settings(semester_id, user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_assignments_semester_user ON schedule_assignments(semester_id, user_id);
CREATE INDEX IF NOT EXISTS idx_schedule_assignments_semester_slot ON schedule_assignments(semester_id, slot_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_assignments_batch_slot_unique ON schedule_assignments(batch_id, slot_id);
CREATE INDEX IF NOT EXISTS idx_class_matching_profiles_term_type ON class_matching_profiles(term_id, participant_type, qualification_status);
CREATE INDEX IF NOT EXISTS idx_class_matching_availability_term_user ON class_matching_availability(term_id, user_id, slot_id);
CREATE INDEX IF NOT EXISTS idx_class_matching_rankings_term_user ON class_matching_rankings(term_id, user_id, rank_order);
CREATE INDEX IF NOT EXISTS idx_class_matching_versions_term_current ON class_matching_versions(term_id, is_current, version_number DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_matching_versions_one_current
  ON class_matching_versions(term_id) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_class_matching_matches_version_teacher ON class_matching_matches(version_id, teacher_user_id, student_user_id);
CREATE INDEX IF NOT EXISTS idx_class_matching_terms_semester ON class_matching_terms(semester_id, is_active);
CREATE UNIQUE INDEX IF NOT EXISTS idx_class_matching_matches_version_room_unique
  ON class_matching_matches(version_id, room_slot_id) WHERE room_slot_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_batches_one_proposed
  ON schedule_batches(semester_id) WHERE status = 'proposed';
CREATE INDEX IF NOT EXISTS idx_concert_applications_concert ON concert_applications(concert_id);
CREATE INDEX IF NOT EXISTS idx_concert_applications_concert_user ON concert_applications(concert_id, user_id);
CREATE INDEX IF NOT EXISTS idx_content_attachments_owner ON content_attachments(owner_type, owner_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_schedule_operation_logs_batch_time ON schedule_operation_logs(batch_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_gallery_items_order ON gallery_items(display_order, id);
CREATE INDEX IF NOT EXISTS idx_contributors_order ON contributors(display_order, id);
CREATE INDEX IF NOT EXISTS idx_archive_records_status_module ON archive_records(status, module, archived_at, id);
CREATE INDEX IF NOT EXISTS idx_archive_history_archive_time ON archive_history(archive_id, created_at, id);
CREATE INDEX IF NOT EXISTS idx_image_quarantine_owner ON image_quarantine(owner_type, owner_id, restored_at, id);
CREATE INDEX IF NOT EXISTS idx_legacy_concert_workflow_archive_source
  ON legacy_concert_workflow_archive(source_type, source_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_active_maintainer ON users((1))
  WHERE account_type = 'maintainer' AND is_active = 1;
CREATE TRIGGER IF NOT EXISTS trg_users_maintainer_not_admin_insert
BEFORE INSERT ON users
WHEN NEW.account_type = 'maintainer' AND NEW.is_admin <> 0
BEGIN SELECT RAISE(ABORT, 'Maintainer cannot be an administrator'); END;
CREATE TRIGGER IF NOT EXISTS trg_users_maintainer_not_admin_update
BEFORE UPDATE OF account_type, is_admin ON users
WHEN NEW.account_type = 'maintainer' AND NEW.is_admin <> 0
BEGIN SELECT RAISE(ABORT, 'Maintainer cannot be an administrator'); END;
CREATE INDEX IF NOT EXISTS idx_users_member_admin ON users(account_type, is_admin, is_active);
CREATE INDEX IF NOT EXISTS idx_admin_privilege_audit_created ON admin_privilege_audit(created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_auth_security_audit_target_created
  ON auth_security_audit(target_user_id, created_at DESC, id DESC);
