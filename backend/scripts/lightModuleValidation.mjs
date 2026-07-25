import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const backendRoot = path.resolve(scriptDir, '..');
const projectRoot = path.resolve(backendRoot, '..');
const runStamp = new Date().toISOString().replace(/[:.]/g, '-');
const artifactRoot = process.env.LIGHT_ARTIFACT_ROOT
  ? path.resolve(process.env.LIGHT_ARTIFACT_ROOT)
  : path.join(projectRoot, 'test-artifacts', 'light-module-validation', runStamp);
const exportsRoot = path.join(artifactRoot, 'exports');
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linquan-light-'));

fs.mkdirSync(artifactRoot, { recursive: true });
fs.mkdirSync(exportsRoot, { recursive: true });

if (!process.env.DB_PATH) {
  const sourceDb = path.resolve(process.env.LIGHT_SOURCE_DB || path.join(projectRoot, 'database', 'linquan.db'));
  if (!fs.existsSync(sourceDb)) {
    throw new Error(`Source SQLite database does not exist: ${sourceDb}`);
  }
  process.env.DB_PATH = path.join(runtimeRoot, 'linquan-light.db');
  fs.copyFileSync(sourceDb, process.env.DB_PATH);
}
process.env.UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(runtimeRoot, 'uploads');
if (process.env.LIGHT_ALLOW_DATABASE_URL !== 'true') {
  process.env.DATABASE_URL = '';
}

const { default: app } = await import('../src/app.js');
const { default: db } = await import('../src/config/db.js');
const validationAdminCredential = `LVA${crypto.randomBytes(6).toString('hex')}`;
const validationAdminPassword = `Validation#${crypto.randomBytes(12).toString('base64url')}`;
const validationAdminId = Number(db.prepare(
  `INSERT INTO users (student_number, password_hash, role, account_type, is_admin)
   VALUES (?, ?, 'member', 'member', 1)`
).run(validationAdminCredential, bcrypt.hashSync(validationAdminPassword, 10)).lastInsertRowid);
db.prepare('INSERT INTO profiles (user_id, public_id, display_name) VALUES (?, ?, ?)')
  .run(validationAdminId, crypto.randomUUID(), 'Light validation administrator');

const host = '127.0.0.1';
const port = 4315;
const baseUrl = `http://${host}:${port}/api`;
const startedAt = new Date().toISOString();
const tag = `LVM${startedAt.replace(/[-:TZ.]/g, '').slice(4, 16)}`;

const state = {
  startedAt,
  baseUrl,
  tag,
  validationPassed: false,
  cleanupPerformed: false,
  cleanupVerified: false,
  baselineCounts: null,
  finalCounts: null,
  created: {
    users: [],
    semesterId: null,
    semesterBatchIds: [],
    termId: null
  },
  steps: [],
  requests: [],
  exports: [],
  summary: {}
};

const statePath = path.join(artifactRoot, 'light-module-validation.state.json');

function persistState() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function recordStep(step, details = {}) {
  state.steps.push({
    at: new Date().toISOString(),
    step,
    details
  });
  persistState();
}

function serializeError(error) {
  if (!error) {
    return null;
  }
  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

function compact(value, depth = 0) {
  if (depth > 3) {
    return '[depth-limit]';
  }
  if (value === undefined || value === null) {
    return value;
  }
  if (typeof value === 'string') {
    return value.length > 400 ? `${value.slice(0, 400)}...[truncated]` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 12).map((item) => compact(item, depth + 1));
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 20)
        .map(([key, item]) => [
          key,
          /password|token|authorization|secret/i.test(key) ? '[redacted]' : compact(item, depth + 1)
        ])
    );
  }
  return String(value);
}

function assert(condition, message, details = null) {
  if (!condition) {
    const error = new Error(message);
    error.details = details;
    throw error;
  }
}

function sanitizeFileName(name) {
  return String(name || 'artifact')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 180);
}

function resolveApiUrl(urlPath) {
  if (/^https?:\/\//i.test(String(urlPath || ''))) {
    return String(urlPath);
  }
  return `${baseUrl}${urlPath}`;
}

