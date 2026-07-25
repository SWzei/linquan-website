import db from '../config/db.js';
import HttpError from '../utils/httpError.js';

export function roomTimeKey(dayOfWeek, hour) {
  return `${Number(dayOfWeek)}:${Number(hour)}`;
}

export function lockSemesterInventory(semesterId) {
  const result = db
    .prepare('UPDATE semesters SET is_active = is_active WHERE id = ?')
    .run(semesterId);
  if (Number(result.changes || 0) !== 1) {
    throw new HttpError(404, 'Semester not found');
  }
}

export function loadRoomSlots(semesterId) {
  return db
    .prepare(
      `SELECT
         id,
         semester_id AS "semesterId",
         room_no AS "roomNo",
         day_of_week AS "dayOfWeek",
         hour
       FROM room_slots
       WHERE semester_id = ?
       ORDER BY day_of_week ASC, hour ASC, room_no ASC, id ASC`
    )
    .all(semesterId);
}

export function getEffectivePianoBatches(semesterId) {
  const selectLatestByStatus = db.prepare(
    `SELECT id, status
     FROM schedule_batches
     WHERE semester_id = ? AND status = ?
     ORDER BY created_at DESC, id DESC
     LIMIT 1`
  );
  return ['proposed', 'published']
    .map((status) => selectLatestByStatus.get(semesterId, status))
    .filter(Boolean);
}

export function loadEffectivePianoAssignments(semesterId) {
  const batches = getEffectivePianoBatches(semesterId);
  if (batches.length === 0) {
    return { batches: [], assignments: [] };
  }
  const batchIds = batches.map((batch) => Number(batch.id));
  const placeholders = batchIds.map(() => '?').join(', ');
  const assignments = db
    .prepare(
      `SELECT
         sa.id,
         sa.user_id AS "userId",
         sa.slot_id AS "roomSlotId",
         rs.day_of_week AS "dayOfWeek",
         rs.hour
       FROM schedule_assignments sa
       JOIN room_slots rs ON rs.id = sa.slot_id AND rs.semester_id = sa.semester_id
       WHERE sa.batch_id IN (${placeholders})
       ORDER BY sa.id ASC`
    )
    .all(...batchIds);
  return { batches, assignments };
}

export function loadCurrentClassAssignments(semesterId) {
  return db
    .prepare(
      `SELECT
         m.id,
         m.student_user_id AS "studentUserId",
         m.teacher_user_id AS "teacherUserId",
         m.room_slot_id AS "roomSlotId",
         rs.day_of_week AS "dayOfWeek",
         rs.hour
       FROM class_matching_terms term
       JOIN class_matching_versions version
         ON version.term_id = term.id AND version.is_current = 1
       JOIN class_matching_matches m ON m.version_id = version.id
       JOIN room_slots rs ON rs.id = m.room_slot_id AND rs.semester_id = term.semester_id
       WHERE term.semester_id = ? AND term.is_active = 1
       ORDER BY m.id ASC`
    )
    .all(semesterId);
}

export function addParticipantBusyTime(map, userId, dayOfWeek, hour) {
  const numericUserId = Number(userId);
  if (!map.has(numericUserId)) {
    map.set(numericUserId, new Set());
  }
  map.get(numericUserId).add(roomTimeKey(dayOfWeek, hour));
}

export function buildPianoOccupancy(semesterId) {
  const { batches, assignments } = loadEffectivePianoAssignments(semesterId);
  const occupiedRoomSlotIds = new Set();
  const participantBusyTimes = new Map();
  for (const item of assignments) {
    occupiedRoomSlotIds.add(Number(item.roomSlotId));
    addParticipantBusyTime(participantBusyTimes, item.userId, item.dayOfWeek, item.hour);
  }
  return { batches, assignments, occupiedRoomSlotIds, participantBusyTimes };
}

export function buildClassOccupancy(semesterId) {
  const assignments = loadCurrentClassAssignments(semesterId);
  const occupiedRoomSlotIds = new Set();
  const participantBusyTimes = new Map();
  for (const item of assignments) {
    occupiedRoomSlotIds.add(Number(item.roomSlotId));
    addParticipantBusyTime(participantBusyTimes, item.studentUserId, item.dayOfWeek, item.hour);
    addParticipantBusyTime(participantBusyTimes, item.teacherUserId, item.dayOfWeek, item.hour);
  }
  return { assignments, occupiedRoomSlotIds, participantBusyTimes };
}
