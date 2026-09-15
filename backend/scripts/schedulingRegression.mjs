import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'linquan-scheduling-'));
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DB_PATH = path.join(scratch, 'test.sqlite');
process.env.UPLOAD_ROOT = path.join(scratch, 'uploads');
const setup = new Database(process.env.DB_PATH);
setup.exec(fs.readFileSync(new URL('../../database/schema.sql', import.meta.url), 'utf8'));
setup.close();
const { default: db } = await import('../src/config/db.js');
const common = await import('../src/services/classMatching/common.js');
const matching = await import('../src/services/classMatching/index.js');
const { clearSchedule } = await import('../src/services/clearSchedule.js');
const { buildPianoOccupancy } = await import('../src/services/roomInventory.js');
const { signSessionToken } = await import('../src/utils/authTokens.js');
let sequence = 0;
function user(admin = false) {
  return Number(db.prepare('INSERT INTO users (student_number, password_hash, is_admin) VALUES (?, ?, ?)').run(`regression-${++sequence}`, 'unused', Number(admin)).lastInsertRowid);
}
const adminId = user(true);
const teacher = user();
const students = Array.from({ length: 13 }, () => user());
const semesterId = Number(db.prepare("INSERT INTO semesters (name, start_date, end_date, is_active) VALUES ('Regression', '2026-09-01', '2027-01-01', 1)").run().lastInsertRowid);
for (let hour = 8; hour <= 20; hour++) db.prepare('INSERT INTO room_slots (semester_id, room_no, day_of_week, hour) VALUES (?, 1, 1, ?)').run(semesterId, hour);
const roomSlots = db.prepare('SELECT id FROM room_slots WHERE semester_id = ? ORDER BY hour').all(semesterId).map(r => r.id);
const termId = common.createTerm({ semesterId, name: 'Regression term', startDate: '2026-09-01', endDate: '2027-01-01', activate: true }).id;
const slots = common.loadTermSlots(termId).map(s => s.id);
common.saveProfile({ termId, userId: teacher, input: { participantType: 'teacher', matchingMode: 'direct', capacity: 12 } });
matching.updateTeacherQualification({ termId, teacherUserId: teacher, status: 'approved', adminId });
for (const student of students) {
  common.saveProfile({ termId, userId: student, input: { participantType: 'student', matchingMode: 'direct', directTargetUserIds: [teacher] } });
  common.saveAvailability({ termId, userId: student, slotIds: slots });
}
common.saveAvailability({ termId, userId: teacher, slotIds: slots });
common.saveProfile({ termId, userId: teacher, input: { directTargetUserIds: students } });
assert.deepEqual(common.loadParticipantProfile(termId, teacher).directTargetUserIds, students);
let result = matching.generateClassMatchingVersion({ termId, adminId });
assert.equal(result.matches.length, 12, 'Teacher can mutually select and teach more than ten students');
assert.equal(new Set(result.matches.map(m => m.roomSlotId)).size, 12);
assert(matching.getAdminClassMatchingOverview(termId).unmatchedDiagnostics[0].reasons.includes('capacityFull'));
matching.updateTeacherQualification({ termId, teacherUserId: teacher, status: 'approved', adminId, capacity: 13 });
assert.equal(matching.incrementalClassMatching({ termId, adminId }).matches.length, 13);
assert.throws(() => common.saveProfile({ termId, userId: students[0], input: { directTargetUserIds: [teacher, adminId] } }), /Students may select one/);
assert.throws(() => common.saveProfile({ termId, userId: students[12], input: { matchingMode: 'ranking' } }), /another direct participant/);
common.saveProfile({ termId, userId: teacher, input: { directTargetUserIds: [] } });
assert.deepEqual(common.loadParticipantProfile(termId, teacher).directTargetUserIds, []);
assert.equal(matching.generateClassMatchingVersion({ termId, adminId }).matches.length, 0);
assert(matching.getAdminClassMatchingOverview(termId).unmatchedDiagnostics[0].reasons.includes('mutualMissing'));
// An old scalar direct selection remains readable.
db.prepare('UPDATE class_matching_profiles SET direct_target_user_id = ? WHERE term_id = ? AND user_id = ?').run(students[0], termId, teacher);
assert.deepEqual(common.loadParticipantProfile(termId, teacher).directTargetUserIds, [students[0]]);
common.saveProfile({ termId, userId: teacher, input: { directTargetUserIds: students } });
const occupant = user();
function batch(status, slotsToFill) {
  const id = Number(db.prepare('INSERT INTO schedule_batches (semester_id, status, created_by, published_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)').run(semesterId, status, adminId).lastInsertRowid);
  for (const slot of slotsToFill) db.prepare('INSERT INTO schedule_assignments (batch_id, semester_id, user_id, slot_id, status) VALUES (?, ?, ?, ?, ?)').run(id, semesterId, occupant, slot, status);
  return id;
}
const published = batch('published', roomSlots);
batch('proposed', roomSlots.slice(0, 1));
db.prepare('INSERT INTO slot_preferences (semester_id, user_id, slot_id) VALUES (?, ?, ?)').run(semesterId, occupant, roomSlots[0]);
assert.equal(matching.generateClassMatchingVersion({ termId, adminId }).matches.length, 0);
assert(matching.getAdminClassMatchingOverview(termId).unmatchedDiagnostics[0].reasons.includes('roomsFull'));
clearSchedule({ semesterId, scope: 'proposed', adminId });
assert.equal(buildPianoOccupancy(semesterId).occupiedRoomSlotIds.size, 13, 'Clearing draft does not withdraw published plan');
clearSchedule({ semesterId, scope: 'published', adminId });
assert.equal(buildPianoOccupancy(semesterId).occupiedRoomSlotIds.size, 0, 'Withdrawing published does not resurrect old plan');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schedule_assignments WHERE batch_id = ?').get(published).n, 13, 'Historical published plan retained');
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM slot_preferences WHERE semester_id = ?').get(semesterId).n, 1, 'Preferences retained');
assert.equal(matching.generateClassMatchingVersion({ termId, adminId }).matches.length, 13);
assert.throws(() => clearSchedule({ semesterId, scope: 'all', adminId }), /Invalid schedule scope/);
// Scarce availability goes first: a flexible student must not consume the other's only hour.
for (const id of [teacher, ...students]) db.prepare("UPDATE class_matching_profiles SET matching_mode = 'ranking', direct_target_user_id = NULL WHERE term_id = ? AND user_id = ?").run(termId, id);
db.prepare('DELETE FROM class_matching_rankings WHERE term_id = ?').run(termId);
for (let i = 0; i < students.length; i++) common.saveAvailability({ termId, userId: students[i], slotIds: i === 0 ? [slots[0], slots[1]] : i === 1 ? [slots[0]] : [slots[i]] });
assert.equal(matching.generateClassMatchingVersion({ termId, adminId }).matches.length, 13, 'Scarce student retains their only available hour');

