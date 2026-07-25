import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import { ALLOW_RUNTIME_SCHEMA_MIGRATION, DB_PATH, DATABASE_URL } from './env.js';
import createPostgresCompatDb from './postgresCompat.js';
import { normalizeUploadedOriginalName } from '../utils/uploadFilename.js';

function resolveDbPath(rawPath) {
  if (path.isAbsolute(rawPath)) {
    return rawPath;
  }
  return path.resolve(process.cwd(), rawPath);
}

function ensureColumn(db, table, column, definition) {
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!tableExists) {
    return;
  }
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  const hasColumn = columns.some((item) => item.name === column);
  if (!hasColumn) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function sqliteTableExists(db, table) {
  return Boolean(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
  );
}

function ensureSqliteConcertApplicationsMultiEntry(db) {
  if (!sqliteTableExists(db, 'concert_applications')) {
    return;
  }

  const indexes = db.prepare('PRAGMA index_list(concert_applications)').all();
  const hasConcertUserUnique = indexes.some((indexRow) => {
    if (Number(indexRow.unique) !== 1) {
      return false;
    }
    const columns = db.prepare(`PRAGMA index_info(${indexRow.name})`).all();
    const columnNames = columns.map((item) => item.name);
    return columnNames.length === 2
      && columnNames[0] === 'concert_id'
      && columnNames[1] === 'user_id';
  });

  if (!hasConcertUserUnique) {
    return;
  }

  db.pragma('foreign_keys = OFF');
  try {
    const migrate = db.transaction(() => {
      db.exec('ALTER TABLE concert_applications RENAME TO concert_applications_old_multi');

      db.exec(`
        CREATE TABLE concert_applications (
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
        )
      `);

      db.exec(`
        INSERT INTO concert_applications (
          id, concert_id, user_id, applicant_name, applicant_student_number,
          piece_zh, piece_en, duration_min, contact_qq, piece_title, composer,
          score_file_path, note, status, feedback, created_at, updated_at
        )
        SELECT
          id, concert_id, user_id, applicant_name, applicant_student_number,
          piece_zh, piece_en, duration_min, contact_qq, piece_title, composer,
          score_file_path, note, status, feedback, created_at, updated_at
        FROM concert_applications_old_multi
      `);

      db.exec('CREATE INDEX IF NOT EXISTS idx_concert_applications_concert ON concert_applications(concert_id)');
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_concert_applications_concert_user ON concert_applications(concert_id, user_id)'
      );

      db.exec('DROP TABLE concert_applications_old_multi');
    });

    migrate();
  } finally {
    db.pragma('foreign_keys = ON');
  }
}

function deriveAttachmentOriginalName(filePath) {
  const normalized = String(filePath || '').replaceAll('\\', '/');
  const fileName = normalized.split('/').pop() || 'attachment';
  return fileName;
}

function repairStoredAttachmentOriginalNames(db) {
  let rows = [];
  try {
    rows = db
      .prepare(
        `SELECT id, original_name AS originalName
         FROM content_attachments
         ORDER BY id ASC`
      )
      .all();
  } catch (err) {
    return;
  }
  if (!rows.length) {
    return;
  }

  const updateStmt = db.prepare(
    `UPDATE content_attachments
     SET original_name = ?
     WHERE id = ?`
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      const repairedName = normalizeUploadedOriginalName(row.originalName);
      if (repairedName && repairedName !== row.originalName) {
        updateStmt.run(repairedName, row.id);
      }
    }
  });

  tx();
}

