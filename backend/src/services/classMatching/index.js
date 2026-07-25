import db from '../../config/db.js';
import HttpError from '../../utils/httpError.js';
import { currentUtcIsoString } from '../../utils/dateTime.js';
import {
  buildCandidateLists,
  clampCapacity,
  createTerm,
  getTerm,
  listTerms,
  loadBaseProfile,
  loadParticipantProfile,
  loadParticipantProfiles,
  loadAvailabilityIds,
  loadTermSlots,
  loadRankingIds,
  saveAvailability,
  saveProfile,
  saveRankings,
  updateTerm
} from './common.js';
import {
  buildLockedPairs,
  computeCompatibilityScore,
  ensureTeacherCapacity,
  loadMatchingContext,
  revalidateExistingMatches,
  runStableMatching
} from './algorithm.js';
import {
  compareVersions,
  createVersionSnapshot,
  exportVersionCsv,
  getCurrentVersion,
  getVersion,
  listVersions,
  loadCurrentMatches,
  loadVersionMatches
} from './versions.js';
import { lockSemesterInventory } from '../roomInventory.js';

function withTermInventoryLock(termId, callback) {
  const tx = db.transaction(() => {
    const term = getTerm(termId);
    if (!term.semesterId) {
      throw new HttpError(409, 'Class Matching term is not linked to a Piano Time semester');
    }
    lockSemesterInventory(term.semesterId);
    return callback(term);
  });
  return tx();
}

function toSnapshotMatch(item) {
  return {
    studentUserId: item.studentUserId,
    teacherUserId: item.teacherUserId,
    roomSlotId: item.roomSlotId,
    matchType: item.matchType,
    matchingScore: Number(item.matchingScore || 0),
    status: item.status,
    notes: item.notes,
    adminComment: item.adminComment
  };
}

export function listClassMatchingTerms() {
  const items = listTerms();
  return {
    items,
    currentTermId: items.find((item) => item.isActive)?.id || null
  };
}

export function createClassMatchingTerm(payload) {
  return createTerm(payload);
}

export function getUserClassMatchingOverview({ termId, userId }) {
  const term = getTerm(termId);
  const participantProfile = loadParticipantProfile(termId, userId);
  const currentMatches = loadCurrentMatches(termId);
  const myMatches = currentMatches.matches.filter(
    (item) => item.studentUserId === userId || item.teacherUserId === userId
  );

  return {
    term,
    baseProfile: loadBaseProfile(userId),
    participantProfile: participantProfile
      ? {
          ...participantProfile,
          capacity: participantProfile.participantType === 'teacher' ? clampCapacity(participantProfile.capacity) : null
        }
      : null,
    slots: loadTermSlots(termId, userId),
    availabilitySlotIds: loadAvailabilityIds(termId, userId),
    rankingTargetUserIds: loadRankingIds(termId, userId),
    candidates: buildCandidateLists(termId, userId),
    currentVersion: currentMatches.version,
    matches: myMatches
  };
}

export function saveUserClassMatchingProfile(payload) {
  return saveProfile(payload);
}

export function saveUserClassMatchingAvailability(payload) {
  return saveAvailability(payload);
}

export function saveUserClassMatchingRankings(payload) {
  return saveRankings(payload);
}

export function getAdminClassMatchingOverview(termId) {
  const term = getTerm(termId);
  const profiles = loadParticipantProfiles(termId);
  const versions = listVersions(termId);
  const { version: currentVersion, matches } = loadCurrentMatches(termId);
  return {
    term,
    profiles,
    qualificationQueue: profiles.filter((item) => item.participantType === 'teacher'),
    currentVersion,
    matches,
    versions,
    slots: loadTermSlots(termId),
    summary: {
      participantCount: profiles.length,
      studentCount: profiles.filter((item) => item.participantType === 'student').length,
      teacherCount: profiles.filter((item) => item.participantType === 'teacher').length,
      approvedTeacherCount: profiles.filter(
        (item) => item.participantType === 'teacher' && item.qualificationStatus === 'approved'
      ).length,
      matchedStudentCount: new Set(matches.map((item) => item.studentUserId)).size
    }
  };
}

