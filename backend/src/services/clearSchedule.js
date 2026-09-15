import db from '../config/db.js';
import HttpError from '../utils/httpError.js';
import { lockSemesterInventory, loadEffectivePianoAssignments } from './roomInventory.js';

// Keep empty batches as explicit current plans so older published plans cannot reappear.
export function clearSchedule({ semesterId, scope, adminId }) {
  if (!['proposed', 'published'].includes(scope)) throw new HttpError(400, 'Invalid schedule scope');
  return db.transaction(() => {
    lockSemesterInventory(semesterId);
    const { batches } = loadEffectivePianoAssignments(semesterId);
    const batch = batches.find(item => item.status === scope);
    const count = batch ? Number(db.prepare('SELECT COUNT(*) AS count FROM schedule_assignments WHERE batch_id = ?').get(batch.id).count) : 0;
    let batchId = batch?.id;
    if (scope === 'proposed') {
      db.prepare("DELETE FROM schedule_assignments WHERE semester_id = ? AND batch_id IN (SELECT id FROM schedule_batches WHERE semester_id = ? AND status = 'proposed')").run(semesterId, semesterId);
    } else if (batch) {
      const result = db.prepare("INSERT INTO schedule_batches (semester_id, status, created_by, published_by, published_at, note) VALUES (?, 'published', ?, ?, CURRENT_TIMESTAMP, ?)").run(semesterId, adminId, adminId, 'Published piano time withdrawn by administrator');
      batchId = Number(result.lastInsertRowid);
    }
    return { semesterId, scope, clearedAssignments: count, batchId: batchId || null };
  })();
}
