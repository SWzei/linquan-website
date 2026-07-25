import db from '../config/db.js';
import HttpError from '../utils/httpError.js';
import { buildClassOccupancy, lockSemesterInventory, roomTimeKey } from './roomInventory.js';

function buildMemberPreferenceMap(members, preferences, validSlotIds) {
  const map = new Map();
  for (const member of members) {
    map.set(member.user_id, new Set());
  }

  for (const pref of preferences) {
    if (map.has(pref.user_id) && validSlotIds.has(pref.slot_id)) {
      map.get(pref.user_id).add(pref.slot_id);
    }
  }

  return map;
}

function chooseLowestDemandSlot(candidates, slotDemand) {
  return [...candidates].sort((a, b) => {
    const demandDiff = (slotDemand.get(a) || 0) - (slotDemand.get(b) || 0);
    if (demandDiff !== 0) {
      return demandDiff;
    }
    return a - b;
  })[0];
}

function chooseSecondSlot(candidates, slotDemand, slotMeta, existingAssignments) {
  return [...candidates].sort((a, b) => {
    const scoreA = scoreSecondAssignment(a, slotDemand, slotMeta, existingAssignments);
    const scoreB = scoreSecondAssignment(b, slotDemand, slotMeta, existingAssignments);
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    return a - b;
  })[0];
}

function scoreSecondAssignment(slotId, slotDemand, slotMeta, existingAssignments) {
  const demandWeight = (slotDemand.get(slotId) || 0) * 10;
  const slot = slotMeta.get(slotId);
  if (!slot || existingAssignments.length === 0) {
    return demandWeight;
  }

  // Encourage hour continuity for a member to keep weekly plans practical.
  let adjacencyBonus = 0;
  for (const assignedSlotId of existingAssignments) {
    const assigned = slotMeta.get(assignedSlotId);
    if (!assigned) {
      continue;
    }
    if (assigned.day_of_week === slot.day_of_week) {
      const hourDistance = Math.abs(assigned.hour - slot.hour);
      if (hourDistance === 1) {
        adjacencyBonus = Math.max(adjacencyBonus, 6);
      } else if (hourDistance === 2) {
        adjacencyBonus = Math.max(adjacencyBonus, 2);
      }
    }
  }

  return demandWeight + adjacencyBonus;
}

function loadScheduleContext(semesterId) {
  const slotRows = db
    .prepare(
      'SELECT id, room_no, day_of_week, hour FROM room_slots WHERE semester_id = ? ORDER BY day_of_week, hour, room_no'
    )
    .all(semesterId);
  if (slotRows.length === 0) {
    throw new HttpError(400, 'No room slots configured for this semester');
  }

  const members = db
    .prepare(
      `SELECT DISTINCT u.id AS user_id
       FROM users u
       JOIN slot_preferences sp ON sp.user_id = u.id
       WHERE sp.semester_id = ? AND u.account_type = 'member' AND u.is_active = 1
       ORDER BY u.id`
    )
    .all(semesterId);
  if (members.length === 0) {
    throw new HttpError(400, 'No member preferences found for this semester');
  }

  const preferences = db
    .prepare(
      `SELECT sp.user_id, sp.slot_id
       FROM slot_preferences sp
       JOIN users u ON u.id = sp.user_id
       WHERE sp.semester_id = ? AND u.account_type = 'member' AND u.is_active = 1`
    )
    .all(semesterId);
  const userSettingsRows = db
    .prepare(
      `SELECT user_id, class_matching_priority
       FROM schedule_user_settings
       WHERE semester_id = ?`
    )
    .all(semesterId);

  const validSlotIds = new Set(slotRows.map((slot) => slot.id));
  const slotMeta = new Map(slotRows.map((slot) => [slot.id, slot]));
  const classMatchingPriorityUsers = new Set(
    userSettingsRows
      .filter((row) => Number(row.class_matching_priority) === 1)
      .map((row) => row.user_id)
  );
  const slotDemand = new Map();
  for (const pref of preferences) {
    if (validSlotIds.has(pref.slot_id)) {
      slotDemand.set(pref.slot_id, (slotDemand.get(pref.slot_id) || 0) + 1);
    }
  }

  const memberPrefs = buildMemberPreferenceMap(members, preferences, validSlotIds);

  return {
    slotRows,
    members,
    memberPrefs,
    slotMeta,
    slotDemand,
    classMatchingPriorityUsers
  };
}

