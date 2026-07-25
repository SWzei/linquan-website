import db from '../../config/db.js';
import HttpError from '../../utils/httpError.js';
import { currentUtcIsoString } from '../../utils/dateTime.js';
import { isUniqueConstraintError } from '../../utils/databaseErrors.js';

export const DEFAULT_TEACHER_CAPACITY = 1;

function mapBoolean(value) {
  return Boolean(Number(value || 0));
}

export function clampCapacity(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_TEACHER_CAPACITY;
  }
  return parsed;
}

export function listTerms() {
  return db
    .prepare(
      `SELECT
         term.id,
         term.semester_id AS "semesterId",
         semester.name AS "semesterName",
         term.name,
         term.start_date AS "startDate",
         term.end_date AS "endDate",
         term.is_active AS "isActive",
         term.created_at AS "createdAt",
         term.updated_at AS "updatedAt"
       FROM class_matching_terms term
       LEFT JOIN semesters semester ON semester.id = term.semester_id
       WHERE NOT EXISTS (SELECT 1 FROM archive_records ar
         WHERE ar.module = 'class_matching' AND ar.record_type = 'term'
           AND ar.record_id = term.id AND ar.status IN ('archived', 'deletion_requested'))
         AND NOT EXISTS (SELECT 1 FROM archive_records parent_archive
           WHERE parent_archive.module = 'scheduling' AND parent_archive.record_type = 'semester'
             AND parent_archive.record_id = term.semester_id
             AND parent_archive.status IN ('archived', 'deletion_requested'))
       ORDER BY term.is_active DESC, term.start_date DESC, term.id DESC`
    )
    .all()
    .map((item) => ({
      ...item,
      isActive: mapBoolean(item.isActive)
    }));
}

export function getTerm(termId) {
  const row = db
    .prepare(
      `SELECT
         term.id,
         term.semester_id AS "semesterId",
         semester.name AS "semesterName",
         term.name,
         term.start_date AS "startDate",
         term.end_date AS "endDate",
         term.is_active AS "isActive",
         term.created_at AS "createdAt",
         term.updated_at AS "updatedAt"
       FROM class_matching_terms term
       LEFT JOIN semesters semester ON semester.id = term.semester_id
       WHERE term.id = ?
         AND NOT EXISTS (SELECT 1 FROM archive_records ar
           WHERE ar.module = 'class_matching' AND ar.record_type = 'term'
             AND ar.record_id = term.id AND ar.status IN ('archived', 'deletion_requested'))
         AND NOT EXISTS (SELECT 1 FROM archive_records parent_archive
           WHERE parent_archive.module = 'scheduling' AND parent_archive.record_type = 'semester'
             AND parent_archive.record_id = term.semester_id
             AND parent_archive.status IN ('archived', 'deletion_requested'))`
    )
    .get(termId);
  if (!row) {
    throw new HttpError(404, 'Class matching term not found');
  }
  return {
    ...row,
    isActive: mapBoolean(row.isActive)
  };
}

function assertSemesterWithSlots(semesterId) {
  const semester = db
    .prepare(`SELECT semester.id, semester.name, semester.start_date AS "startDate", semester.end_date AS "endDate"
      FROM semesters semester WHERE semester.id = ?
        AND NOT EXISTS (SELECT 1 FROM archive_records ar
          WHERE ar.module = 'scheduling' AND ar.record_type = 'semester'
            AND ar.record_id = semester.id AND ar.status IN ('archived', 'deletion_requested'))`)
    .get(semesterId);
  if (!semester) {
    throw new HttpError(400, 'Class matching term must reference an existing Piano Time semester');
  }
  const slotCount = db.prepare('SELECT COUNT(*) AS count FROM room_slots WHERE semester_id = ?').get(semesterId);
  if (Number(slotCount?.count || 0) === 0) {
    throw new HttpError(400, 'The selected semester has no piano-room inventory');
  }
  return semester;
}

