import { directTargets, clampCapacity } from './common.js';
import { loadMatchingContext } from './algorithm.js';
import { createAllocationState, sharedAvailabilityTimes } from './allocation.js';
import { roomTimeKey } from '../roomInventory.js';

export function diagnoseUnmatched(termId, profiles, matches) {
  const unmatched = profiles.filter(p => p.participantType === 'student' && !matches.some(m => Number(m.studentUserId) === Number(p.userId)));
  if (!unmatched.length) return [];
  let context;
  try { context = loadMatchingContext(termId); }
  catch (err) {
    if (err.status !== 409) throw err;
    return unmatched.map(p => ({ userId: p.userId, displayName: p.displayName, reasons: ['inventoryMissing'] }));
  }
  const state = createAllocationState(context.allocation);
  for (const match of matches) {
    const room = context.allocation.roomById.get(Number(match.roomSlotId));
    if (!room) continue;
    state.occupiedRoomSlotIds.add(Number(room.id));
    for (const id of [match.studentUserId, match.teacherUserId]) {
      if (!state.participantBusyCounts.has(Number(id))) state.participantBusyCounts.set(Number(id), new Map());
      state.participantBusyCounts.get(Number(id)).set(roomTimeKey(room.dayOfWeek, room.hour), 1);
    }
  }
  return unmatched.map(student => {
    const reasons = new Set();
    const teachers = profiles.filter(t => t.participantType === 'teacher' && t.qualificationStatus === 'approved' && t.matchingMode === student.matchingMode && (student.matchingMode !== 'direct' || (directTargets(student).includes(Number(t.userId)) && directTargets(t).includes(Number(student.userId)))));
    if (!teachers.length) reasons.add(student.matchingMode === 'direct' ? 'mutualMissing' : 'teacherMissing');
    for (const teacher of teachers) {
      if (matches.filter(m => Number(m.teacherUserId) === Number(teacher.userId)).length >= clampCapacity(teacher.capacity)) { reasons.add('capacityFull'); continue; }
      const times = sharedAvailabilityTimes(student.userId, teacher.userId, context.allocation);
      if (!times.length) { reasons.add('noSharedTime'); continue; }
      const freeTimes = times.filter(key => !state.participantBusyCounts.get(Number(student.userId))?.has(key) && !state.participantBusyCounts.get(Number(teacher.userId))?.has(key));
      if (!freeTimes.length) { reasons.add('participantBusy'); continue; }
      const freeRoom = freeTimes.some(key => context.allocation.roomsByTime.get(key).some(room => !state.occupiedRoomSlotIds.has(Number(room.id))));
      reasons.add(freeRoom ? 'regenerate' : 'roomsFull');
    }
    return { userId: student.userId, displayName: student.displayName, reasons: [...reasons] };
  });
}