function backfillLegacyAnnouncementAttachments(db) {
  if (!sqliteTableExists(db, 'announcements') || !sqliteTableExists(db, 'content_attachments')) {
    return;
  }

  const rows = db
    .prepare(
      `SELECT id, attachment_path AS attachmentPath
       FROM announcements
       WHERE attachment_path IS NOT NULL AND TRIM(attachment_path) != ''`
    )
    .all();

  const insertStmt = db.prepare(
    `INSERT INTO content_attachments (
       owner_type, owner_id, original_name, file_path, file_size, mime_type, created_by
     ) VALUES ('announcement', ?, ?, ?, 0, NULL, NULL)`
  );
  const existsStmt = db.prepare(
    `SELECT id
     FROM content_attachments
     WHERE owner_type = 'announcement' AND owner_id = ? AND file_path = ?`
  );

  const tx = db.transaction(() => {
    for (const row of rows) {
      if (existsStmt.get(row.id, row.attachmentPath)) {
        continue;
      }
      insertStmt.run(row.id, deriveAttachmentOriginalName(row.attachmentPath), row.attachmentPath);
    }
  });

  tx();
}

function backfillLegacyAnnouncementAttachmentsPostgres(db) {
  db.exec(`
    INSERT INTO content_attachments (
      owner_type, owner_id, original_name, file_path, file_size, mime_type, created_by
    )
    SELECT
      'announcement',
      a.id,
      REGEXP_REPLACE(a.attachment_path, '^.*/', ''),
      a.attachment_path,
      0,
      NULL,
      NULL
    FROM announcements a
    WHERE a.attachment_path IS NOT NULL
      AND BTRIM(a.attachment_path) <> ''
      AND NOT EXISTS (
        SELECT 1
        FROM content_attachments ca
        WHERE ca.owner_type = 'announcement'
          AND ca.owner_id = a.id
          AND ca.file_path = a.attachment_path
      );
  `);
}

