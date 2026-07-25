import HttpError from '../../utils/httpError.js';
import { clampCapacity, loadAvailabilityMap, loadParticipantProfile, loadParticipantProfiles, loadRankingsMap } from './common.js';
import {
  createAllocationState,
  hasSharedAvailability,
  loadClassAllocationContext,
  releaseMatchRoom,
  reserveMatchRoom
} from './allocation.js';

function buildRankingIndex(rankings) {
  const map = new Map();
  for (const [userId, rows] of rankings.entries()) {
    const indexMap = new Map();
    rows.forEach((row, index) => {
      indexMap.set(row.targetUserId, index + 1);
    });
    map.set(userId, indexMap);
  }
  return map;
}

function computeOverlapCount(studentUserId, teacherUserId, availabilityMap) {
  const studentSlots = availabilityMap.get(studentUserId) || new Set();
  const teacherSlots = availabilityMap.get(teacherUserId) || new Set();
  let overlap = 0;
  for (const slotId of studentSlots) {
    if (teacherSlots.has(slotId)) {
      overlap += 1;
    }
  }
  return overlap;
}

export function loadMatchingContext(termId) {
  const profiles = loadParticipantProfiles(termId);
  const availabilityMap = loadAvailabilityMap(termId);
  const rankings = loadRankingsMap(termId);
  const rankingIndex = buildRankingIndex(rankings);
  const profileByUserId = new Map(profiles.map((item) => [item.userId, item]));
  const allocation = loadClassAllocationContext(termId);
  return {
    profiles,
    profileByUserId,
    availabilityMap,
    rankings,
    rankingIndex,
    allocation
  };
}

export function computeCompatibilityScore(studentUserId, teacherUserId, context) {
  const overlap = computeOverlapCount(studentUserId, teacherUserId, context.availabilityMap);
  const studentRank = context.rankingIndex.get(studentUserId)?.get(teacherUserId) || null;
  const teacherRank = context.rankingIndex.get(teacherUserId)?.get(studentUserId) || null;
  const studentScore = studentRank ? Math.max(0, 48 - (studentRank - 1) * 6) : 0;
  const teacherScore = teacherRank ? Math.max(0, 32 - (teacherRank - 1) * 4) : 0;
  const overlapScore = Math.min(overlap, 12) * 4;
  return overlapScore + studentScore + teacherScore;
}

export function buildLockedPairs(context, fixedMatchesByStudent = new Map(), fixedCountsByTeacher = new Map()) {
  const lockedPairs = [];
  const usedStudents = new Set(fixedMatchesByStudent.keys());
  const usedTeachers = new Map(fixedCountsByTeacher);

  const students = context.profiles.filter((item) => item.participantType === 'student' && item.matchingMode === 'direct');
  for (const student of students) {
    if (usedStudents.has(student.userId) || !student.directTargetUserId) {
      continue;
    }
    const teacher = context.profileByUserId.get(student.directTargetUserId);
    if (!teacher) {
      continue;
    }
    if (teacher.participantType !== 'teacher' || teacher.matchingMode !== 'direct') {
      continue;
    }
    if (teacher.directTargetUserId !== student.userId) {
      continue;
    }
    if (teacher.qualificationStatus !== 'approved') {
      continue;
    }
    if (!hasSharedAvailability(student.userId, teacher.userId, context.allocation)) {
      continue;
    }
    const currentCount = usedTeachers.get(teacher.userId) || 0;
    if (currentCount >= clampCapacity(teacher.capacity)) {
      continue;
    }
    lockedPairs.push({
      studentUserId: student.userId,
      teacherUserId: teacher.userId,
      matchType: 'locked',
      matchingScore: computeCompatibilityScore(student.userId, teacher.userId, context),
      status: 'matched',
      notes: 'Direct mutual agreement',
      adminComment: null
    });
    usedStudents.add(student.userId);
    usedTeachers.set(teacher.userId, currentCount + 1);
  }

  return {
    lockedPairs,
    usedStudents,
    teacherLoad: usedTeachers
  };
}

function buildOrderedCandidateList(ownerUserId, candidateIds, context) {
  const rankingRows = context.rankings.get(ownerUserId) || [];
  const rankedSet = new Set();
  const ordered = [];

  for (const row of rankingRows) {
    if (candidateIds.has(row.targetUserId) && !rankedSet.has(row.targetUserId)) {
      rankedSet.add(row.targetUserId);
      ordered.push(row.targetUserId);
    }
  }

  const remaining = [...candidateIds].filter((id) => !rankedSet.has(id));
  remaining.sort((left, right) => {
    const scoreDiff = computeCompatibilityScore(ownerUserId, right, context) - computeCompatibilityScore(ownerUserId, left, context);
    if (scoreDiff !== 0) {
      return scoreDiff;
    }
    const leftProfile = context.profileByUserId.get(left);
    const rightProfile = context.profileByUserId.get(right);
    return String(leftProfile?.studentNumber || left).localeCompare(String(rightProfile?.studentNumber || right));
  });

  return [...ordered, ...remaining];
}