function syncTermSlots(termId, semesterId) {
  db.prepare(
    `INSERT OR IGNORE INTO class_matching_slots (term_id, day_of_week, hour)
     SELECT ?, day_of_week, hour
     FROM room_slots
     WHERE semester_id = ?
     GROUP BY day_of_week, hour`
  ).run(termId, semesterId);
}

export function createTerm({ semesterId, name, startDate, endDate, activate }) {
  if (endDate < startDate) {
    throw new HttpError(400, 'End date must be on or after the start date');
  }
  assertSemesterWithSlots(semesterId);
  const nowUtc = currentUtcIsoString();
  const tx = db.transaction(() => {
    if (activate) {
      db.prepare('UPDATE class_matching_terms SET is_active = 0, updated_at = ?').run(nowUtc);
    }
    const result = db
      .prepare(
        `INSERT INTO class_matching_terms (semester_id, name, start_date, end_date, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(semesterId, name, startDate, endDate, activate ? 1 : 0, nowUtc, nowUtc);
    const termId = Number(result.lastInsertRowid);
    syncTermSlots(termId, semesterId);
    return termId;
  });
  try {
    return getTerm(tx());
  } catch (err) {
    if (isUniqueConstraintError(err, {
      table: 'class_matching_terms',
      column: 'name',
      constraints: ['class_matching_terms_name_key']
    })) {
      throw new HttpError(409, 'A class matching term with this name already exists. Please choose a different name.');
    }
    throw err;
  }
}

export function updateTerm({ termId, semesterId, name, startDate, endDate, activate }) {
  const current = getTerm(termId);
  if ((endDate || current.endDate) < (startDate || current.startDate)) {
    throw new HttpError(400, 'End date must be on or after the start date');
  }
  const nextSemesterId = semesterId ?? current.semesterId;
  assertSemesterWithSlots(nextSemesterId);
  if (current.semesterId && Number(nextSemesterId) !== Number(current.semesterId)) {
    const dependentRows = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM class_matching_profiles WHERE term_id = ?) +
           (SELECT COUNT(*) FROM class_matching_versions WHERE term_id = ?) AS count`
      )
      .get(termId, termId);
    if (Number(dependentRows?.count || 0) > 0) {
      throw new HttpError(409, 'A class matching term with participants or versions cannot change semester inventory');
    }
  }
  const nowUtc = currentUtcIsoString();
  const tx = db.transaction(() => {
    if (activate) {
      db.prepare('UPDATE class_matching_terms SET is_active = 0, updated_at = ?').run(nowUtc);
    }
    db.prepare(
      `UPDATE class_matching_terms
       SET semester_id = ?, name = ?, start_date = ?, end_date = ?, is_active = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      nextSemesterId,
      name ?? current.name,
      startDate ?? current.startDate,
      endDate ?? current.endDate,
      activate === undefined ? (current.isActive ? 1 : 0) : activate ? 1 : 0,
      nowUtc,
      termId
    );
    syncTermSlots(termId, nextSemesterId);
  });
  try {
    tx();
    return getTerm(termId);
  } catch (err) {
    if (isUniqueConstraintError(err, {
      table: 'class_matching_terms',
      column: 'name',
      constraints: ['class_matching_terms_name_key']
    })) {
      throw new HttpError(409, 'A class matching term with this name already exists. Please choose a different name.');
    }
    throw err;
  }
}

export function loadBaseProfile(userId) {
  return (
    db
      .prepare(
        `SELECT
           u.id AS "userId",
           u.student_number AS "studentNumber",
           u.email,
           COALESCE(p.display_name, u.student_number) AS "displayName",
           p.avatar_url AS "avatarUrl",
           p.photo_url AS "photoUrl",
           p.bio,
           p.grade,
           p.major,
           p.academy,
           p.hobbies,
           p.piano_interests AS "pianoInterests",
           p.wechat_account AS "wechatAccount",
           p.phone
         FROM users u
         LEFT JOIN profiles p ON p.user_id = u.id
         WHERE u.id = ?`
      )
      .get(userId) || null
  );
}

export function loadParticipantProfiles(termId) {
  return db
    .prepare(
      `SELECT
         cmp.id,
         cmp.term_id AS "termId",
         cmp.user_id AS "userId",
         u.student_number AS "studentNumber",
         COALESCE(p.display_name, u.student_number) AS "displayName",
         p.avatar_url AS "avatarUrl",
         p.bio,
         p.grade,
         p.major,
         p.academy,
         cmp.participant_type AS "participantType",
         cmp.matching_mode AS "matchingMode",
         cmp.skill_level AS "skillLevel",
         cmp.learning_goals AS "learningGoals",
         cmp.budget_expectation AS "budgetExpectation",
         cmp.teaching_experience AS "teachingExperience",
         cmp.skill_specialization AS "skillSpecialization",
         cmp.fee_expectation AS "feeExpectation",
         cmp.capacity,
         cmp.direct_target_user_id AS "directTargetUserId",
         cmp.qualification_status AS "qualificationStatus",
         cmp.qualification_feedback AS "qualificationFeedback",
         cmp.reviewed_by AS "reviewedBy",
         cmp.reviewed_at AS "reviewedAt",
         cmp.created_at AS "createdAt",
         cmp.updated_at AS "updatedAt"
       FROM class_matching_profiles cmp
       JOIN users u ON u.id = cmp.user_id
       LEFT JOIN profiles p ON p.user_id = u.id
       WHERE cmp.term_id = ? AND u.account_type = 'member' AND u.is_active = 1
       ORDER BY cmp.participant_type ASC, u.student_number ASC`
    )
    .all(termId)
    .map((item) => ({
      ...item,
      capacity: item.participantType === 'teacher' ? clampCapacity(item.capacity) : null
    }));
}

export function loadParticipantProfile(termId, userId) {
  return (
    db
      .prepare(
        `SELECT
           id,
           term_id AS "termId",
           user_id AS "userId",
           participant_type AS "participantType",
           matching_mode AS "matchingMode",
           skill_level AS "skillLevel",
           learning_goals AS "learningGoals",
           budget_expectation AS "budgetExpectation",
           teaching_experience AS "teachingExperience",
           skill_specialization AS "skillSpecialization",
           fee_expectation AS "feeExpectation",
           capacity,
           direct_target_user_id AS "directTargetUserId",
           qualification_status AS "qualificationStatus",
           qualification_feedback AS "qualificationFeedback",
           reviewed_by AS "reviewedBy",
           reviewed_at AS "reviewedAt",
           created_at AS "createdAt",
           updated_at AS "updatedAt"
         FROM class_matching_profiles
         WHERE term_id = ? AND user_id = ?`
      )
      .get(termId, userId) || null
  );
}

export function loadTermSlots(termId, userId = null) {
  return db
    .prepare(
      `SELECT
         slots.id,
         slots.day_of_week AS "dayOfWeek",
         slots.hour,
         COALESCE(counts.count, 0) AS "selectedCount",
         CASE WHEN mine.slot_id IS NULL THEN 0 ELSE 1 END AS "selectedByMe"
       FROM class_matching_slots slots
       LEFT JOIN (
         SELECT availability.slot_id, COUNT(*) AS count
         FROM class_matching_availability availability
         JOIN users active_user
           ON active_user.id = availability.user_id
          AND active_user.account_type = 'member'
          AND active_user.is_active = 1
         WHERE availability.term_id = ?
         GROUP BY availability.slot_id
       ) counts ON counts.slot_id = slots.id
       LEFT JOIN class_matching_availability mine
         ON mine.term_id = ?
        AND mine.user_id = ?
        AND mine.slot_id = slots.id
       WHERE slots.term_id = ?
       ORDER BY slots.day_of_week ASC, slots.hour ASC`
    )
    .all(termId, termId, userId || -1, termId)
    .map((item) => ({
      ...item,
      selectedByMe: mapBoolean(item.selectedByMe)
    }));
}

export function loadAvailabilityIds(termId, userId) {
  return db
    .prepare(
      `SELECT slot_id AS "slotId"
       FROM class_matching_availability
       WHERE term_id = ? AND user_id = ?
       ORDER BY slot_id ASC`
    )
    .all(termId, userId)
    .map((row) => row.slotId);
}

export function loadRankingIds(termId, userId) {
  return db
    .prepare(
      `SELECT target_user_id AS "targetUserId"
       FROM class_matching_rankings
       WHERE term_id = ? AND user_id = ?
       ORDER BY rank_order ASC`
    )
    .all(termId, userId)
    .map((row) => row.targetUserId);
}

export function loadAvailabilityMap(termId) {
  const rows = db
    .prepare(
      `SELECT user_id AS "userId", slot_id AS "slotId"
       FROM class_matching_availability
       WHERE term_id = ?`
    )
    .all(termId);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.userId)) {
      map.set(row.userId, new Set());
    }
    map.get(row.userId).add(row.slotId);
  }
  return map;
}

export function loadRankingsMap(termId) {
  const rows = db
    .prepare(
      `SELECT
         user_id AS "userId",
         target_user_id AS "targetUserId",
         rank_order AS "rankOrder"
       FROM class_matching_rankings
       WHERE term_id = ?
       ORDER BY user_id ASC, rank_order ASC`
    )
    .all(termId);
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row.userId)) {
      map.set(row.userId, []);
    }
    map.get(row.userId).push({
      targetUserId: row.targetUserId,
      rankOrder: row.rankOrder
    });
  }
  return map;
}

export function buildCandidateLists(termId, currentUserId) {
  const profiles = loadParticipantProfiles(termId);
  const teacherCandidates = profiles
    .filter((item) => item.participantType === 'teacher' && item.userId !== currentUserId)
    .filter((item) => item.qualificationStatus === 'approved')
    .map((item) => ({
      userId: item.userId,
      studentNumber: item.studentNumber,
      displayName: item.displayName,
      matchingMode: item.matchingMode,
      capacity: item.capacity,
      skillSpecialization: item.skillSpecialization,
      feeExpectation: item.feeExpectation,
      qualificationStatus: item.qualificationStatus
    }));
  const studentCandidates = profiles
    .filter((item) => item.participantType === 'student' && item.userId !== currentUserId)
    .map((item) => ({
      userId: item.userId,
      studentNumber: item.studentNumber,
      displayName: item.displayName,
      matchingMode: item.matchingMode,
      skillLevel: item.skillLevel,
      learningGoals: item.learningGoals
    }));

  return { teacherCandidates, studentCandidates };
}

export function validateOppositeTarget(termId, currentUserId, participantType, targetUserId) {
  if (!targetUserId) {
    return null;
  }
  const target = loadParticipantProfile(termId, targetUserId);
  if (!target) {
    throw new HttpError(400, 'Direct target must already join this class matching term');
  }
  if (target.userId === currentUserId) {
    throw new HttpError(400, 'Direct target cannot be yourself');
  }
  const expectedType = participantType === 'student' ? 'teacher' : 'student';
  if (target.participantType !== expectedType) {
    throw new HttpError(400, 'Direct target must be the opposite participant type');
  }
  if (target.matchingMode !== 'direct') {
    throw new HttpError(400, 'Direct target must also use direct mode in this term');
  }
  if (participantType === 'student' && target.qualificationStatus !== 'approved') {
    throw new HttpError(400, 'Direct target teacher must be approved by admin');
  }
  return target;
}

export function assertValidSlotIds(termId, slotIds) {
  const uniqueSlotIds = [...new Set(slotIds.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
  if (uniqueSlotIds.length === 0) {
    return [];
  }
  const placeholders = uniqueSlotIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id
       FROM class_matching_slots
       WHERE term_id = ? AND id IN (${placeholders})`
    )
    .all(termId, ...uniqueSlotIds);
  if (rows.length !== uniqueSlotIds.length) {
    throw new HttpError(400, 'One or more availability slotIds do not belong to the selected term');
  }
  return uniqueSlotIds;
}

export function assertValidRankingTargets(termId, userId, participantType, targetUserIds) {
  const expectedType = participantType === 'student' ? 'teacher' : 'student';
  const uniqueIds = [...new Set(targetUserIds.map((item) => Number(item)).filter((item) => Number.isInteger(item) && item > 0))];
  if (uniqueIds.length === 0) {
    return [];
  }
  const placeholders = uniqueIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT
         user_id AS "userId",
         participant_type AS "participantType",
         qualification_status AS "qualificationStatus"
       FROM class_matching_profiles
       WHERE term_id = ? AND user_id IN (${placeholders})`
    )
    .all(termId, ...uniqueIds);
  if (rows.length !== uniqueIds.length) {
    throw new HttpError(400, 'One or more ranking targets have not joined this term');
  }
  for (const row of rows) {
    if (row.userId === userId) {
      throw new HttpError(400, 'Ranking target cannot be yourself');
    }
    if (row.participantType !== expectedType) {
      throw new HttpError(400, 'Ranking targets must be the opposite participant type');
    }
    const targetProfile = loadParticipantProfile(termId, row.userId);
    if (targetProfile?.matchingMode !== 'ranking') {
      throw new HttpError(400, 'Ranking targets must also use ranking mode in this term');
    }
    if (participantType === 'student' && row.qualificationStatus !== 'approved') {
      throw new HttpError(400, 'Students can only rank approved teachers');
    }
  }
  return uniqueIds;
}

export function saveProfile({ termId, userId, input }) {
  getTerm(termId);
  const nowUtc = currentUtcIsoString();
  const current = loadParticipantProfile(termId, userId);
  const nextParticipantType = input.participantType ?? current?.participantType;
  if (!nextParticipantType || !['student', 'teacher'].includes(nextParticipantType)) {
    throw new HttpError(400, 'participantType must be student or teacher');
  }
  const nextMatchingMode = input.matchingMode ?? current?.matchingMode ?? 'ranking';
  if (!['direct', 'ranking'].includes(nextMatchingMode)) {
    throw new HttpError(400, 'matchingMode must be direct or ranking');
  }

  const directTargetUserId =
    Object.prototype.hasOwnProperty.call(input, 'directTargetUserId')
      ? (input.directTargetUserId ? Number(input.directTargetUserId) : null)
      : current?.directTargetUserId || null;
  validateOppositeTarget(termId, userId, nextParticipantType, directTargetUserId);

  if (nextMatchingMode === 'ranking') {
    const incomingDirectReference = db.prepare(
      `SELECT user_id AS "userId"
       FROM class_matching_profiles
       WHERE term_id = ? AND matching_mode = 'direct' AND direct_target_user_id = ?
       LIMIT 1`
    ).get(termId, userId);
    if (incomingDirectReference) {
      throw new HttpError(
        409,
        'Cannot switch to ranking mode while another direct participant targets this profile'
      );
    }
  }

  const qualificationStatus = nextParticipantType === 'teacher' ? current?.qualificationStatus || 'pending' : 'pending';
  const values = {
    skillLevel: Object.prototype.hasOwnProperty.call(input, 'skillLevel') ? input.skillLevel : current?.skillLevel || null,
    learningGoals: Object.prototype.hasOwnProperty.call(input, 'learningGoals') ? input.learningGoals : current?.learningGoals || null,
    budgetExpectation: Object.prototype.hasOwnProperty.call(input, 'budgetExpectation')
      ? input.budgetExpectation
      : current?.budgetExpectation || null,
    teachingExperience: Object.prototype.hasOwnProperty.call(input, 'teachingExperience')
      ? input.teachingExperience
      : current?.teachingExperience || null,
    skillSpecialization: Object.prototype.hasOwnProperty.call(input, 'skillSpecialization')
      ? input.skillSpecialization
      : current?.skillSpecialization || null,
    feeExpectation: Object.prototype.hasOwnProperty.call(input, 'feeExpectation')
      ? input.feeExpectation
      : current?.feeExpectation || null,
    capacity: nextParticipantType === 'teacher'
      ? clampCapacity(Object.prototype.hasOwnProperty.call(input, 'capacity') ? input.capacity : current?.capacity)
      : null
  };
  const participantTypeChanged = Boolean(current && current.participantType !== nextParticipantType);
  const shouldClearRankings = nextMatchingMode === 'direct' || participantTypeChanged;

  const tx = db.transaction(() => {
    if (current) {
      db.prepare(
        `UPDATE class_matching_profiles
         SET participant_type = ?, matching_mode = ?, skill_level = ?, learning_goals = ?, budget_expectation = ?,
             teaching_experience = ?, skill_specialization = ?, fee_expectation = ?, capacity = ?,
             direct_target_user_id = ?, qualification_status = ?, updated_at = ?
         WHERE term_id = ? AND user_id = ?`
      ).run(
        nextParticipantType,
        nextMatchingMode,
        values.skillLevel,
        values.learningGoals,
        values.budgetExpectation,
        values.teachingExperience,
        values.skillSpecialization,
        values.feeExpectation,
        values.capacity,
        nextMatchingMode === 'direct' ? directTargetUserId : null,
        qualificationStatus,
        nowUtc,
        termId,
        userId
      );
      if (shouldClearRankings) {
        db.prepare('DELETE FROM class_matching_rankings WHERE term_id = ? AND user_id = ?').run(termId, userId);
        if (participantTypeChanged) {
          db.prepare('DELETE FROM class_matching_rankings WHERE term_id = ? AND target_user_id = ?').run(termId, userId);
        }
      }
      return;
    }

    db.prepare(
      `INSERT INTO class_matching_profiles (
         term_id, user_id, participant_type, matching_mode, skill_level, learning_goals, budget_expectation,
         teaching_experience, skill_specialization, fee_expectation, capacity, direct_target_user_id,
         qualification_status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      termId,
      userId,
      nextParticipantType,
      nextMatchingMode,
      values.skillLevel,
      values.learningGoals,
      values.budgetExpectation,
      values.teachingExperience,
      values.skillSpecialization,
      values.feeExpectation,
      values.capacity,
      nextMatchingMode === 'direct' ? directTargetUserId : null,
      qualificationStatus,
      nowUtc,
      nowUtc
    );
    if (shouldClearRankings) {
      db.prepare('DELETE FROM class_matching_rankings WHERE term_id = ? AND user_id = ?').run(termId, userId);
    }
  });
  tx();

  return loadParticipantProfile(termId, userId);
}

export function saveAvailability({ termId, userId, slotIds }) {
  getTerm(termId);
  const profile = loadParticipantProfile(termId, userId);
  if (!profile) {
    throw new HttpError(400, 'Please complete class matching profile first');
  }
  const validSlotIds = assertValidSlotIds(termId, slotIds);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM class_matching_availability WHERE term_id = ? AND user_id = ?').run(termId, userId);
    const insert = db.prepare(
      `INSERT INTO class_matching_availability (term_id, user_id, slot_id, created_at)
       VALUES (?, ?, ?, ?)`
    );
    const nowUtc = currentUtcIsoString();
    for (const slotId of validSlotIds) {
      insert.run(termId, userId, slotId, nowUtc);
    }
  });
  tx();

  return { termId, userId, slotIds: validSlotIds };
}

export function saveRankings({ termId, userId, targetUserIds }) {
  getTerm(termId);
  const profile = loadParticipantProfile(termId, userId);
  if (!profile) {
    throw new HttpError(400, 'Please complete class matching profile first');
  }
  if (profile.matchingMode !== 'ranking') {
    throw new HttpError(400, 'Ranking preferences are only available in ranking mode');
  }
  const validTargetIds = assertValidRankingTargets(termId, userId, profile.participantType, targetUserIds);
  const nowUtc = currentUtcIsoString();
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM class_matching_rankings WHERE term_id = ? AND user_id = ?').run(termId, userId);
    const insert = db.prepare(
      `INSERT INTO class_matching_rankings (term_id, user_id, target_user_id, rank_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    validTargetIds.forEach((targetUserId, index) => {
      insert.run(termId, userId, targetUserId, index + 1, nowUtc, nowUtc);
    });
  });
  tx();

  return { termId, userId, targetUserIds: validTargetIds };
}