export function updateClassMatchingTerm(payload) {
  const tx = db.transaction(() => {
    const current = getTerm(payload.termId);
    const semesterId = payload.semesterId ?? current.semesterId;
    if (semesterId) {
      lockSemesterInventory(semesterId);
    }
    const updated = updateTerm(payload);
    if (payload.activate === true) {
      const currentMatches = loadCurrentMatches(payload.termId).matches.map(toSnapshotMatch);
      if (currentMatches.length > 0) {
        const revalidated = revalidateExistingMatches(payload.termId, currentMatches);
        const changedRoom = revalidated.validMatches.some((item) => {
          const original = currentMatches.find(
            (candidate) => Number(candidate.studentUserId) === Number(item.studentUserId)
          );
          return Number(original?.roomSlotId || 0) !== Number(item.roomSlotId || 0);
        });
        if (revalidated.droppedMatches.length > 0 || changedRoom) {
          throw new HttpError(
            409,
            'This term conflicts with the current Piano Time plan. Regenerate Class Matching before activating it.'
          );
        }
      }
    }
    return updated;
  });
  return tx();
}

export function updateTeacherQualification({ termId, teacherUserId, status, feedback, adminId }) {
  const profile = loadParticipantProfile(termId, teacherUserId);
  if (!profile || profile.participantType !== 'teacher') {
    throw new HttpError(404, 'Teacher profile not found in this term');
  }
  if (!['pending', 'approved', 'rejected'].includes(status)) {
    throw new HttpError(400, 'Invalid qualification status');
  }
  const nowUtc = currentUtcIsoString();
  db.prepare(
    `UPDATE class_matching_profiles
     SET qualification_status = ?, qualification_feedback = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
     WHERE term_id = ? AND user_id = ?`
  ).run(status, feedback || null, adminId || null, nowUtc, nowUtc, termId, teacherUserId);

  return loadParticipantProfile(termId, teacherUserId);
}

export function generateClassMatchingVersion({ termId, adminId, changeSummary = 'Generated automatic matching draft' }) {
  return withTermInventoryLock(termId, () => {
    const context = loadMatchingContext(termId);
    const { lockedPairs } = buildLockedPairs(context);
    const { validMatches: scheduledLockedPairs } = revalidateExistingMatches(termId, lockedPairs, context);
    const algorithmMatches = runStableMatching(termId, scheduledLockedPairs, context);
    const version = createVersionSnapshot({
      termId,
      sourceType: 'algorithm',
      adminId,
      changeSummary,
      basedOnVersionId: null,
      matches: [...scheduledLockedPairs, ...algorithmMatches]
    });
    return {
      version,
      matches: loadVersionMatches(version.id)
    };
  });
}

export function incrementalClassMatching({ termId, adminId, changeSummary = 'Incremental matching update' }) {
  return withTermInventoryLock(termId, () => {
    const context = loadMatchingContext(termId);
    const current = loadCurrentMatches(termId);
    const currentCandidates = current.matches.map(toSnapshotMatch);
    const initialRevalidation = revalidateExistingMatches(termId, currentCandidates, context);
    const initiallyValid = initialRevalidation.validMatches;
    const fixedByStudent = new Map(initiallyValid.map((item) => [item.studentUserId, item]));
    const teacherLoad = new Map();
    for (const match of initiallyValid) {
      teacherLoad.set(match.teacherUserId, (teacherLoad.get(match.teacherUserId) || 0) + 1);
    }
    const { lockedPairs } = buildLockedPairs(context, fixedByStudent, teacherLoad);
    const orderedCandidates = [
      ...initiallyValid.filter((item) => item.matchType !== 'algorithm'),
      ...lockedPairs,
      ...initiallyValid.filter((item) => item.matchType === 'algorithm')
    ];
    const { validMatches: combinedFixed, droppedMatches } = revalidateExistingMatches(
      termId,
      orderedCandidates,
      context
    );
    const algorithmMatches = runStableMatching(termId, combinedFixed, context);
    const version = createVersionSnapshot({
      termId,
      sourceType: 'incremental',
      adminId,
      changeSummary,
      basedOnVersionId: current.version?.id || null,
      matches: [...combinedFixed, ...algorithmMatches]
    });
    return {
      version,
      matches: loadVersionMatches(version.id),
      revalidation: {
        preserved: combinedFixed.length,
        dropped: initialRevalidation.droppedMatches.length + droppedMatches.length
      }
    };
  });
}

