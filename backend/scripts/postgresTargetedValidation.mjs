import assert from 'node:assert/strict';
import createPostgresCompatDb from '../src/config/postgresCompat.js';
import { isUniqueConstraintError } from '../src/utils/databaseErrors.js';

const databaseUrl = String(process.env.DATABASE_URL || '');
const parsed = new URL(databaseUrl);
if (!['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)) {
  throw new Error('PostgreSQL targeted validation requires a loopback host');
}
if (!/targeted|disposable|test/i.test(parsed.pathname)) {
  throw new Error('PostgreSQL targeted validation requires a clearly disposable database name');
}

const db = createPostgresCompatDb(databaseUrl);
let appDb;
try {
  const timestamp = db.prepare(
    `SELECT TIMESTAMP '2030-01-02 12:34:56' AS "naiveTimestamp",
            TIMESTAMPTZ '2030-01-02 12:34:56+00' AS "zonedTimestamp"`
  ).get();
  assert.equal(timestamp.naiveTimestamp, '2030-01-02T12:34:56.000Z');
  assert.equal(timestamp.zonedTimestamp, '2030-01-02T12:34:56.000Z');

  const name = `PG unique ${Date.now()}`;
  db.prepare(
    `INSERT INTO semesters (name, start_date, end_date, is_active)
     VALUES (?, '2030-01-01', '2030-06-01', 0)`
  ).run(name);
  let uniqueError;
  try {
    db.prepare(
      `INSERT INTO semesters (name, start_date, end_date, is_active)
       VALUES (?, '2031-01-01', '2031-06-01', 0)`
    ).run(name);
  } catch (err) {
    uniqueError = err;
  }
  assert(uniqueError);
  assert.equal(uniqueError.code, '23505');
  assert.match(uniqueError.constraint, /semesters_name_key/);
  assert(isUniqueConstraintError(uniqueError, { constraints: ['semesters_name_key'] }));

  const termName = `PG unique term ${Date.now()}`;
  db.prepare(
    `INSERT INTO class_matching_terms (name, start_date, end_date, is_active)
     VALUES (?, '2030-01-01', '2030-06-01', 0)`
  ).run(termName);
  let termUniqueError;
  try {
    db.prepare(
      `INSERT INTO class_matching_terms (name, start_date, end_date, is_active)
       VALUES (?, '2031-01-01', '2031-06-01', 0)`
    ).run(termName);
  } catch (err) {
    termUniqueError = err;
  }
  assert(termUniqueError);
  assert.equal(termUniqueError.code, '23505');
  assert.match(termUniqueError.constraint, /class_matching_terms_name_key/);
  assert(isUniqueConstraintError(termUniqueError, {
    constraints: ['class_matching_terms_name_key']
  }));

  const tableState = db.prepare(
    `SELECT
       to_regclass('public.notifications') AS notifications,
       to_regclass('public.auth_security_audit') AS "authSecurityAudit"`
  ).get();
  assert.equal(tableState.notifications, 'notifications');
  assert.equal(tableState.authSecurityAudit, 'auth_security_audit');

  const [{ default: selectedDb }, archiveModule] = await Promise.all([
    import('../src/config/db.js'),
    import('../src/services/archiveService.js')
  ]);
  appDb = selectedDb;
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const actor = appDb.prepare(
    `INSERT INTO users (student_number, password_hash, role, account_type, is_admin)
     VALUES (?, 'not-used', 'member', 'member', 1)`
  ).run(`pg-archive-admin-${suffix}`).lastInsertRowid;
  const student = appDb.prepare(
    `INSERT INTO users (student_number, password_hash) VALUES (?, 'not-used')`
  ).run(`pg-archive-student-${suffix}`).lastInsertRowid;
  const teacher = appDb.prepare(
    `INSERT INTO users (student_number, password_hash) VALUES (?, 'not-used')`
  ).run(`pg-archive-teacher-${suffix}`).lastInsertRowid;
  const semesterId = appDb.prepare(
    `INSERT INTO semesters (name, start_date, end_date, is_active)
     VALUES (?, '2032-01-01', '2032-06-01', 1)`
  ).run(`PG archive ${suffix}`).lastInsertRowid;
  const roomSlotId = appDb.prepare(
    `INSERT INTO room_slots (semester_id, room_no, day_of_week, hour)
     VALUES (?, 1, 1, 10)`
  ).run(semesterId).lastInsertRowid;
  const termId = appDb.prepare(
    `INSERT INTO class_matching_terms (semester_id, name, start_date, end_date, is_active)
     VALUES (?, ?, '2032-01-01', '2032-06-01', 1)`
  ).run(semesterId, `PG archived term ${suffix}`).lastInsertRowid;
  const classSlotId = appDb.prepare(
    `INSERT INTO class_matching_slots (term_id, day_of_week, hour) VALUES (?, 1, 10)`
  ).run(termId).lastInsertRowid;
  appDb.prepare(
    `INSERT INTO class_matching_profiles
       (term_id, user_id, participant_type, matching_mode, qualification_status, capacity)
     VALUES (?, ?, 'student', 'ranking', 'pending', NULL)`
  ).run(termId, student);
  appDb.prepare(
    `INSERT INTO class_matching_profiles
       (term_id, user_id, participant_type, matching_mode, qualification_status, capacity)
     VALUES (?, ?, 'teacher', 'ranking', 'approved', 1)`
  ).run(termId, teacher);
  appDb.prepare(
    `INSERT INTO class_matching_availability (term_id, user_id, slot_id) VALUES (?, ?, ?)`
  ).run(termId, student, classSlotId);
  appDb.prepare(
    `INSERT INTO class_matching_availability (term_id, user_id, slot_id) VALUES (?, ?, ?)`
  ).run(termId, teacher, classSlotId);
  const versionId = appDb.prepare(
    `INSERT INTO class_matching_versions (term_id, version_number, source_type, is_current)
     VALUES (?, 1, 'algorithm', 1)`
  ).run(termId).lastInsertRowid;
  appDb.prepare(
    `INSERT INTO class_matching_matches
       (version_id, term_id, student_user_id, teacher_user_id, room_slot_id, match_type)
     VALUES (?, ?, ?, ?, ?, 'algorithm')`
  ).run(versionId, termId, student, teacher, roomSlotId);

  const actorInfo = {
    id: Number(actor),
    accountType: 'member',
    studentNumber: `pg-archive-admin-${suffix}`
  };
  const archived = archiveModule.archiveRecord({
    module: 'class_matching',
    recordType: 'term',
    recordId: Number(termId),
    actor: actorInfo
  });
  const batchId = appDb.prepare(
    `INSERT INTO schedule_batches (semester_id, status, created_by)
     VALUES (?, 'published', ?)`
  ).run(semesterId, actor).lastInsertRowid;
  appDb.prepare(
    `INSERT INTO schedule_assignments
       (batch_id, semester_id, user_id, slot_id, status)
     VALUES (?, ?, ?, ?, 'published')`
  ).run(batchId, semesterId, actor, roomSlotId);

  assert.throws(
    () => archiveModule.restoreArchivedRecord({ archiveId: archived.id, actor: actorInfo }),
    (err) => err.status === 409 && /conflicts/i.test(err.message)
  );
  assert.equal(
    Number(appDb.prepare('SELECT is_active AS "active" FROM class_matching_terms WHERE id = ?').get(termId).active),
    0
  );
  assert.equal(
    appDb.prepare('SELECT status FROM archive_records WHERE id = ?').get(archived.id).status,
    'archived'
  );
  appDb.prepare('DELETE FROM schedule_assignments WHERE batch_id = ?').run(batchId);
  const restored = archiveModule.restoreArchivedRecord({ archiveId: archived.id, actor: actorInfo });
  assert.equal(restored.status, 'restored');
  assert.equal(
    Number(appDb.prepare('SELECT is_active AS "active" FROM class_matching_terms WHERE id = ?').get(termId).active),
    1
  );

  console.log('PostgreSQL targeted validation passed.');
} finally {
  appDb?.close();
  db.close();
}