async function request(method, urlPath, options = {}) {
  const headers = {};
  let body;
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.json);
  }

  const response = await fetch(resolveApiUrl(urlPath), { method, headers, body });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json')
    ? await response.json()
    : await response.text();

  state.requests.push({
    at: new Date().toISOString(),
    method,
    urlPath,
    status: response.status,
    expectedStatus: options.expectedStatus ?? null,
    requestBody: compact(options.json ?? null),
    responseBody: compact(payload)
  });
  persistState();

  if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
    const error = new Error(`${method} ${urlPath} expected ${options.expectedStatus}, got ${response.status}`);
    error.details = payload;
    throw error;
  }

  return {
    status: response.status,
    headers: response.headers,
    data: payload
  };
}

async function download(urlPath, fileName, options = {}) {
  const headers = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  const response = await fetch(resolveApiUrl(urlPath), { headers });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
    const error = new Error(`GET ${urlPath} expected ${options.expectedStatus}, got ${response.status}`);
    error.details = buffer.toString('utf8');
    throw error;
  }
  const absolutePath = path.join(exportsRoot, sanitizeFileName(fileName));
  fs.writeFileSync(absolutePath, buffer);
  state.exports.push({
    at: new Date().toISOString(),
    source: urlPath,
    fileName,
    savedAs: absolutePath,
    status: response.status
  });
  persistState();
  return absolutePath;
}

function queryOne(sql, ...params) {
  return db.prepare(sql).get(...params);
}

function queryAll(sql, ...params) {
  return db.prepare(sql).all(...params);
}

function snapshotCounts() {
  const tables = [
    'users',
    'profiles',
    'semesters',
    'room_slots',
    'slot_preferences',
    'schedule_user_settings',
    'schedule_batches',
    'schedule_assignments',
    'schedule_operation_logs',
    'notifications',
    'class_matching_terms',
    'class_matching_slots',
    'class_matching_profiles',
    'class_matching_availability',
    'class_matching_rankings',
    'class_matching_versions',
    'class_matching_matches'
  ];
  return Object.fromEntries(
    tables.map((table) => [table, Number(queryOne(`SELECT COUNT(*) AS count FROM ${table}`)?.count || 0)])
  );
}

function pickSlot(slots, predicate, label) {
  const slot = slots.find(predicate);
  assert(slot, `Missing expected slot for ${label}`, { available: slots.slice(0, 12) });
  return slot;
}

async function registerMember(label, suffix) {
  const studentNumber = `${label}${suffix}`.slice(0, 20);
  const displayName = `LVM-${label}-${suffix}`;
  const password = 'Member@123';
  const email = `${studentNumber.toLowerCase()}@example.com`;
  const response = await request('POST', '/auth/register', {
    expectedStatus: 201,
    json: {
      studentNumber,
      displayName,
      password,
      email
    }
  });
  const user = {
    label,
    studentNumber,
    displayName,
    email,
    password,
    userId: response.data.user.id,
    token: response.data.token
  };
  state.created.users.push(user);
  recordStep('member-registered', { label, studentNumber, userId: user.userId });
  return user;
}

function formatAssignmentKey(assignment) {
  return `${assignment.dayOfWeek}-${assignment.hour}-${assignment.roomNo}`;
}

function deleteValidationData() {
  const userIds = state.created.users.map((item) => Number(item.userId)).filter(Boolean);
  const semesterId = Number(state.created.semesterId || 0);
  const termId = Number(state.created.termId || 0);
  const batchIds = queryAll('SELECT id FROM schedule_batches WHERE semester_id = ?', semesterId).map((item) => Number(item.id));

  const tx = db.transaction(() => {
    if (semesterId) {
      if (batchIds.length) {
        const placeholders = batchIds.map(() => '?').join(', ');
        db.prepare(
          `DELETE FROM schedule_operation_logs
           WHERE semester_id = ?
              OR batch_id IN (${placeholders})`
        ).run(semesterId, ...batchIds);
      } else {
        db.prepare('DELETE FROM schedule_operation_logs WHERE semester_id = ?').run(semesterId);
      }
    }

    if (termId) {
      db.prepare('DELETE FROM class_matching_terms WHERE id = ?').run(termId);
    }

    if (semesterId) {
      db.prepare('DELETE FROM semesters WHERE id = ?').run(semesterId);
    }

    if (userIds.length) {
      const placeholders = userIds.map(() => '?').join(', ');
      db.prepare(`DELETE FROM notifications WHERE user_id IN (${placeholders})`).run(...userIds);
      db.prepare(`DELETE FROM users WHERE id IN (${placeholders})`).run(...userIds);
    }
  });

  tx();
}