function buildTeacherPreferenceIndex(teacherUserId, candidateStudentIds, context) {
  const ordered = buildOrderedCandidateList(teacherUserId, candidateStudentIds, context);
  const index = new Map();
  ordered.forEach((studentUserId, position) => {
    index.set(studentUserId, position + 1);
  });
  return index;
}

function buildAlgorithmCandidates(context, fixedMatchesByStudent, initialTeacherLoad) {
  const eligibleTeachers = context.profiles.filter(
    (item) => item.participantType === 'teacher' && item.matchingMode === 'ranking' && item.qualificationStatus === 'approved'
  );
  const eligibleTeacherIds = new Set(
    eligibleTeachers
      .filter((item) => (initialTeacherLoad.get(item.userId) || 0) < clampCapacity(item.capacity))
      .map((item) => item.userId)
  );
  const eligibleStudents = context.profiles.filter(
    (item) => item.participantType === 'student' && item.matchingMode === 'ranking' && !fixedMatchesByStudent.has(item.userId)
  );
  const studentIds = new Set(eligibleStudents.map((item) => item.userId));
  const studentPreferenceMap = new Map();
  const teacherPreferenceMap = new Map();

  for (const teacher of eligibleTeachers) {
    if (eligibleTeacherIds.has(teacher.userId)) {
      const feasibleStudentIds = new Set(
        [...studentIds].filter((studentUserId) =>
          hasSharedAvailability(studentUserId, teacher.userId, context.allocation))
      );
      teacherPreferenceMap.set(
        teacher.userId,
        buildTeacherPreferenceIndex(teacher.userId, feasibleStudentIds, context)
      );
    }
  }
  for (const student of eligibleStudents) {
    const feasibleTeacherIds = new Set(
      [...eligibleTeacherIds].filter((teacherUserId) =>
        hasSharedAvailability(student.userId, teacherUserId, context.allocation))
    );
    studentPreferenceMap.set(
      student.userId,
      buildOrderedCandidateList(student.userId, feasibleTeacherIds, context)
    );
  }

  return {
    eligibleTeachers,
    eligibleStudents,
    studentPreferenceMap,
    teacherPreferenceMap
  };
}

function isExistingMatchEligible(match, context) {
  const student = context.profileByUserId.get(Number(match.studentUserId));
  const teacher = context.profileByUserId.get(Number(match.teacherUserId));
  if (!student || student.participantType !== 'student') {
    return false;
  }
  if (!teacher || teacher.participantType !== 'teacher' || teacher.qualificationStatus !== 'approved') {
    return false;
  }
  if (!hasSharedAvailability(student.userId, teacher.userId, context.allocation)) {
    return false;
  }
  if (match.matchType === 'locked') {
    return student.matchingMode === 'direct'
      && teacher.matchingMode === 'direct'
      && Number(student.directTargetUserId) === Number(teacher.userId)
      && Number(teacher.directTargetUserId) === Number(student.userId);
  }
  if (match.matchType === 'algorithm') {
    return student.matchingMode === 'ranking' && teacher.matchingMode === 'ranking';
  }
  return match.matchType === 'manual' && teacher.matchingMode !== 'direct';
}

export function revalidateExistingMatches(termId, matches, providedContext = null) {
  const context = providedContext || loadMatchingContext(termId);
  const state = createAllocationState(context.allocation);
  const teacherLoad = new Map();
  const usedStudents = new Set();
  const validMatches = [];
  const droppedMatches = [];

  for (const match of matches) {
    const teacher = context.profileByUserId.get(Number(match.teacherUserId));
    const currentLoad = teacherLoad.get(Number(match.teacherUserId)) || 0;
    if (
      usedStudents.has(Number(match.studentUserId))
      || !isExistingMatchEligible(match, context)
      || currentLoad >= clampCapacity(teacher?.capacity)
    ) {
      droppedMatches.push(match);
      continue;
    }
    const reserved = reserveMatchRoom(match, context.allocation, state, match.roomSlotId);
    if (!reserved) {
      droppedMatches.push(match);
      continue;
    }
    validMatches.push(reserved);
    usedStudents.add(Number(match.studentUserId));
    teacherLoad.set(Number(match.teacherUserId), currentLoad + 1);
  }

  return { context, validMatches, droppedMatches };
}

