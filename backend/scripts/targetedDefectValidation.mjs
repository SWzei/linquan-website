import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linquan-targeted-'));
const dbPath = path.join(tempRoot, 'targeted.sqlite');
process.env.NODE_ENV = 'test';
process.env.DB_PATH = dbPath;
process.env.DATABASE_URL = '';
process.env.UPLOAD_ROOT = path.join(tempRoot, 'uploads');
process.env.JWT_SECRET = 'targeted-validation-secret-32-characters';
process.env.MAX_UPLOAD_REQUEST_BYTES = '1024';
process.env.MIN_UPLOAD_FREE_BYTES = '1';
fs.mkdirSync(process.env.UPLOAD_ROOT, { recursive: true });

const [{ default: db }, { archiveRecord, restoreArchivedRecord }, concertModule, errorModule, uploadModule] = await Promise.all([
  import('../src/config/db.js'),
  import('../src/services/archiveService.js'),
  import('../src/routes/concertRoutes.js'),
  import('../src/utils/databaseErrors.js'),
  import('../src/middleware/uploadProtection.js')
]);

try {
  const schema = fs.readFileSync(path.resolve('../database/schema.sql'), 'utf8');
  db.exec(schema);

  const boundary = Date.parse('2030-01-01T00:00:00.000Z');
  assert.doesNotThrow(() => concertModule.assertConcertAcceptingApplications({
    status: 'open',
    applicationDeadline: '2030-01-01T00:00:00.001Z'
  }, boundary));
  assert.throws(
    () => concertModule.assertConcertAcceptingApplications({
      status: 'open',
      applicationDeadline: '2030-01-01T00:00:00.000Z'
    }, boundary),
    (err) => err.status === 409
  );
  assert.throws(
    () => concertModule.assertConcertAcceptingApplications({ status: 'closed', applicationDeadline: null }, boundary),
    (err) => err.status === 409
  );

  assert(errorModule.isUniqueConstraintError(
    Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      constraint: 'semesters_name_key'
    }),
    { constraints: ['semesters_name_key'] }
  ));
  assert(errorModule.isUniqueConstraintError(
    Object.assign(new Error('UNIQUE constraint failed: semesters.name'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE'
    }),
    { table: 'semesters', column: 'name' }
  ));
  assert.equal(errorModule.isUniqueConstraintError(Object.assign(new Error('connection failed'), { code: '08006' })), false);

  let oversizedHeaderError;
  uploadModule.checkUploadCapacity(
    { headers: { 'content-length': '1025' } },
    {},
    (err) => { oversizedHeaderError = err; }
  );
  assert.equal(oversizedHeaderError?.status, 413);
  assert.throws(
    () => uploadModule.assertUploadBudget({ incomingBytes: 1024, freeBytes: 1024 }),
    (err) => err.status === 507
  );

  const rejectedUploadPath = path.join(process.env.UPLOAD_ROOT, 'oversized.bin');
  fs.writeFileSync(rejectedUploadPath, Buffer.alloc(16));
  let oversizedFilesError;
  uploadModule.enforceUploadedFileBudget(
    {
      files: [
        { path: rejectedUploadPath, size: 600 },
        { size: 425 }
      ]
    },
    {},
    (err) => { oversizedFilesError = err; }
  );
  assert.equal(oversizedFilesError?.status, 413);
  assert.equal(fs.existsSync(rejectedUploadPath), false);

  const actor = db.prepare(
    `INSERT INTO users (student_number, password_hash, role, account_type, is_admin)
     VALUES ('archive-admin', 'not-used', 'member', 'member', 1)`
  ).run().lastInsertRowid;
  const student = db.prepare(
    `INSERT INTO users (student_number, password_hash) VALUES ('archive-student', 'not-used')`
  ).run().lastInsertRowid;
  const teacher = db.prepare(
    `INSERT INTO users (student_number, password_hash) VALUES ('archive-teacher', 'not-used')`
  ).run().lastInsertRowid;
  const semesterId = db.prepare(
    `INSERT INTO semesters (name, start_date, end_date, is_active)
     VALUES ('Archive validation', '2030-01-01', '2030-06-01', 1)`
  ).run().lastInsertRowid;
  const roomSlotId = db.prepare(
    `INSERT INTO room_slots (semester_id, room_no, day_of_week, hour)
     VALUES (?, 1, 1, 10)`
  ).run(semesterId).lastInsertRowid;
  const termId = db.prepare(
    `INSERT INTO class_matching_terms (semester_id, name, start_date, end_date, is_active)
     VALUES (?, 'Archived term', '2030-01-01', '2030-06-01', 1)`
  ).run(semesterId).lastInsertRowid;
  const classSlotId = db.prepare(
    `INSERT INTO class_matching_slots (term_id, day_of_week, hour) VALUES (?, 1, 10)`
  ).run(termId).lastInsertRowid;
  db.prepare(
    `INSERT INTO class_matching_profiles
       (term_id, user_id, participant_type, matching_mode, qualification_status, capacity)
     VALUES (?, ?, 'student', 'ranking', 'pending', NULL)`
  ).run(termId, student);
  db.prepare(
    `INSERT INTO class_matching_profiles
       (term_id, user_id, participant_type, matching_mode, qualification_status, capacity)
     VALUES (?, ?, 'teacher', 'ranking', 'approved', 1)`
  ).run(termId, teacher);
  db.prepare(
    `INSERT INTO class_matching_availability (term_id, user_id, slot_id) VALUES (?, ?, ?)`
  ).run(termId, student, classSlotId);
  db.prepare(
    `INSERT INTO class_matching_availability (term_id, user_id, slot_id) VALUES (?, ?, ?)`
  ).run(termId, teacher, classSlotId);
  const versionId = db.prepare(
    `INSERT INTO class_matching_versions (term_id, version_number, source_type, is_current)
     VALUES (?, 1, 'algorithm', 1)`
  ).run(termId).lastInsertRowid;
  db.prepare(
    `INSERT INTO class_matching_matches
       (version_id, term_id, student_user_id, teacher_user_id, room_slot_id, match_type)
     VALUES (?, ?, ?, ?, ?, 'algorithm')`
  ).run(versionId, termId, student, teacher, roomSlotId);

  const actorInfo = {
    id: Number(actor),
    accountType: 'member',
    studentNumber: 'archive-admin'
  };
  const archived = archiveRecord({
    module: 'class_matching',
    recordType: 'term',
    recordId: Number(termId),
    actor: actorInfo
  });
  const batchId = db.prepare(
    `INSERT INTO schedule_batches (semester_id, status, created_by)
     VALUES (?, 'published', ?)`
  ).run(semesterId, actor).lastInsertRowid;
  db.prepare(
    `INSERT INTO schedule_assignments
       (batch_id, semester_id, user_id, slot_id, status)
     VALUES (?, ?, ?, ?, 'published')`
  ).run(batchId, semesterId, actor, roomSlotId);

  assert.throws(
    () => restoreArchivedRecord({ archiveId: archived.id, actor: actorInfo }),
    (err) => err.status === 409 && /conflicts/i.test(err.message)
  );
  assert.equal(
    db.prepare('SELECT is_active AS active FROM class_matching_terms WHERE id = ?').get(termId).active,
    0
  );
  assert.equal(
    db.prepare('SELECT status FROM archive_records WHERE id = ?').get(archived.id).status,
    'archived'
  );

  db.prepare('DELETE FROM schedule_assignments WHERE batch_id = ?').run(batchId);
  const restored = restoreArchivedRecord({ archiveId: archived.id, actor: actorInfo });
  assert.equal(restored.status, 'restored');
  assert.equal(
    db.prepare('SELECT is_active AS active FROM class_matching_terms WHERE id = ?').get(termId).active,
    1
  );

  console.log('Targeted defect validation passed.');
} finally {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
