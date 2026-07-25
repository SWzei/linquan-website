import HttpError from '../../utils/httpError.js';
import db from '../../config/db.js';
import { buildPianoOccupancy, loadRoomSlots, roomTimeKey } from '../roomInventory.js';
import { getTerm, loadAvailabilityMap } from './common.js';

function cloneBusyCounts(participantBusyTimes) {
  const counts = new Map();
  for (const [userId, timeKeys] of participantBusyTimes.entries()) {
    counts.set(Number(userId), new Map([...timeKeys].map((key) => [key, 1])));
  }
  return counts;
}

function changeBusyCount(state, userId, timeKey, delta) {
  const numericUserId = Number(userId);
  if (!state.participantBusyCounts.has(numericUserId)) {
    state.participantBusyCounts.set(numericUserId, new Map());
  }
  const userCounts = state.participantBusyCounts.get(numericUserId);
  const next = Number(userCounts.get(timeKey) || 0) + delta;
  if (next <= 0) {
    userCounts.delete(timeKey);
  } else {
    userCounts.set(timeKey, next);
  }
}

function isParticipantBusy(state, userId, timeKey) {
  return Number(state.participantBusyCounts.get(Number(userId))?.get(timeKey) || 0) > 0;
}

export function loadClassAllocationContext(termId) {
  const term = getTerm(termId);
  if (!term.semesterId) {
    throw new HttpError(
      409,
      'This legacy Class Matching term is not linked to a Piano Time semester. Link it before generating matches.'
    );
  }
  const roomSlots = loadRoomSlots(term.semesterId);
  if (roomSlots.length === 0) {
    throw new HttpError(409, 'The linked semester has no piano-room inventory');
  }
  const roomsByTime = new Map();
  const roomById = new Map();
  for (const room of roomSlots) {
    const key = roomTimeKey(room.dayOfWeek, room.hour);
    if (!roomsByTime.has(key)) {
      roomsByTime.set(key, []);
    }
    roomsByTime.get(key).push(room);
    roomById.set(Number(room.id), room);
  }

  const availabilitySlotMap = loadAvailabilityMap(termId);
  const availabilityTimeMap = new Map();
  const classSlotRows = db
    .prepare(
      `SELECT id, day_of_week AS "dayOfWeek", hour
       FROM class_matching_slots WHERE term_id = ?`
    )
    .all(termId);
  const timeByClassSlotId = new Map(
    classSlotRows.map((slot) => [Number(slot.id), roomTimeKey(slot.dayOfWeek, slot.hour)])
  );
  for (const [userId, slotIds] of availabilitySlotMap.entries()) {
    const times = new Set();
    for (const slotId of slotIds) {
      const key = timeByClassSlotId.get(Number(slotId));
      if (key && roomsByTime.has(key)) {
        times.add(key);
      }
    }
    availabilityTimeMap.set(Number(userId), times);
  }

  return {
    term,
    roomSlots,
    roomById,
    roomsByTime,
    availabilitySlotMap,
    availabilityTimeMap,
    pianoOccupancy: buildPianoOccupancy(term.semesterId)
  };
}

export function createAllocationState(context) {
  return {
    occupiedRoomSlotIds: new Set(context.pianoOccupancy.occupiedRoomSlotIds),
    participantBusyCounts: cloneBusyCounts(context.pianoOccupancy.participantBusyTimes),
    reservationsByStudent: new Map()
  };
}

export function sharedAvailabilityTimes(studentUserId, teacherUserId, context) {
  const studentTimes = context.availabilityTimeMap.get(Number(studentUserId)) || new Set();
  const teacherTimes = context.availabilityTimeMap.get(Number(teacherUserId)) || new Set();
  return [...studentTimes].filter((key) => teacherTimes.has(key)).sort();
}

export function hasSharedAvailability(studentUserId, teacherUserId, context) {
  return sharedAvailabilityTimes(studentUserId, teacherUserId, context).length > 0;
}

export function reserveMatchRoom(match, context, state, preferredRoomSlotId = null) {
  const sharedTimes = new Set(sharedAvailabilityTimes(match.studentUserId, match.teacherUserId, context));
  if (sharedTimes.size === 0) {
    return null;
  }

  const candidates = [];
  const preferred = preferredRoomSlotId ? context.roomById.get(Number(preferredRoomSlotId)) : null;
  if (preferred) {
    candidates.push(preferred);
  }
  for (const room of context.roomSlots) {
    if (!preferred || Number(room.id) !== Number(preferred.id)) {
      candidates.push(room);
    }
  }

  const room = candidates.find((item) => {
    const key = roomTimeKey(item.dayOfWeek, item.hour);
    return sharedTimes.has(key)
      && !state.occupiedRoomSlotIds.has(Number(item.id))
      && !isParticipantBusy(state, match.studentUserId, key)
      && !isParticipantBusy(state, match.teacherUserId, key);
  });
  if (!room) {
    return null;
  }

  const timeKey = roomTimeKey(room.dayOfWeek, room.hour);
  state.occupiedRoomSlotIds.add(Number(room.id));
  changeBusyCount(state, match.studentUserId, timeKey, 1);
  changeBusyCount(state, match.teacherUserId, timeKey, 1);
  state.reservationsByStudent.set(Number(match.studentUserId), {
    roomSlotId: Number(room.id),
    teacherUserId: Number(match.teacherUserId),
    timeKey
  });
  return {
    ...match,
    roomSlotId: Number(room.id)
  };
}

export function releaseMatchRoom(studentUserId, state) {
  const reservation = state.reservationsByStudent.get(Number(studentUserId));
  if (!reservation) {
    return null;
  }
  state.occupiedRoomSlotIds.delete(reservation.roomSlotId);
  changeBusyCount(state, studentUserId, reservation.timeKey, -1);
  changeBusyCount(state, reservation.teacherUserId, reservation.timeKey, -1);
  state.reservationsByStudent.delete(Number(studentUserId));
  return reservation;
}