function createAssignmentMap(members) {
  return new Map(members.map((member) => [member.user_id, []]));
}

function hasParticipantTimeConflict(userId, slotId, assignmentsByUser, slotMeta, participantBusyTimes) {
  const slot = slotMeta.get(slotId);
  if (!slot) {
    return true;
  }
  const key = roomTimeKey(slot.day_of_week, slot.hour);
  if (participantBusyTimes.get(userId)?.has(key)) {
    return true;
  }
  return (assignmentsByUser.get(userId) || []).some((assignedSlotId) => {
    const assigned = slotMeta.get(assignedSlotId);
    return assigned && roomTimeKey(assigned.day_of_week, assigned.hour) === key;
  });
}

function runPhaseOne({
  members,
  memberPrefs,
  availableSlots,
  slotDemand,
  assignmentsByUser,
  classMatchingPriorityUsers,
  slotMeta,
  participantBusyTimes
}) {
  const phase1Members = [...members].sort((a, b) => {
    const priorityDiff =
      Number(classMatchingPriorityUsers.has(b.user_id)) - Number(classMatchingPriorityUsers.has(a.user_id));
    if (priorityDiff !== 0) {
      return priorityDiff;
    }
    const prefDiff = memberPrefs.get(a.user_id).size - memberPrefs.get(b.user_id).size;
    if (prefDiff !== 0) {
      return prefDiff;
    }
    return a.user_id - b.user_id;
  });

  for (const member of phase1Members) {
    const assigned = assignmentsByUser.get(member.user_id) || [];
    if (assigned.length >= 1) {
      continue;
    }
    const preferred = memberPrefs.get(member.user_id);
    const candidates = [...preferred].filter(
      (slotId) => availableSlots.has(slotId)
        && !hasParticipantTimeConflict(member.user_id, slotId, assignmentsByUser, slotMeta, participantBusyTimes)
    );
    if (candidates.length === 0) {
      continue;
    }
    const chosenSlotId = chooseLowestDemandSlot(candidates, slotDemand);
    assigned.push(chosenSlotId);
    availableSlots.delete(chosenSlotId);
  }
}

function runPhaseTwo({ members, memberPrefs, availableSlots, slotDemand, slotMeta, assignmentsByUser, participantBusyTimes }) {
  const phase2Members = [...members].sort((a, b) => {
    const assignedA = assignmentsByUser.get(a.user_id) || [];
    const assignedB = assignmentsByUser.get(b.user_id) || [];

    const remainingA = [...memberPrefs.get(a.user_id)].filter(
      (slotId) => availableSlots.has(slotId)
        && !assignedA.includes(slotId)
        && !hasParticipantTimeConflict(a.user_id, slotId, assignmentsByUser, slotMeta, participantBusyTimes)
    ).length;
    const remainingB = [...memberPrefs.get(b.user_id)].filter(
      (slotId) => availableSlots.has(slotId)
        && !assignedB.includes(slotId)
        && !hasParticipantTimeConflict(b.user_id, slotId, assignmentsByUser, slotMeta, participantBusyTimes)
    ).length;
    if (remainingA !== remainingB) {
      return remainingA - remainingB;
    }
    return a.user_id - b.user_id;
  });

  for (const member of phase2Members) {
    const assigned = assignmentsByUser.get(member.user_id) || [];
    if (assigned.length === 0 || assigned.length >= 2) {
      continue;
    }

    const preferred = memberPrefs.get(member.user_id);
    const candidates = [...preferred].filter(
      (slotId) => availableSlots.has(slotId)
        && !assigned.includes(slotId)
        && !hasParticipantTimeConflict(member.user_id, slotId, assignmentsByUser, slotMeta, participantBusyTimes)
    );
    if (candidates.length === 0) {
      continue;
    }

    const chosenSlotId = chooseSecondSlot(candidates, slotDemand, slotMeta, assigned);
    assigned.push(chosenSlotId);
    availableSlots.delete(chosenSlotId);
  }
}

function flattenAssignments(assignmentsByUser) {
  const rows = [];
  for (const [userId, slots] of assignmentsByUser.entries()) {
    for (const slotId of slots) {
      rows.push({ userId, slotId });
    }
  }
  return rows;
}