const { default: app } = await import('../src/app.js');
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
try {
  const base = `http://127.0.0.1:${server.address().port}/api`;
  async function request(route, payload, id = adminId, method = 'POST') {
    return fetch(base + route, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${signSessionToken({ id })}` }, body: JSON.stringify(payload) });
  }
  const clearPayload = { semesterId, scope: 'proposed' };
  assert.equal((await request('/admin/scheduling/clear', clearPayload, students[0])).status, 403);
  assert.equal((await request('/admin/scheduling/clear', { semesterId, scope: 'invalid' })).status, 400);
  assert.equal((await request('/admin/scheduling/clear', clearPayload)).status, 200);
  assert.equal((await request('/admin/scheduling/clear', { semesterId, scope: 'published' })).status, 200);
  const memberPlan = await fetch(`${base}/scheduling/my-assignment?semesterId=${semesterId}`, {
    headers: { Authorization: `Bearer ${signSessionToken({ id: occupant })}` }
  });
  assert.equal(memberPlan.status, 200);
  assert.deepEqual((await memberPlan.json()).assignments, [], 'Members do not see withdrawn historical assignments');
  const endpoint = `/admin/class-matching/terms/${termId}/teachers/${teacher}/qualification`;
  assert.equal((await request(endpoint, { status: 'approved', capacity: 101 }, adminId, 'PATCH')).status, 400);
  assert.equal((await request(endpoint, { status: 'approved', capacity: 14 }, adminId, 'PATCH')).status, 200);
  assert.equal(common.loadParticipantProfile(termId, teacher).capacity, 14);
  assert.equal((await request('/class-matching/profile', { termId, matchingMode: 'direct', directTargetUserIds: [] }, teacher, 'PUT')).status, 200);
  assert.equal(common.loadParticipantProfile(termId, teacher).capacity, 14, 'Partial profile updates retain capacity');
  assert.equal((await request('/class-matching/profile', { termId, capacity: 15 }, teacher, 'PUT')).status, 200);
} finally {
  await new Promise(resolve => server.close(resolve));
  db.close();
}
console.log('PASS: multi-selection, 13 students, capacity, legacy selection, clear scopes, retained preferences/history, diagnostics, scarce slots, API authorization and validation');
