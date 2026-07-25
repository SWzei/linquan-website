import HttpError from './httpError.js';

export function getActiveClassMatchingTermId(db) {
  const row = db
    .prepare(
      `SELECT id
       FROM class_matching_terms
       WHERE is_active = 1
       ORDER BY id DESC
       LIMIT 1`
    )
    .get();
  if (!row) {
    throw new HttpError(400, 'No active class matching term found. Ask an admin to create/activate one.');
  }
  return row.id;
}

export function resolveClassMatchingTermId(db, termIdInput) {
  if (termIdInput !== undefined && termIdInput !== null && termIdInput !== '') {
    const termId = Number(termIdInput);
    if (!Number.isInteger(termId) || termId <= 0) {
      throw new HttpError(400, 'Invalid termId');
    }
    const exists = db.prepare('SELECT id FROM class_matching_terms WHERE id = ?').get(termId);
    if (!exists) {
      throw new HttpError(404, 'Class matching term not found');
    }
    return termId;
  }
  return getActiveClassMatchingTermId(db);
}

export function createStandardMatchingSlots(db, termId) {
  const insert = db.prepare(
    'INSERT OR IGNORE INTO class_matching_slots (term_id, day_of_week, hour) VALUES (?, ?, ?)'
  );

  const tx = db.transaction(() => {
    for (let day = 0; day <= 6; day += 1) {
      for (let hour = 8; hour <= 21; hour += 1) {
        insert.run(termId, day, hour);
      }
    }
  });

  tx();
}