function ensureSqliteRuntimeSchema(db) {
  // Lightweight runtime migration for existing local databases.
  const contributorTableAlreadyExisted = sqliteTableExists(db, 'contributors');
  ensureColumn(db, 'users', 'is_active', 'INTEGER NOT NULL DEFAULT 1');
  ensureColumn(db, 'users', 'account_type', "TEXT NOT NULL DEFAULT 'member'");
  ensureColumn(db, 'users', 'is_admin', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'auth_version', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'must_change_password', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'users', 'profile_reminder_pending', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db, 'profiles', 'public_id', 'TEXT');
  ensureColumn(db, 'concerts', 'attachment_path', 'TEXT');
  ensureColumn(db, 'announcements', 'attachment_path', 'TEXT');
  ensureColumn(db, 'activities', 'published_at', 'TEXT');
  ensureColumn(db, 'announcements', 'published_at', 'TEXT');
  ensureColumn(db, 'profiles', 'photo_url', 'TEXT');
  ensureColumn(db, 'profiles', 'academy', 'TEXT');
  ensureColumn(db, 'profiles', 'hobbies', 'TEXT');
  ensureColumn(db, 'profiles', 'piano_interests', 'TEXT');
  ensureColumn(db, 'profiles', 'wechat_account', 'TEXT');
  ensureColumn(db, 'concert_applications', 'applicant_name', 'TEXT');
  ensureColumn(db, 'concert_applications', 'applicant_student_number', 'TEXT');
  ensureColumn(db, 'concert_applications', 'piece_zh', 'TEXT');
  ensureColumn(db, 'concert_applications', 'piece_en', 'TEXT');
  ensureColumn(db, 'concert_applications', 'duration_min', 'INTEGER');
  ensureColumn(db, 'concert_applications', 'contact_qq', 'TEXT');
  if (sqliteTableExists(db, 'users') && sqliteTableExists(db, 'profiles')) {
    db.prepare("UPDATE users SET account_type = 'member', is_admin = 1, role = 'member' WHERE role = 'admin'").run();
    const profilesWithoutPublicId = db.prepare("SELECT user_id AS userId FROM profiles WHERE public_id IS NULL OR TRIM(public_id) = ''").all();
    const setPublicId = db.prepare('UPDATE profiles SET public_id = ? WHERE user_id = ?');
    const publicIdTx = db.transaction(() => {
      profilesWithoutPublicId.forEach((item) => setPublicId.run(crypto.randomUUID(), item.userId));
    });
    publicIdTx();
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_public_id ON profiles(public_id);
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
      CREATE TABLE IF NOT EXISTS admin_privilege_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        operator_user_id INTEGER NOT NULL,
        target_user_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (operator_user_id) REFERENCES users(id),
        FOREIGN KEY (target_user_id) REFERENCES users(id)
      );
      CREATE INDEX IF NOT EXISTS idx_admin_privilege_audit_created
        ON admin_privilege_audit(created_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS auth_security_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        actor_account_type TEXT NOT NULL CHECK (actor_account_type IN ('member', 'maintainer')),
        actor_credential TEXT NOT NULL,
        target_credential TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('admin_password_reset', 'member_password_change')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_auth_security_audit_target_created
        ON auth_security_audit(target_user_id, created_at DESC, id DESC);
    `);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'system')),
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
      related_type TEXT,
      related_id INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created
      ON notifications(user_id, created_at DESC, id DESC);
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
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS class_matching_slots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      term_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      hour INTEGER NOT NULL CHECK (hour BETWEEN 8 AND 21),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (term_id) REFERENCES class_matching_terms(id) ON DELETE CASCADE,
      UNIQUE (term_id, day_of_week, hour)
    )
  `);
  db.exec(`
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
    )
  `);
  db.exec(`
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
    )
  `);
  db.exec(`
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
    )
  `);
  db.exec(`
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
    )
  `);
  db.exec(`
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
    )
  `);
  db.exec(`
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
    )
  `);
  db.exec(`
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
    )
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_schedule_operation_logs_batch_time ON schedule_operation_logs(batch_id, created_at DESC, id DESC)'
  );

  db.exec(`
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
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contributors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL CHECK (LENGTH(TRIM(name)) BETWEEN 1 AND 80),
      github_url TEXT NOT NULL UNIQUE,
      display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`
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
      archived_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      restored_at TEXT,
      restored_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      deletion_requested_at TEXT,
      deletion_requested_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      permanently_deleted_at TEXT,
      permanently_deleted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (module, record_type, record_id)
    );
    CREATE TABLE IF NOT EXISTS archive_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      archive_id INTEGER NOT NULL REFERENCES archive_records(id) ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK (action IN ('archive', 'restore', 'deletion_request', 'permanent_delete')),
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_account_type TEXT NOT NULL,
      actor_credential TEXT NOT NULL,
      reason TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS image_quarantine (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_type TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      field_name TEXT NOT NULL,
      original_value TEXT NOT NULL,
      quarantined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      quarantined_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      restored_at TEXT,
      restored_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
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
    CREATE INDEX IF NOT EXISTS idx_archive_records_status_module ON archive_records(status, module, archived_at, id);
    CREATE INDEX IF NOT EXISTS idx_archive_history_archive_time ON archive_history(archive_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_image_quarantine_owner ON image_quarantine(owner_type, owner_id, restored_at, id);
    CREATE INDEX IF NOT EXISTS idx_legacy_concert_workflow_archive_source
      ON legacy_concert_workflow_archive(source_type, source_id);
  `);
  if (!contributorTableAlreadyExisted) {
    db.prepare(`INSERT INTO contributors (name, github_url, display_order)
      VALUES (?, ?, 0)`).run('SWzei', 'https://github.com/swzei');
  }
  db.exec(`
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
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_gallery_items_order ON gallery_items(display_order, id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_contributors_order ON contributors(display_order, id)');
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_content_attachments_owner ON content_attachments(owner_type, owner_id, created_at, id)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_schedule_user_settings_semester_user ON schedule_user_settings(semester_id, user_id)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_class_matching_profiles_term_type ON class_matching_profiles(term_id, participant_type, qualification_status)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_class_matching_availability_term_user ON class_matching_availability(term_id, user_id, slot_id)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_class_matching_rankings_term_user ON class_matching_rankings(term_id, user_id, rank_order)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_class_matching_versions_term_current ON class_matching_versions(term_id, is_current, version_number DESC)'
  );
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_class_matching_matches_version_teacher ON class_matching_matches(version_id, teacher_user_id, student_user_id)'
  );
  ensureColumn(db, 'class_matching_terms', 'semester_id', 'INTEGER REFERENCES semesters(id) ON DELETE RESTRICT');
  ensureColumn(db, 'class_matching_matches', 'room_slot_id', 'INTEGER REFERENCES room_slots(id) ON DELETE RESTRICT');
  db.exec('CREATE INDEX IF NOT EXISTS idx_class_matching_terms_semester ON class_matching_terms(semester_id, is_active)');
  if (sqliteTableExists(db, 'schedule_assignments')) {
    db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_assignments_batch_slot_unique ON schedule_assignments(batch_id, slot_id)'
    );
  }
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_class_matching_matches_version_room_unique ON class_matching_matches(version_id, room_slot_id) WHERE room_slot_id IS NOT NULL'
  );
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_class_matching_versions_one_current ON class_matching_versions(term_id) WHERE is_current = 1'
  );
  if (sqliteTableExists(db, 'schedule_batches')) {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_batches_one_proposed ON schedule_batches(semester_id) WHERE status = 'proposed'"
    );
  }
  if (sqliteTableExists(db, 'concert_applications')) {
    db.exec(
      'CREATE INDEX IF NOT EXISTS idx_concert_applications_concert_user ON concert_applications(concert_id, user_id)'
    );
  }
  ensureSqliteConcertApplicationsMultiEntry(db);
  backfillLegacyAnnouncementAttachments(db);
  repairStoredAttachmentOriginalNames(db);
}

function ensurePostgresRuntimeSchema(db) {
  const contributorTableAlreadyExisted = Number(db.prepare(`SELECT COUNT(*) AS count
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_name = 'contributors'`).get()?.count || 0) > 0;
  db.exec(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS account_type TEXT NOT NULL DEFAULT 'member';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_version INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_reminder_pending INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS public_id TEXT;
    ALTER TABLE concerts ADD COLUMN IF NOT EXISTS attachment_path TEXT;
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS attachment_path TEXT;
    ALTER TABLE activities ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;
    ALTER TABLE announcements ADD COLUMN IF NOT EXISTS published_at TIMESTAMP;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS photo_url TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS academy TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS hobbies TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS piano_interests TEXT;
    ALTER TABLE profiles ADD COLUMN IF NOT EXISTS wechat_account TEXT;
    ALTER TABLE concert_applications ADD COLUMN IF NOT EXISTS applicant_name TEXT;
    ALTER TABLE concert_applications ADD COLUMN IF NOT EXISTS applicant_student_number TEXT;
    ALTER TABLE concert_applications ADD COLUMN IF NOT EXISTS piece_zh TEXT;
    ALTER TABLE concert_applications ADD COLUMN IF NOT EXISTS piece_en TEXT;
    ALTER TABLE concert_applications ADD COLUMN IF NOT EXISTS duration_min INTEGER;
    ALTER TABLE concert_applications ADD COLUMN IF NOT EXISTS contact_qq TEXT;
    ALTER TABLE concert_applications DROP CONSTRAINT IF EXISTS concert_applications_concert_id_user_id_key;
    DROP INDEX IF EXISTS idx_concert_applications_concert_user_unique;
  `);

  db.exec(`
    UPDATE users SET account_type = 'member', is_admin = 1, role = 'member' WHERE role = 'admin';
    UPDATE profiles
       SET public_id = md5(random()::text || clock_timestamp()::text || user_id::text)
     WHERE public_id IS NULL OR BTRIM(public_id) = '';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_public_id ON profiles(public_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_single_active_maintainer ON users((1))
      WHERE account_type = 'maintainer' AND is_active = 1;
    CREATE INDEX IF NOT EXISTS idx_users_member_admin ON users(account_type, is_admin, is_active);
    CREATE TABLE IF NOT EXISTS admin_privilege_audit (
      id SERIAL PRIMARY KEY,
      operator_user_id INTEGER NOT NULL REFERENCES users(id),
      target_user_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL CHECK (action IN ('grant', 'revoke')),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_admin_privilege_audit_created
      ON admin_privilege_audit(created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS auth_security_audit (
      id BIGSERIAL PRIMARY KEY,
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_account_type TEXT NOT NULL CHECK (actor_account_type IN ('member', 'maintainer')),
      actor_credential TEXT NOT NULL,
      target_credential TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('admin_password_reset', 'member_password_change')),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_auth_security_audit_target_created
      ON auth_security_audit(target_user_id, created_at DESC, id DESC);
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      channel TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'system')),
      subject TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
      related_type TEXT,
      related_id INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      sent_at TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_notifications_user_created
      ON notifications(user_id, created_at DESC, id DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS class_matching_terms (
      id SERIAL PRIMARY KEY,
      semester_id INTEGER REFERENCES semesters(id) ON DELETE RESTRICT,
      name TEXT NOT NULL UNIQUE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS class_matching_slots (
      id SERIAL PRIMARY KEY,
      term_id INTEGER NOT NULL REFERENCES class_matching_terms(id) ON DELETE CASCADE,
      day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
      hour INTEGER NOT NULL CHECK (hour BETWEEN 8 AND 21),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (term_id, day_of_week, hour)
    );
    CREATE TABLE IF NOT EXISTS class_matching_profiles (
      id SERIAL PRIMARY KEY,
      term_id INTEGER NOT NULL REFERENCES class_matching_terms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      participant_type TEXT NOT NULL CHECK (participant_type IN ('student', 'teacher')),
      matching_mode TEXT NOT NULL DEFAULT 'ranking' CHECK (matching_mode IN ('direct', 'ranking')),
      skill_level TEXT,
      learning_goals TEXT,
      budget_expectation TEXT,
      teaching_experience TEXT,
      skill_specialization TEXT,
      fee_expectation TEXT,
      capacity INTEGER,
      direct_target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      qualification_status TEXT NOT NULL DEFAULT 'pending' CHECK (qualification_status IN ('pending', 'approved', 'rejected')),
      qualification_feedback TEXT,
      reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMP,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (term_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS class_matching_availability (
      id SERIAL PRIMARY KEY,
      term_id INTEGER NOT NULL REFERENCES class_matching_terms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      slot_id INTEGER NOT NULL REFERENCES class_matching_slots(id) ON DELETE CASCADE,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (term_id, user_id, slot_id)
    );
    CREATE TABLE IF NOT EXISTS class_matching_rankings (
      id SERIAL PRIMARY KEY,
      term_id INTEGER NOT NULL REFERENCES class_matching_terms(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      target_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rank_order INTEGER NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (term_id, user_id, target_user_id),
      UNIQUE (term_id, user_id, rank_order)
    );
    CREATE TABLE IF NOT EXISTS class_matching_versions (
      id SERIAL PRIMARY KEY,
      term_id INTEGER NOT NULL REFERENCES class_matching_terms(id) ON DELETE CASCADE,
      version_number INTEGER NOT NULL,
      source_type TEXT NOT NULL CHECK (source_type IN ('algorithm', 'manual', 'incremental', 'restore')),
      change_summary TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      based_on_version_id INTEGER REFERENCES class_matching_versions(id) ON DELETE SET NULL,
      is_current INTEGER NOT NULL DEFAULT 0,
      UNIQUE (term_id, version_number)
    );
    CREATE TABLE IF NOT EXISTS class_matching_matches (
      id SERIAL PRIMARY KEY,
      version_id INTEGER NOT NULL REFERENCES class_matching_versions(id) ON DELETE CASCADE,
      term_id INTEGER NOT NULL REFERENCES class_matching_terms(id) ON DELETE CASCADE,
      student_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      teacher_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      room_slot_id INTEGER REFERENCES room_slots(id) ON DELETE RESTRICT,
      match_type TEXT NOT NULL CHECK (match_type IN ('locked', 'algorithm', 'manual')),
      matching_score DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'matched',
      notes TEXT,
      admin_comment TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (version_id, student_user_id)
    );
    CREATE TABLE IF NOT EXISTS schedule_user_settings (
      id SERIAL PRIMARY KEY,
      semester_id INTEGER NOT NULL REFERENCES semesters(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      class_matching_priority INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (semester_id, user_id)
    );
    ALTER TABLE class_matching_terms ADD COLUMN IF NOT EXISTS semester_id INTEGER;
    ALTER TABLE class_matching_matches ADD COLUMN IF NOT EXISTS room_slot_id INTEGER;
    CREATE INDEX IF NOT EXISTS idx_schedule_user_settings_semester_user
      ON schedule_user_settings(semester_id, user_id);
    CREATE INDEX IF NOT EXISTS idx_class_matching_profiles_term_type
      ON class_matching_profiles(term_id, participant_type, qualification_status);
    CREATE INDEX IF NOT EXISTS idx_class_matching_availability_term_user
      ON class_matching_availability(term_id, user_id, slot_id);
    CREATE INDEX IF NOT EXISTS idx_class_matching_rankings_term_user
      ON class_matching_rankings(term_id, user_id, rank_order);
    CREATE INDEX IF NOT EXISTS idx_class_matching_versions_term_current
      ON class_matching_versions(term_id, is_current, version_number DESC);
    CREATE INDEX IF NOT EXISTS idx_class_matching_matches_version_teacher
      ON class_matching_matches(version_id, teacher_user_id, student_user_id);
    CREATE INDEX IF NOT EXISTS idx_class_matching_terms_semester
      ON class_matching_terms(semester_id, is_active);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_assignments_batch_slot_unique
      ON schedule_assignments(batch_id, slot_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_class_matching_matches_version_room_unique
      ON class_matching_matches(version_id, room_slot_id) WHERE room_slot_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_class_matching_versions_one_current
      ON class_matching_versions(term_id) WHERE is_current = 1;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schedule_batches_one_proposed
      ON schedule_batches(semester_id) WHERE status = 'proposed';
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schedule_operation_logs (
      id SERIAL PRIMARY KEY,
      batch_id INTEGER,
      semester_id INTEGER,
      operation_type TEXT NOT NULL,
      payload_json TEXT,
      created_by INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_operation_logs_batch_time
      ON schedule_operation_logs(batch_id, created_at DESC, id DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS gallery_items (
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
    CREATE INDEX IF NOT EXISTS idx_gallery_items_order ON gallery_items(display_order, id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS contributors (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL CHECK (CHAR_LENGTH(BTRIM(name)) BETWEEN 1 AND 80),
      github_url TEXT NOT NULL UNIQUE,
      display_order INTEGER NOT NULL DEFAULT 0 CHECK (display_order >= 0),
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_contributors_order ON contributors(display_order, id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS archive_records (
      id SERIAL PRIMARY KEY,
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
      id SERIAL PRIMARY KEY,
      archive_id INTEGER NOT NULL REFERENCES archive_records(id) ON DELETE RESTRICT,
      action TEXT NOT NULL CHECK (action IN ('archive', 'restore', 'deletion_request', 'permanent_delete')),
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_account_type TEXT NOT NULL,
      actor_credential TEXT NOT NULL,
      reason TEXT,
      details_json TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS image_quarantine (
      id SERIAL PRIMARY KEY,
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
    CREATE TABLE IF NOT EXISTS legacy_concert_workflow_archive (
      id SERIAL PRIMARY KEY,
      source_type TEXT NOT NULL CHECK (source_type IN ('audition_slot', 'concert_status')),
      source_id INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (source_type, source_id)
    );
    CREATE INDEX IF NOT EXISTS idx_archive_records_status_module ON archive_records(status, module, archived_at, id);
    CREATE INDEX IF NOT EXISTS idx_archive_history_archive_time ON archive_history(archive_id, created_at, id);
    CREATE INDEX IF NOT EXISTS idx_image_quarantine_owner ON image_quarantine(owner_type, owner_id, restored_at, id);
    CREATE INDEX IF NOT EXISTS idx_legacy_concert_workflow_archive_source
      ON legacy_concert_workflow_archive(source_type, source_id);
  `);
  if (!contributorTableAlreadyExisted) {
    db.prepare(`INSERT INTO contributors (name, github_url, display_order)
      VALUES (?, ?, 0)`).run('SWzei', 'https://github.com/swzei');
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS content_attachments (
      id SERIAL PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id INTEGER NOT NULL,
      original_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      file_size INTEGER NOT NULL DEFAULT 0,
      mime_type TEXT,
      created_by INTEGER,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_content_attachments_owner
      ON content_attachments(owner_type, owner_id, created_at, id);
  `);
  db.exec(
    'CREATE INDEX IF NOT EXISTS idx_concert_applications_concert_user ON concert_applications(concert_id, user_id)'
  );
  backfillLegacyAnnouncementAttachmentsPostgres(db);
  repairStoredAttachmentOriginalNames(db);
}

function createSqliteDb() {
  const dbPath = resolveDbPath(DB_PATH);
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const sqlite = new Database(dbPath);
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('journal_mode = WAL');

  ensureSqliteRuntimeSchema(sqlite);
  return sqlite;
}

function assertPostgresAccessSchema(db) {
  try {
    db.prepare(`SELECT
        u.account_type, u.is_admin, u.auth_version, u.is_active, u.must_change_password,
        u.profile_reminder_pending,
        p.public_id, a.action, g.is_visible, c.github_url,
        cmt.semester_id, cmm.room_slot_id, ar.status, ah.action, iq.field_name,
        lcwa.source_type, asa.action, n.status
      FROM users u
      LEFT JOIN profiles p ON p.user_id = u.id
      LEFT JOIN admin_privilege_audit a ON FALSE
      LEFT JOIN gallery_items g ON FALSE
      LEFT JOIN contributors c ON FALSE
      LEFT JOIN class_matching_terms cmt ON FALSE
      LEFT JOIN class_matching_matches cmm ON FALSE
      LEFT JOIN archive_records ar ON FALSE
      LEFT JOIN archive_history ah ON FALSE
      LEFT JOIN image_quarantine iq ON FALSE
      LEFT JOIN legacy_concert_workflow_archive lcwa ON FALSE
      LEFT JOIN auth_security_audit asa ON FALSE
      LEFT JOIN notifications n ON FALSE
      LIMIT 0`).all();
  } catch (err) {
    throw new Error(`PostgreSQL access schema is not ready; apply the reviewed migrations before startup: ${err.message}`);
  }
}

function createDb() {
  if (DATABASE_URL) {
    const pgDb = createPostgresCompatDb(DATABASE_URL);
    // eslint-disable-next-line no-console
    console.log('Using Postgres database (DATABASE_URL detected).');

    if (ALLOW_RUNTIME_SCHEMA_MIGRATION) {
      try {
        ensurePostgresRuntimeSchema(pgDb);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('Postgres runtime migration skipped:', err.message);
      }
    } else {
      assertPostgresAccessSchema(pgDb);
    }

    return pgDb;
  }

  return createSqliteDb();
}

const db = createDb();

export default db;