export function manualAdjustClassMatching({
  termId,
  adminId,
  studentUserId,
  teacherUserId,
  notes,
  changeSummary = 'Manual class matching adjustment'
}) {
  return withTermInventoryLock(termId, () => {
    const context = loadMatchingContext(termId);
    const studentProfile = loadParticipantProfile(termId, studentUserId);
    if (!studentProfile || studentProfile.participantType !== 'student') {
      throw new HttpError(404, 'Student profile not found in this term');
    }

    const current = loadCurrentMatches(termId);
    const currentMatches = current.matches.map(toSnapshotMatch);

    const lockedCurrent = currentMatches.find(
      (item) => item.studentUserId === studentUserId && item.matchType === 'locked'
    );
    if (lockedCurrent && !teacherUserId) {
      throw new HttpError(
        409,
        'Locked direct matches cannot be cleared manually. Reassign to another teacher, or change the direct mutual selection first.'
      );
    }

    const nextCandidates = currentMatches.filter((item) => item.studentUserId !== studentUserId);
    if (teacherUserId) {
      const teacherProfile = loadParticipantProfile(termId, teacherUserId);
      if (!teacherProfile || teacherProfile.participantType !== 'teacher') {
        throw new HttpError(404, 'Teacher profile not found in this term');
      }
      if (teacherProfile.qualificationStatus !== 'approved') {
        throw new HttpError(400, 'Teacher must be approved before matching');
      }
      if (teacherProfile.matchingMode === 'direct') {
        throw new HttpError(409, 'Direct-only teachers cannot receive manual non-locked assignments');
      }
      const manualCandidate = {
        studentUserId,
        teacherUserId,
        matchType: 'manual',
        matchingScore: computeCompatibilityScore(studentUserId, teacherUserId, context),
        status: 'matched',
        notes: notes || null,
        adminComment: changeSummary || null
      };
      ensureTeacherCapacity(termId, [...nextCandidates, manualCandidate], teacherUserId);
      nextCandidates.push(manualCandidate);
    }

    const { validMatches: nextMatches } = revalidateExistingMatches(termId, nextCandidates, context);
    if (teacherUserId && !nextMatches.some((item) => Number(item.studentUserId) === Number(studentUserId))) {
      throw new HttpError(409, 'No shared conflict-free piano room and time is available for this manual match');
    }
    const version = createVersionSnapshot({
      termId,
      sourceType: 'manual',
      adminId,
      changeSummary,
      basedOnVersionId: current.version?.id || null,
      matches: nextMatches
    });
    return {
      version,
      matches: loadVersionMatches(version.id)
    };
  });
}

export function compareClassMatchingVersions(payload) {
  return compareVersions(payload.termId, payload.fromVersionId, payload.toVersionId);
}

export function restoreClassMatchingVersion(payload) {
  return withTermInventoryLock(payload.termId, () => {
    const sourceVersion = getVersion(payload.termId, payload.versionId);
    const sourceMatches = loadVersionMatches(payload.versionId).map(toSnapshotMatch);
    const { validMatches, droppedMatches } = revalidateExistingMatches(payload.termId, sourceMatches);
    const version = createVersionSnapshot({
      termId: payload.termId,
      sourceType: 'restore',
      adminId: payload.adminId,
      changeSummary: payload.changeSummary || `Restored from version ${sourceVersion.versionNumber}`,
      basedOnVersionId: payload.versionId,
      matches: validMatches
    });
    return {
      version,
      matches: loadVersionMatches(version.id),
      revalidation: {
        preserved: validMatches.length,
        dropped: droppedMatches.length
      }
    };
  });
}

export function exportClassMatchingCsv(payload) {
  return exportVersionCsv(payload.termId, payload.versionId);
}

export function getClassMatchingVersionDetail({ termId, versionId }) {
  return {
    version: getVersion(termId, versionId),
    matches: loadVersionMatches(versionId)
  };
}