function summarizeAssignments({ assignmentsByUser, totalMembers, totalSlots }) {
  const membersWithAtLeastOne = [...assignmentsByUser.values()].filter((slots) => slots.length >= 1).length;
  const membersWithTwo = [...assignmentsByUser.values()].filter((slots) => slots.length >= 2).length;
  const totalAssignments = [...assignmentsByUser.values()].reduce((sum, slots) => sum + slots.length, 0);
  return {
    totalMembers,
    membersWithAtLeastOne,
    membersWithTwo,
    unassignedMembers: totalMembers - membersWithAtLeastOne,
    totalAssignments,
    totalSlots,
    utilization: totalSlots > 0 ? totalAssignments / totalSlots : 0
  };
}

export function generateProposedSchedule({ semesterId, adminId }) {
  const tx = db.transaction(() => {
    lockSemesterInventory(semesterId);
    const context = loadScheduleContext(semesterId);
    const { slotRows, members, memberPrefs, slotMeta, slotDemand, classMatchingPriorityUsers } = context;
    const classOccupancy = buildClassOccupancy(semesterId);
    const assignmentsByUser = createAssignmentMap(members);
    const availableSlots = new Set(
      slotRows.map((slot) => slot.id).filter((slotId) => !classOccupancy.occupiedRoomSlotIds.has(slotId))
    );

    runPhaseOne({
      members,
      memberPrefs,
      availableSlots,
      slotDemand,
      assignmentsByUser,
      classMatchingPriorityUsers,
      slotMeta,
      participantBusyTimes: classOccupancy.participantBusyTimes
    });
    runPhaseTwo({
      members,
      memberPrefs,
      availableSlots,
      slotDemand,
      slotMeta,
      assignmentsByUser,
      participantBusyTimes: classOccupancy.participantBusyTimes
    });

    const flatAssignments = flattenAssignments(assignmentsByUser);
    const oldProposedBatches = db
      .prepare('SELECT id FROM schedule_batches WHERE semester_id = ? AND status = ?')
      .all(semesterId, 'proposed');

    for (const batch of oldProposedBatches) {
      db.prepare('DELETE FROM schedule_assignments WHERE batch_id = ?').run(batch.id);
      db.prepare('DELETE FROM schedule_batches WHERE id = ?').run(batch.id);
    }

    const batchResult = db
      .prepare(
        `INSERT INTO schedule_batches (semester_id, status, created_by, note)
         VALUES (?, 'proposed', ?, ?)`
      )
      .run(
        semesterId,
        adminId || null,
        'Auto-generated by fairness-first scheduler'
      );
    const batchId = Number(batchResult.lastInsertRowid);

    const insertAssignment = db.prepare(
      `INSERT INTO schedule_assignments (batch_id, semester_id, user_id, slot_id, status)
       VALUES (?, ?, ?, ?, 'proposed')`
    );
    for (const assignment of flatAssignments) {
      insertAssignment.run(batchId, semesterId, assignment.userId, assignment.slotId);
    }

    return {
      batchId,
      stats: summarizeAssignments({
        assignmentsByUser,
        totalMembers: members.length,
        totalSlots: slotRows.length
      }),
      blockedByClassMatching: classOccupancy.occupiedRoomSlotIds.size
    };
  });
  return tx();
}

