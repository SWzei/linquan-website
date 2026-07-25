import HttpError from './httpError.js';

export function getActiveSemesterId(db) {
  const row = db.prepare(`SELECT semester.id FROM semesters semester
    WHERE semester.is_active = 1
      AND NOT EXISTS (
        SELECT 1 FROM archive_records ar
        WHERE ar.module = 'scheduling' AND ar.record_type = 'semester'
          AND ar.record_id = semester.id AND ar.status IN ('archived', 'deletion_requested')
      )
    ORDER BY semester.id DESC LIMIT 1`).get();
  if (!row) {
    throw new HttpError(400, 'No active semester found. Ask an admin to create/activate one.');
  }
  return row.id;
}

export function resolveSemesterId(db, semesterIdInput) {
  if (semesterIdInput !== undefined && semesterIdInput !== null && semesterIdInput !== '') {
    const semesterId = Number(semesterIdInput);
    if (!Number.isInteger(semesterId) || semesterId <= 0) {
      throw new HttpError(400, 'Invalid semesterId');
    }
    const exists = db.prepare(`SELECT semester.id FROM semesters semester
      WHERE semester.id = ?
        AND NOT EXISTS (
          SELECT 1 FROM archive_records ar
          WHERE ar.module = 'scheduling' AND ar.record_type = 'semester'
            AND ar.record_id = semester.id AND ar.status IN ('archived', 'deletion_requested')
        )`).get(semesterId);
    if (!exists) {
      throw new HttpError(404, 'Semester not found');
    }
    return semesterId;
  }
  return getActiveSemesterId(db);
}

export function createStandardSlots(db, semesterId) {
  const stmt = db.prepare(
    'INSERT OR IGNORE INTO room_slots (semester_id, room_no, day_of_week, hour) VALUES (?, ?, ?, ?)'
  );

  const tx = db.transaction(() => {
    for (let room = 1; room <= 2; room += 1) {
      for (let day = 0; day <= 6; day += 1) {
        for (let hour = 8; hour <= 21; hour += 1) {
          stmt.run(semesterId, room, day, hour);
        }
      }
    }
  });

  tx();
}