const server = await new Promise((resolve, reject) => {
  const instance = app.listen(port, host, () => resolve(instance));
  instance.once('error', reject);
});

persistState();

try {
  state.baselineCounts = snapshotCounts();
  persistState();

  const health = await request('GET', '/health', { expectedStatus: 200 });
  assert(health.data.status === 'ok', 'Health check failed', health.data);
  recordStep('health-ok', health.data);

  const adminLogin = await request('POST', '/auth/login', {
    expectedStatus: 200,
    json: {
      credential: validationAdminCredential,
      password: validationAdminPassword
    }
  });
  const adminToken = adminLogin.data.token;
  assert(adminToken, 'Admin token missing');
  recordStep('admin-login-ok', { studentNumber: validationAdminCredential });

  const suffix = tag.slice(-6);
  const scheduleStudent = await registerMember('LVMS', `${suffix}1`);
  const scheduleTeacherA = await registerMember('LVMT', `${suffix}2`);
  const scheduleTeacherB = await registerMember('LVMU', `${suffix}3`);

  const semesterCreate = await request('POST', '/admin/semesters', {
    token: adminToken,
    expectedStatus: 201,
    json: {
      name: `Light Validation Semester ${tag}`,
      startDate: '2026-03-01',
      endDate: '2026-07-01',
      activate: false
    }
  });
  state.created.semesterId = Number(semesterCreate.data.id);
  persistState();
  recordStep('semester-created', { semesterId: state.created.semesterId, name: semesterCreate.data.name });

  const studentSlots = await request('GET', `/scheduling/slots?semesterId=${state.created.semesterId}`, {
    token: scheduleStudent.token,
    expectedStatus: 200
  });
  const slots = studentSlots.data.items || [];
  const slotA = pickSlot(slots, (slot) => slot.dayOfWeek === 1 && slot.hour === 8 && slot.roomNo === 1, 'slotA');
  const slotB = pickSlot(slots, (slot) => slot.dayOfWeek === 1 && slot.hour === 8 && slot.roomNo === 2, 'slotB');
  const slotC = pickSlot(slots, (slot) => slot.dayOfWeek === 1 && slot.hour === 9 && slot.roomNo === 1, 'slotC');
  const slotD = pickSlot(slots, (slot) => slot.dayOfWeek === 1 && slot.hour === 9 && slot.roomNo === 2, 'slotD');
  recordStep('semester-slots-selected', {
    slotA,
    slotB,
    slotC,
    slotD
  });

  await request('POST', '/scheduling/preferences', {
    token: scheduleStudent.token,
    expectedStatus: 200,
    json: {
      semesterId: state.created.semesterId,
      slotIds: [slotA.id],
      classMatchingPriority: true
    }
  });
  await request('POST', '/scheduling/preferences', {
    token: scheduleTeacherA.token,
    expectedStatus: 200,
    json: {
      semesterId: state.created.semesterId,
      slotIds: [slotB.id],
      classMatchingPriority: false
    }
  });
  recordStep('initial-scheduling-preferences-saved', {
    users: [scheduleStudent.studentNumber, scheduleTeacherA.studentNumber]
  });

  await request('POST', '/admin/scheduling/run', {
    token: adminToken,
    expectedStatus: 201,
    json: {
      semesterId: state.created.semesterId
    }
  });
  const draftAfterRun = await request('GET', `/admin/scheduling/proposed?semesterId=${state.created.semesterId}`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(draftAfterRun.data.batch?.id, 'Draft batch missing after scheduling run', draftAfterRun.data);
  assert((draftAfterRun.data.assignments || []).length === 2, 'Initial scheduling draft should contain 2 assignments', draftAfterRun.data);
  recordStep('schedule-run-ok', {
    batchId: draftAfterRun.data.batch.id,
    assignmentCount: draftAfterRun.data.assignments.length
  });

  await request('POST', '/scheduling/preferences', {
    token: scheduleTeacherB.token,
    expectedStatus: 200,
    json: {
      semesterId: state.created.semesterId,
      slotIds: [slotC.id],
      classMatchingPriority: false
    }
  });
  await request('POST', '/admin/scheduling/update', {
    token: adminToken,
    expectedStatus: 201,
    json: {
      semesterId: state.created.semesterId
    }
  });
  const draftAfterUpdate = await request('GET', `/admin/scheduling/proposed?semesterId=${state.created.semesterId}`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert((draftAfterUpdate.data.assignments || []).length === 3, 'Updated scheduling draft should contain 3 assignments', draftAfterUpdate.data);
  state.created.semesterBatchIds = [Number(draftAfterUpdate.data.batch.id)];
  persistState();
  recordStep('schedule-update-ok', {
    batchId: draftAfterUpdate.data.batch.id,
    assignmentCount: draftAfterUpdate.data.assignments.length
  });

  const teacherBAssignment = (draftAfterUpdate.data.assignments || []).find(
    (item) => Number(item.userId) === Number(scheduleTeacherB.userId)
  );
  assert(teacherBAssignment, 'Expected teacherB scheduling assignment missing', draftAfterUpdate.data.assignments);
  await request('PATCH', `/admin/scheduling/assignments/${teacherBAssignment.id}`, {
    token: adminToken,
    expectedStatus: 200,
    json: {
      slotId: slotD.id,
      swapIfOccupied: true
    }
  });
  const draftAfterManualMove = await request('GET', `/admin/scheduling/proposed?semesterId=${state.created.semesterId}`, {
    token: adminToken,
    expectedStatus: 200
  });
  const movedAssignment = (draftAfterManualMove.data.assignments || []).find(
    (item) => Number(item.userId) === Number(scheduleTeacherB.userId)
  );
  assert(movedAssignment && formatAssignmentKey(movedAssignment) === formatAssignmentKey(slotD), 'Manual scheduling move did not persist', {
    movedAssignment,
    expected: slotD
  });
  recordStep('schedule-manual-move-ok', {
    assignmentId: teacherBAssignment.id,
    movedTo: slotD
  });

  await download(`/admin/scheduling/preferences/export?semesterId=${state.created.semesterId}`, 'schedule-preferences-light.csv', {
    token: adminToken,
    expectedStatus: 200
  });
  await download(`/admin/scheduling/export?semesterId=${state.created.semesterId}`, 'schedule-draft-light.csv', {
    token: adminToken,
    expectedStatus: 200
  });
  recordStep('schedule-exports-saved', { count: state.exports.length });

  await request('POST', '/admin/scheduling/publish', {
    token: adminToken,
    expectedStatus: 200,
    json: {
      semesterId: state.created.semesterId
    }
  });
  recordStep('schedule-published', { semesterId: state.created.semesterId });

  const studentSchedule = await request('GET', `/scheduling/my-assignment?semesterId=${state.created.semesterId}`, {
    token: scheduleStudent.token,
    expectedStatus: 200
  });
  const teacherASchedule = await request('GET', `/scheduling/my-assignment?semesterId=${state.created.semesterId}`, {
    token: scheduleTeacherA.token,
    expectedStatus: 200
  });
  const teacherBSchedule = await request('GET', `/scheduling/my-assignment?semesterId=${state.created.semesterId}`, {
    token: scheduleTeacherB.token,
    expectedStatus: 200
  });
  assert(studentSchedule.data.hasPublishedSchedule, 'Student published schedule missing', studentSchedule.data);
  assert(teacherASchedule.data.hasPublishedSchedule, 'TeacherA published schedule missing', teacherASchedule.data);
  assert(teacherBSchedule.data.hasPublishedSchedule, 'TeacherB published schedule missing', teacherBSchedule.data);
  assert(formatAssignmentKey(studentSchedule.data.assignments[0]) === formatAssignmentKey(slotA), 'Student assignment mismatch', studentSchedule.data.assignments);
  assert(formatAssignmentKey(teacherASchedule.data.assignments[0]) === formatAssignmentKey(slotB), 'TeacherA assignment mismatch', teacherASchedule.data.assignments);
  assert(formatAssignmentKey(teacherBSchedule.data.assignments[0]) === formatAssignmentKey(slotD), 'TeacherB moved assignment not visible after publish', teacherBSchedule.data.assignments);
  recordStep('schedule-result-visibility-ok', {
    student: studentSchedule.data.assignments,
    teacherA: teacherASchedule.data.assignments,
    teacherB: teacherBSchedule.data.assignments
  });

  const termCreate = await request('POST', '/admin/class-matching/terms', {
    token: adminToken,
    expectedStatus: 201,
    json: {
      semesterId: state.created.semesterId,
      name: `Light Validation Matching ${tag}`,
      startDate: '2026-03-01',
      endDate: '2026-07-01',
      activate: true
    }
  });
  state.created.termId = Number(termCreate.data.id);
  persistState();
  recordStep('class-matching-term-created', { termId: state.created.termId });

  await request('PUT', '/class-matching/profile', {
    token: scheduleStudent.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      participantType: 'student',
      matchingMode: 'ranking',
      skillLevel: 'Level 1\nKeeps newline',
      learningGoals: 'Needs stable teacher\nWants weekly progress'
    }
  });
  await request('PUT', '/class-matching/profile', {
    token: scheduleTeacherA.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      participantType: 'teacher',
      matchingMode: 'ranking',
      capacity: 1,
      teachingExperience: '2 years\nAccompanies beginners',
      skillSpecialization: 'Foundations\nSight reading'
    }
  });
  await request('PUT', '/class-matching/profile', {
    token: scheduleTeacherB.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      participantType: 'teacher',
      matchingMode: 'ranking',
      capacity: 1,
      teachingExperience: '3 years\nFocuses on practice planning',
      skillSpecialization: 'Technique\nPractice structure'
    }
  });
  recordStep('class-matching-profiles-saved', {
    participantUserIds: state.created.users.map((item) => item.userId)
  });

  const studentOverview = await request('GET', `/class-matching/overview?termId=${state.created.termId}`, {
    token: scheduleStudent.token,
    expectedStatus: 200
  });
  const termSlots = studentOverview.data.slots || [];
  const cmSlot1 = pickSlot(termSlots, (slot) => slot.dayOfWeek === 1 && slot.hour === 10, 'cmSlot1');
  const cmSlot2 = pickSlot(termSlots, (slot) => slot.dayOfWeek === 1 && slot.hour === 11, 'cmSlot2');

  await request('POST', '/class-matching/availability', {
    token: scheduleStudent.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      slotIds: [cmSlot1.id, cmSlot2.id]
    }
  });
  await request('POST', '/class-matching/availability', {
    token: scheduleTeacherA.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      slotIds: [cmSlot1.id, cmSlot2.id]
    }
  });
  await request('POST', '/class-matching/availability', {
    token: scheduleTeacherB.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      slotIds: [cmSlot1.id, cmSlot2.id]
    }
  });
  recordStep('class-matching-availability-saved', {
    slotIds: [cmSlot1.id, cmSlot2.id]
  });

  await request('PATCH', `/admin/class-matching/terms/${state.created.termId}/teachers/${scheduleTeacherA.userId}/qualification`, {
    token: adminToken,
    expectedStatus: 200,
    json: {
      status: 'approved',
      feedback: 'Validated for light representative run'
    }
  });
  await request('PATCH', `/admin/class-matching/terms/${state.created.termId}/teachers/${scheduleTeacherB.userId}/qualification`, {
    token: adminToken,
    expectedStatus: 200,
    json: {
      status: 'approved',
      feedback: 'Validated for light representative run'
    }
  });
  recordStep('teacher-qualification-approved', {
    teacherUserIds: [scheduleTeacherA.userId, scheduleTeacherB.userId]
  });

  await request('POST', '/class-matching/rankings', {
    token: scheduleStudent.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      targetUserIds: [scheduleTeacherA.userId, scheduleTeacherB.userId]
    }
  });
  await request('POST', '/class-matching/rankings', {
    token: scheduleTeacherA.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      targetUserIds: [scheduleStudent.userId]
    }
  });
  await request('POST', '/class-matching/rankings', {
    token: scheduleTeacherB.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      targetUserIds: [scheduleStudent.userId]
    }
  });
  recordStep('class-matching-rankings-saved', {
    studentTargets: [scheduleTeacherA.userId, scheduleTeacherB.userId]
  });

  await request('POST', `/admin/class-matching/terms/${state.created.termId}/generate`, {
    token: adminToken,
    expectedStatus: 201,
    json: {
      changeSummary: 'Light validation auto generation'
    }
  });
  const adminOverviewAfterGenerate = await request('GET', `/admin/class-matching/terms/${state.created.termId}/overview`, {
    token: adminToken,
    expectedStatus: 200
  });
  const generatedMatch = (adminOverviewAfterGenerate.data.matches || []).find(
    (item) => Number(item.studentUserId) === Number(scheduleStudent.userId)
  );
  assert(generatedMatch, 'Generated class matching result missing', adminOverviewAfterGenerate.data.matches);
  assert(Number(generatedMatch.teacherUserId) === Number(scheduleTeacherA.userId), 'Generated match should prefer teacherA', generatedMatch);
  assert(Number(generatedMatch.roomSlotId) > 0, 'Generated class matching result has no room reservation', generatedMatch);
  const pianoCollision = queryOne(
    `SELECT sa.id
     FROM schedule_assignments sa
     JOIN schedule_batches sb ON sb.id = sa.batch_id
     WHERE sb.semester_id = ? AND sb.status = 'published' AND sa.slot_id = ?`,
    state.created.semesterId,
    generatedMatch.roomSlotId
  );
  assert(!pianoCollision, 'Class Matching reused a Piano Time room', { generatedMatch, pianoCollision });
  recordStep('class-matching-generated', {
    version: adminOverviewAfterGenerate.data.currentVersion,
    generatedMatch
  });

  await request('POST', '/scheduling/preferences', {
    token: scheduleTeacherB.token,
    expectedStatus: 200,
    json: {
      semesterId: state.created.semesterId,
      slotIds: [generatedMatch.roomSlotId],
      classMatchingPriority: false
    }
  });
  await request('POST', '/admin/scheduling/run', {
    token: adminToken,
    expectedStatus: 201,
    json: { semesterId: state.created.semesterId }
  });
  const postClassDraft = await request('GET', `/admin/scheduling/proposed?semesterId=${state.created.semesterId}`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(
    !(postClassDraft.data.assignments || []).some((item) => Number(item.slotId) === Number(generatedMatch.roomSlotId)),
    'Piano Time regeneration displaced a current Class Matching room',
    postClassDraft.data.assignments
  );
  const manualPianoConflict = await request('POST', '/admin/scheduling/assignments', {
    token: adminToken,
    expectedStatus: 409,
    json: {
      batchId: postClassDraft.data.batch.id,
      userId: scheduleTeacherB.userId,
      slotId: generatedMatch.roomSlotId
    }
  });
  assert(
    manualPianoConflict.data.message.includes('reserved by the current Class Matching'),
    'Manual Piano Time assignment did not enforce Class Matching room reservation',
    manualPianoConflict.data
  );
  recordStep('shared-room-priority-enforced', {
    roomSlotId: generatedMatch.roomSlotId,
    draftBatchId: postClassDraft.data.batch.id
  });

  await download(`/admin/class-matching/terms/${state.created.termId}/export`, 'class-matching-light.csv', {
    token: adminToken,
    expectedStatus: 200
  });
  recordStep('class-matching-export-saved', {
    exports: state.exports.map((item) => item.savedAs)
  });

  await request('POST', `/admin/class-matching/terms/${state.created.termId}/manual`, {
    token: adminToken,
    expectedStatus: 201,
    json: {
      studentUserId: scheduleStudent.userId,
      teacherUserId: scheduleTeacherB.userId,
      notes: 'Representative admin reassignment',
      changeSummary: 'Light validation manual adjustment'
    }
  });
  const adminOverviewAfterManual = await request('GET', `/admin/class-matching/terms/${state.created.termId}/overview`, {
    token: adminToken,
    expectedStatus: 200
  });
  const manualMatch = (adminOverviewAfterManual.data.matches || []).find(
    (item) => Number(item.studentUserId) === Number(scheduleStudent.userId)
  );
  assert(manualMatch, 'Manual class matching result missing', adminOverviewAfterManual.data.matches);
  assert(Number(manualMatch.teacherUserId) === Number(scheduleTeacherB.userId), 'Manual adjustment should reassign to teacherB', manualMatch);
  assert(manualMatch.matchType === 'manual', 'Manual adjustment should be visible as manual match', manualMatch);
  recordStep('class-matching-manual-adjustment-ok', {
    currentVersion: adminOverviewAfterManual.data.currentVersion,
    manualMatch
  });

  const studentOverviewAfterManual = await request('GET', `/class-matching/overview?termId=${state.created.termId}`, {
    token: scheduleStudent.token,
    expectedStatus: 200
  });
  const visibleStudentMatch = (studentOverviewAfterManual.data.matches || []).find(
    (item) => Number(item.studentUserId) === Number(scheduleStudent.userId)
  );
  assert(visibleStudentMatch, 'Member class matching result missing after manual adjustment', studentOverviewAfterManual.data.matches);
  assert(Number(visibleStudentMatch.teacherUserId) === Number(scheduleTeacherB.userId), 'Member view should reflect manual class matching result', visibleStudentMatch);
  recordStep('class-matching-result-visibility-ok', {
    visibleStudentMatch
  });

  state.validationPassed = true;
  persistState();

  deleteValidationData();
  state.cleanupPerformed = true;

  const deletedUsersCount = Number(
    queryOne(
      `SELECT COUNT(*) AS count
       FROM users
       WHERE id IN (${state.created.users.map(() => '?').join(', ')})`,
      ...state.created.users.map((item) => item.userId)
    )?.count || 0
  );
  assert(deletedUsersCount === 0, 'Created users were not fully removed', { deletedUsersCount });
  assert(!queryOne('SELECT id FROM semesters WHERE id = ?', state.created.semesterId), 'Created semester still exists');
  assert(!queryOne('SELECT id FROM class_matching_terms WHERE id = ?', state.created.termId), 'Created class matching term still exists');
  state.finalCounts = snapshotCounts();
  state.cleanupVerified = JSON.stringify(state.baselineCounts) === JSON.stringify(state.finalCounts);
  assert(state.cleanupVerified, 'Baseline counts were not restored after cleanup', {
    baseline: state.baselineCounts,
    final: state.finalCounts
  });
  recordStep('cleanup-verified', {
    baselineCounts: state.baselineCounts,
    finalCounts: state.finalCounts
  });

  const postCleanupAdminLogin = await request('POST', '/auth/login', {
    expectedStatus: 200,
    json: {
      credential: validationAdminCredential,
      password: validationAdminPassword
    }
  });
  const postCleanupAdminToken = postCleanupAdminLogin.data.token;
  assert(postCleanupAdminToken, 'Admin login failed after cleanup');
  await request('GET', '/admin/semesters', {
    token: postCleanupAdminToken,
    expectedStatus: 200
  });
  await request('GET', '/admin/class-matching/terms', {
    token: postCleanupAdminToken,
    expectedStatus: 200
  });
  recordStep('post-cleanup-functionality-ok', {
    adminLogin: true,
    removedUserAbsentFromDb: true
  });

  state.summary = {
    validationPassed: true,
    cleanupPerformed: true,
    cleanupVerified: true,
    createdUsers: state.created.users.map((item) => ({
      userId: item.userId,
      studentNumber: item.studentNumber
    })),
    semesterId: state.created.semesterId,
    termId: state.created.termId,
    exportCount: state.exports.length
  };
  persistState();

  console.log(JSON.stringify(state.summary, null, 2));
} catch (error) {
  state.validationPassed = false;
  state.summary = {
    validationPassed: false,
    cleanupPerformed: state.cleanupPerformed,
    cleanupVerified: state.cleanupVerified,
    error: serializeError(error),
    errorDetails: compact(error.details || null)
  };
  persistState();
  console.error(JSON.stringify(state.summary, null, 2));
  process.exitCode = 1;
} finally {
  await new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  // The validation administrator is infrastructure for this run rather than a
  // business fixture tracked in state.created.users. Remove it explicitly so a
  // restored or shared disposable database returns to its pre-run identity set.
  db.prepare('DELETE FROM users WHERE id = ? AND student_number = ?')
    .run(validationAdminId, validationAdminCredential);
  if (typeof db.close === 'function') {
    db.close();
  }
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}