export function updateProposedSchedule({ semesterId, adminId }) {
  const tx = db.transaction(() => {
    lockSemesterInventory(semesterId);
    const context = loadScheduleContext(semesterId);
    const { slotRows, members, memberPrefs, slotMeta, slotDemand, classMatchingPriorityUsers } = context;
    const classOccupancy = buildClassOccupancy(semesterId);
    const latestProposedBatch = db
      .prepare(
        `SELECT id
         FROM schedule_batches
         WHERE semester_id = ? AND status = 'proposed'
         ORDER BY created_at DESC, id DESC
         LIMIT 1`
      )
      .get(semesterId);

    if (!latestProposedBatch) {
      return null;
    }

    const batchId = latestProposedBatch.id;
    const existingAssignmentRows = db
      .prepare(
        `SELECT id, user_id, slot_id
         FROM schedule_assignments
         WHERE batch_id = ?
         ORDER BY id ASC`
      )
      .all(batchId);

    const assignmentsByUser = createAssignmentMap(members);
    const occupiedSlotIds = new Set(classOccupancy.occupiedRoomSlotIds);
    const validRows = [];
    const staleRowIds = [];
    for (const row of existingAssignmentRows) {
      const memberAssignments = assignmentsByUser.get(row.user_id);
      const valid = memberAssignments
        && memberAssignments.length < 2
        && memberPrefs.get(row.user_id)?.has(row.slot_id)
        && slotMeta.has(row.slot_id)
        && !occupiedSlotIds.has(row.slot_id)
        && !hasParticipantTimeConflict(
          row.user_id,
          row.slot_id,
          assignmentsByUser,
          slotMeta,
          classOccupancy.participantBusyTimes
        );
      if (!valid) {
        staleRowIds.push(row.id);
        continue;
      }
      memberAssignments.push(row.slot_id);
      occupiedSlotIds.add(row.slot_id);
      validRows.push(row);
    }

    for (const assignmentId of staleRowIds) {
      db.prepare('DELETE FROM schedule_assignments WHERE id = ?').run(assignmentId);
    }

    const availableSlots = new Set(
      slotRows.map((slot) => slot.id).filter((slotId) => !occupiedSlotIds.has(slotId))
    );
    const beforeSet = new Set(validRows.map((item) => `${item.user_id}-${item.slot_id}`));

    runPhaseOne({
      members,
      memberPrefs,
      availableSlots,
      slotDemand,
      assignmentsByUser,
      classMatchingPriorityUsers,
      slotMeta,
      participantBusyTimes: classOccupancy.participantBusyTimes
    });
    runPhaseTwo({
      members,
      memberPrefs,
      availableSlots,
      slotDemand,
      slotMeta,
      assignmentsByUser,
      participantBusyTimes: classOccupancy.participantBusyTimes
    });

    const afterRows = flattenAssignments(assignmentsByUser).map((item) => ({
      user_id: item.userId,
      slot_id: item.slotId
    }));
    const addedRows = afterRows.filter((item) => !beforeSet.has(`${item.user_id}-${item.slot_id}`));
    const insertAssignment = db.prepare(
      `INSERT INTO schedule_assignments (batch_id, semester_id, user_id, slot_id, status)
       VALUES (?, ?, ?, ?, 'proposed')`
    );
    for (const row of addedRows) {
      insertAssignment.run(batchId, semesterId, row.user_id, row.slot_id);
    }
    if (addedRows.length > 0 || staleRowIds.length > 0) {
      db.prepare(
        `UPDATE schedule_batches
         SET note = ?, created_by = COALESCE(created_by, ?)
         WHERE id = ?`
      ).run('Revalidated and updated by incremental fill', adminId || null, batchId);
    }

    return {
      batchId,
      createdNewDraft: false,
      addedAssignments: addedRows.length,
      removedStaleAssignments: staleRowIds.length,
      blockedByClassMatching: classOccupancy.occupiedRoomSlotIds.size,
      stats: summarizeAssignments({
        assignmentsByUser,
        totalMembers: members.length,
        totalSlots: slotRows.length
      })
    };
  });

  const result = tx();
  if (result) {
    return result;
  }
  return {
    ...generateProposedSchedule({ semesterId, adminId }),
    createdNewDraft: true,
    addedAssignments: 0,
    removedStaleAssignments: 0
  };
}

export function publishScheduleBatch({ batchId, adminId }) {
  const batch = db
    .prepare(
      'SELECT id, semester_id, status FROM schedule_batches WHERE id = ?'
    )
    .get(batchId);
  if (!batch) {
    throw new HttpError(404, 'Schedule batch not found');
  }
  if (batch.status !== 'proposed') {
    throw new HttpError(400, 'Only draft schedules can be published');
  }

  const tx = db.transaction(() => {
    lockSemesterInventory(batch.semester_id);
    db.prepare(
      `UPDATE schedule_batches
       SET status = 'published', published_by = ?, published_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(adminId || null, batchId);

    db.prepare(
      `UPDATE schedule_assignments
       SET status = 'published', updated_at = CURRENT_TIMESTAMP
       WHERE batch_id = ?`
    ).run(batchId);
  });
  tx();

  const assignmentUsers = db
    .prepare('SELECT DISTINCT user_id FROM schedule_assignments WHERE batch_id = ?')
    .all(batchId)
    .map((row) => row.user_id);

  return {
    semesterId: batch.semester_id,
    userIds: assignmentUsers
  };
}