export function runStableMatching(termId, fixedMatches, providedContext = null) {
  const context = providedContext || loadMatchingContext(termId);
  const fixedMatchesByStudent = new Map(fixedMatches.map((item) => [item.studentUserId, item]));
  const initialTeacherLoad = new Map();
  for (const match of fixedMatches) {
    initialTeacherLoad.set(match.teacherUserId, (initialTeacherLoad.get(match.teacherUserId) || 0) + 1);
  }

  const { eligibleTeachers, eligibleStudents, studentPreferenceMap, teacherPreferenceMap } = buildAlgorithmCandidates(
    context,
    fixedMatchesByStudent,
    initialTeacherLoad
  );
  const allocationState = createAllocationState(context.allocation);
  for (const match of fixedMatches) {
    if (!reserveMatchRoom(match, context.allocation, allocationState, match.roomSlotId)) {
      throw new HttpError(409, 'A preserved Class Matching assignment no longer has a conflict-free room and time');
    }
  }

  const teacherState = new Map();
  const teacherCapacityMap = new Map();
  for (const teacher of eligibleTeachers) {
    teacherState.set(teacher.userId, []);
    teacherCapacityMap.set(teacher.userId, Math.max(0, clampCapacity(teacher.capacity) - (initialTeacherLoad.get(teacher.userId) || 0)));
  }

  const studentProposalIndex = new Map();
  const unmatchedStudents = eligibleStudents.map((item) => item.userId);

  while (unmatchedStudents.length > 0) {
    const studentUserId = unmatchedStudents.shift();
    const preferences = studentPreferenceMap.get(studentUserId) || [];

    while ((studentProposalIndex.get(studentUserId) || 0) < preferences.length) {
      const nextIndex = studentProposalIndex.get(studentUserId) || 0;
      const teacherUserId = preferences[nextIndex];
      studentProposalIndex.set(studentUserId, nextIndex + 1);

      const remainingCapacity = teacherCapacityMap.get(teacherUserId) || 0;
      if (remainingCapacity <= 0) {
        continue;
      }

      const teacherMatches = teacherState.get(teacherUserId) || [];
      if (teacherMatches.length < remainingCapacity) {
        const reserved = reserveMatchRoom(
          { studentUserId, teacherUserId },
          context.allocation,
          allocationState
        );
        if (reserved) {
          teacherMatches.push(studentUserId);
          teacherState.set(teacherUserId, teacherMatches);
          break;
        }
        continue;
      }

      const preferenceIndex = teacherPreferenceMap.get(teacherUserId) || new Map();
      let worstStudentUserId = null;
      let worstRank = -1;
      for (const candidateStudentId of teacherMatches) {
        const rank = preferenceIndex.get(candidateStudentId) || Number.MAX_SAFE_INTEGER;
        if (rank > worstRank) {
          worstRank = rank;
          worstStudentUserId = candidateStudentId;
        }
      }

      const incomingRank = preferenceIndex.get(studentUserId) || Number.MAX_SAFE_INTEGER;
      if (incomingRank < worstRank && worstStudentUserId !== null) {
        const previousReservation = releaseMatchRoom(worstStudentUserId, allocationState);
        const incomingReservation = reserveMatchRoom(
          { studentUserId, teacherUserId },
          context.allocation,
          allocationState
        );
        if (incomingReservation) {
          const replaceIndex = teacherMatches.indexOf(worstStudentUserId);
          teacherMatches.splice(replaceIndex, 1, studentUserId);
          teacherState.set(teacherUserId, teacherMatches);
          if ((studentProposalIndex.get(worstStudentUserId) || 0) < (studentPreferenceMap.get(worstStudentUserId) || []).length) {
            unmatchedStudents.push(worstStudentUserId);
          }
          break;
        }
        if (previousReservation) {
          reserveMatchRoom(
            { studentUserId: worstStudentUserId, teacherUserId },
            context.allocation,
            allocationState,
            previousReservation.roomSlotId
          );
        }
      }
    }
  }

  const matches = [];
  for (const [teacherUserId, studentIds] of teacherState.entries()) {
    for (const studentUserId of studentIds) {
      const roomSlotId = allocationState.reservationsByStudent.get(Number(studentUserId))?.roomSlotId;
      if (!roomSlotId) {
        continue;
      }
      matches.push({
        studentUserId,
        teacherUserId,
        matchType: 'algorithm',
        matchingScore: computeCompatibilityScore(studentUserId, teacherUserId, context),
        status: 'matched',
        notes: null,
        adminComment: null,
        roomSlotId
      });
    }
  }
  return matches.sort((left, right) => left.studentUserId - right.studentUserId);
}

export function ensureTeacherCapacity(termId, matches, teacherUserId) {
  const profile = loadParticipantProfile(termId, teacherUserId);
  if (!profile || profile.participantType !== 'teacher') {
    throw new HttpError(404, 'Teacher profile not found in this term');
  }
  if (profile.qualificationStatus !== 'approved') {
    throw new HttpError(400, 'Teacher must be approved before matching');
  }
  const capacity = clampCapacity(profile.capacity);
  const count = matches.filter((item) => item.teacherUserId === teacherUserId).length;
  if (count > capacity) {
    throw new HttpError(409, 'Teacher capacity would be exceeded');
  }
}
