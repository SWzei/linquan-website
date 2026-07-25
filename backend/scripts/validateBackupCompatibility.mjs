import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const scriptFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptFile);
const backendRoot = path.resolve(scriptDir, '..');
const projectRoot = path.resolve(backendRoot, '..');
const artifactRoot = process.env.COMPAT_ARTIFACT_ROOT
  || path.join(projectRoot, 'test-artifacts', '2026-04-06-db-compat-validation');
const apiArtifactRoot = path.join(artifactRoot, 'api');
const exportRoot = path.join(artifactRoot, 'exports');

fs.mkdirSync(apiArtifactRoot, { recursive: true });
fs.mkdirSync(exportRoot, { recursive: true });

const baseUrl = (process.env.COMPAT_BASE_URL || 'http://127.0.0.1:4310/api').replace(/\/+$/, '');
const rootUrl = baseUrl.replace(/\/api$/, '');
const startedAt = new Date().toISOString();
const tag = `DBC${startedAt.replace(/[-:TZ.]/g, '').slice(4, 16)}`;
const futureConcertDeadline = new Date(Date.now() + (30 * 24 * 60 * 60 * 1000))
  .toISOString()
  .slice(0, 16);
const statePath = path.join(apiArtifactRoot, 'compat-validation.state.json');
const adminCredential = String(process.env.COMPAT_ADMIN_CREDENTIAL || '').trim();
const adminPassword = String(process.env.COMPAT_ADMIN_PASSWORD || '');
if (!adminCredential || !adminPassword) {
  throw new Error('COMPAT_ADMIN_CREDENTIAL and COMPAT_ADMIN_PASSWORD must identify a disposable restored-backup administrator');
}

const state = {
  startedAt,
  baseUrl,
  rootUrl,
  tag,
  passed: false,
  warnings: [],
  requests: [],
  steps: [],
  created: {
    users: [],
    activityId: null,
    announcementId: null,
    concertId: null,
    semesterId: null,
    termId: null
  },
  exports: [],
  summary: {}
};

function persistState() {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function compact(value, depth = 0) {
  if (depth > 4) {
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
        .slice(0, 30)
        .map(([key, item]) => [
          key,
          /password|token|authorization|secret/i.test(key) ? '[redacted]' : compact(item, depth + 1)
        ])
    );
  }
  return String(value);
}

function recordStep(step, details = {}) {
  state.steps.push({
    at: new Date().toISOString(),
    step,
    details: compact(details)
  });
  persistState();
}

function warn(message, details = {}) {
  state.warnings.push({
    at: new Date().toISOString(),
    message,
    details: compact(details)
  });
  persistState();
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

function resolveUrl(urlPath) {
  if (/^https?:\/\//i.test(String(urlPath || ''))) {
    return String(urlPath);
  }
  if (String(urlPath || '').startsWith('/api/')) {
    return `${rootUrl}${urlPath}`;
  }
  if (String(urlPath || '').startsWith('/')) {
    return `${baseUrl}${urlPath}`;
  }
  return `${baseUrl}/${urlPath}`;
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
  } else if (options.form !== undefined) {
    body = options.form;
  }

  const response = await fetch(resolveUrl(urlPath), { method, headers, body });
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
    requestBody: compact(options.json ?? '[form-data]'),
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

async function downloadToFile(urlPath, fileName, options = {}) {
  const headers = {};
  if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }

  let targetUrl = String(urlPath || '');
  if (!/^https?:\/\//i.test(targetUrl)) {
    if (targetUrl.startsWith('/uploads/') || targetUrl.startsWith('/api/')) {
      targetUrl = `${rootUrl}${targetUrl}`;
    } else {
      targetUrl = `${baseUrl}${targetUrl}`;
    }
  }

  const response = await fetch(targetUrl, { headers });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (options.expectedStatus !== undefined && response.status !== options.expectedStatus) {
    const error = new Error(`GET ${urlPath} expected ${options.expectedStatus}, got ${response.status}`);
    error.details = buffer.toString('utf8');
    throw error;
  }
  const savedAs = path.join(exportRoot, sanitizeFileName(fileName));
  fs.writeFileSync(savedAs, buffer);
  state.exports.push({
    at: new Date().toISOString(),
    source: urlPath,
    savedAs,
    status: response.status,
    size: buffer.length
  });
  persistState();
  return {
    savedAs,
    status: response.status,
    size: buffer.length,
    headers: response.headers
  };
}

function createTextBlob(text, mime = 'text/plain') {
  return new Blob([Buffer.from(text, 'utf8')], { type: mime });
}

async function registerMember(label, roleHint = 'member') {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-8);
  const studentNumber = `${label}${suffix}`.slice(0, 20);
  const displayName = `${label}-${suffix}`;
  const password = 'Member@123';
  const email = `${studentNumber.toLowerCase()}@example.com`;
  const registered = await request('POST', '/auth/register', {
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
    roleHint,
    studentNumber,
    displayName,
    password,
    email,
    token: registered.data.token,
    userId: Number(registered.data.user.id)
  };
  state.created.users.push({ label, roleHint, studentNumber, displayName, email, userId: user.userId });
  persistState();
  return user;
}

function pickSlot(slots, predicate, label) {
  const slot = (slots || []).find(predicate);
  assert(slot, `Missing expected slot for ${label}`, { slotCount: slots?.length || 0 });
  return slot;
}

function findPublishedAttachment(item) {
  return item?.attachments?.[0] || null;
}

persistState();

try {
  const health = await request('GET', '/health', { expectedStatus: 200 });
  assert(health.data.status === 'ok', 'Health check failed', health.data);
  recordStep('health-ok', health.data);

  const publicReads = {};
  for (const pathName of ['/activities', '/announcements', '/gallery']) {
    const response = await request('GET', pathName, { expectedStatus: 200 });
    publicReads[pathName] = {
      count: Array.isArray(response.data.items) ? response.data.items.length : null
    };
  }
  await request('GET', '/concerts', { expectedStatus: 401 });
  recordStep('public-reads-ok', publicReads);

  const adminLogin = await request('POST', '/auth/login', {
    expectedStatus: 200,
    json: {
      credential: adminCredential,
      password: adminPassword
    }
  });
  const adminToken = adminLogin.data.token;
  assert(adminToken, 'Admin login returned no token');
  recordStep('admin-login-ok', adminLogin.data.user);

  const adminReads = {};
  for (const pathName of ['/admin/activities', '/admin/announcements', '/admin/concerts', '/admin/semesters', '/admin/class-matching/terms']) {
    const response = await request('GET', pathName, { token: adminToken, expectedStatus: 200 });
    adminReads[pathName] = Array.isArray(response.data.items) ? response.data.items.length : null;
  }
  recordStep('admin-reads-ok', adminReads);

  const legacyConcerts = await request('GET', '/admin/concerts', { token: adminToken, expectedStatus: 200 });
  const openConcert = (legacyConcerts.data.items || []).find((item) => item.status === 'open') || null;
  assert(openConcert, 'No open concert exists in restored production data');
  const legacyApps = await request('GET', `/admin/concerts/${openConcert.id}/applications`, {
    token: adminToken,
    expectedStatus: 200
  });
  const legacyScoreRefs = (legacyApps.data.items || [])
    .filter((item) => item.scoreFilePath)
    .slice(0, 3);
  if (legacyScoreRefs.length > 0) {
    const legacyChecks = [];
    for (const item of legacyScoreRefs) {
      const response = await fetch(`${rootUrl}${item.scoreFilePath}`, {
        headers: { Authorization: `Bearer ${adminToken}` }
      });
      legacyChecks.push({
        applicationId: item.id,
        scoreFilePath: item.scoreFilePath,
        status: response.status
      });
    }
    if (legacyChecks.some((item) => item.status === 404)) {
      warn('Legacy upload references exist in the restored database, but the provided backup does not include the corresponding persisted files under UPLOAD_ROOT.', {
        checked: legacyChecks
      });
    } else {
      recordStep('legacy-upload-download-ok', legacyChecks);
    }
  } else {
    warn('No legacy score files were available in the restored backup to validate old upload paths.');
  }

  const rankingStudent = await registerMember('CompatRS', 'student');
  const rankingTeacher = await registerMember('CompatRT', 'teacher');
  const directStudent = await registerMember('CompatDS', 'student');
  const directTeacher = await registerMember('CompatDT', 'teacher');
  const inactiveMember = await registerMember('CompatIN', 'member');
  recordStep('compat-users-created', {
    users: state.created.users.map((item) => ({
      label: item.label,
      userId: item.userId,
      studentNumber: item.studentNumber
    }))
  });

  await request('PUT', '/profiles/me', {
    token: rankingStudent.token,
    expectedStatus: 200,
    json: {
      displayName: '兼容性验证学生',
      academy: '测试院系',
      major: '兼容性工程',
      bio: '兼容性升级验证\n第二行',
      hobbies: '钢琴\n阅读',
      pianoInterests: '古典\n即兴',
      wechatAccount: 'compat_student'
    }
  });
  const profileAfterUpdate = await request('GET', '/profiles/me', {
    token: rankingStudent.token,
    expectedStatus: 200
  });
  assert(profileAfterUpdate.data.bio === '兼容性升级验证\n第二行', 'Profile multiline data was not preserved');
  recordStep('profile-update-ok', {
    userId: rankingStudent.userId,
    displayName: profileAfterUpdate.data.displayName
  });

  await request('DELETE', `/admin/members/${inactiveMember.userId}`, {
    token: adminToken,
    expectedStatus: 200
  });
  await request('POST', '/auth/login', {
    expectedStatus: 401,
    json: {
      credential: inactiveMember.studentNumber,
      password: inactiveMember.password
    }
  });
  recordStep('soft-deactivate-ok', {
    userId: inactiveMember.userId,
    studentNumber: inactiveMember.studentNumber
  });

  const activityForm = new FormData();
  activityForm.append('title', `兼容性活动 ${tag}`);
  activityForm.append('content', '来自生产备份兼容性验证的活动。');
  activityForm.append('eventTime', '2026-04-08T19:30');
  activityForm.append('location', '324 琴房');
  activityForm.append('isPublished', 'true');
  activityForm.append('attachmentFiles', createTextBlob('活动附件内容\n第二行'), '活动说明（兼容性）.txt');
  activityForm.append('attachmentFiles', createTextBlob('%PDF-1.4\ncompatibility\n%%EOF\n', 'application/pdf'), '活动安排（兼容性）.pdf');
  const createdActivity = await request('POST', '/admin/activities', {
    token: adminToken,
    form: activityForm,
    expectedStatus: 201
  });
  state.created.activityId = Number(createdActivity.data.id);
  const activityAttachment = findPublishedAttachment(createdActivity.data);
  assert(activityAttachment?.downloadUrl, 'Created activity attachment missing');
  await downloadToFile(activityAttachment.downloadUrl, 'compat-activity-attachment.txt', {
    expectedStatus: 200
  });
  const publicActivities = await request('GET', '/activities', { expectedStatus: 200 });
  assert((publicActivities.data.items || []).some((item) => Number(item.id) === state.created.activityId), 'Created activity not visible publicly');
  recordStep('activity-publishing-ok', {
    activityId: state.created.activityId,
    attachmentId: activityAttachment.id
  });

  const announcementForm = new FormData();
  announcementForm.append('title', `兼容性公告 ${tag}`);
  announcementForm.append('content', '来自生产备份兼容性验证的公告。');
  announcementForm.append('isPublished', 'true');
  announcementForm.append('attachmentFiles', createTextBlob('公告附件内容', 'text/plain'), '公告附件（兼容性）.txt');
  const createdAnnouncement = await request('POST', '/admin/announcements', {
    token: adminToken,
    form: announcementForm,
    expectedStatus: 201
  });
  state.created.announcementId = Number(createdAnnouncement.data.id);
  const announcementAttachment = findPublishedAttachment(createdAnnouncement.data);
  assert(announcementAttachment?.downloadUrl, 'Created announcement attachment missing');
  await downloadToFile(announcementAttachment.downloadUrl, 'compat-announcement-attachment.txt', {
    expectedStatus: 200
  });
  const publicAnnouncements = await request('GET', '/announcements', { expectedStatus: 200 });
  assert(
    (publicAnnouncements.data.items || []).some((item) => Number(item.id) === state.created.announcementId),
    'Created announcement not visible publicly'
  );
  recordStep('announcement-publishing-ok', {
    announcementId: state.created.announcementId,
    attachmentId: announcementAttachment.id
  });

  const concertForm = new FormData();
  concertForm.append('title', `兼容性音乐会 ${tag}`);
  concertForm.append('description', '升级兼容性验证音乐会');
  concertForm.append('announcement', '请按要求上传乐谱');
  concertForm.append('applicationDeadline', futureConcertDeadline);
  concertForm.append('status', 'open');
  concertForm.append('attachmentFile', createTextBlob('concert attachment', 'text/plain'), 'concert-note.txt');
  const createdConcert = await request('POST', '/admin/concerts', {
    token: adminToken,
    form: concertForm,
    expectedStatus: 201
  });
  state.created.concertId = Number(createdConcert.data.id);
  assert(createdConcert.data.attachmentPath, 'Created concert attachment path missing');
  await downloadToFile(createdConcert.data.attachmentPath, 'compat-concert-attachment.txt', {
    token: adminToken,
    expectedStatus: 200
  });
  const memberConcertsAfterCreate = await request('GET', '/concerts', { token: rankingStudent.token, expectedStatus: 200 });
  assert(
    (memberConcertsAfterCreate.data.items || []).some((item) => Number(item.id) === state.created.concertId),
    'Created concert not visible to an authenticated member'
  );

  const concertApplyForm = new FormData();
  concertApplyForm.append('applicantName', '兼容性验证学生');
  concertApplyForm.append('applicantStudentNumber', rankingStudent.studentNumber);
  concertApplyForm.append('pieceZh', '德彪西：月光');
  concertApplyForm.append('pieceEn', 'Debussy: Clair de lune');
  concertApplyForm.append('durationMin', '6');
  concertApplyForm.append('contactQq', '12345678');
  concertApplyForm.append('scoreFile', createTextBlob('%PDF-1.4\nmock score\n%%EOF\n', 'application/pdf'), 'score-compat.pdf');
  await request('POST', `/concerts/${state.created.concertId}/applications`, {
    token: rankingStudent.token,
    form: concertApplyForm,
    expectedStatus: 201
  });
  const myConcertApplications = await request('GET', `/concerts/${state.created.concertId}/my-applications`, {
    token: rankingStudent.token,
    expectedStatus: 200
  });
  const submittedConcertApp = (myConcertApplications.data.items || [])[0];
  assert(submittedConcertApp?.scoreFilePath, 'Concert application score file path missing');
  await downloadToFile(submittedConcertApp.scoreFilePath, 'compat-concert-score.pdf', {
    token: rankingStudent.token,
    expectedStatus: 200
  });
  await downloadToFile(`/admin/concerts/${state.created.concertId}/applications/export`, 'compat-concert-applications.csv', {
    token: adminToken,
    expectedStatus: 200
  });
  recordStep('concert-flow-ok', {
    concertId: state.created.concertId,
    applicationId: submittedConcertApp.id
  });

  const createdSemester = await request('POST', '/admin/semesters', {
    token: adminToken,
    expectedStatus: 201,
    json: {
      name: `Compat Semester ${tag}`,
      startDate: '2026-04-01',
      endDate: '2026-07-01',
      activate: false
    }
  });
  state.created.semesterId = Number(createdSemester.data.id);
  const semesterSlots = await request('GET', `/scheduling/slots?semesterId=${state.created.semesterId}`, {
    token: rankingStudent.token,
    expectedStatus: 200
  });
  const schedulingSlots = semesterSlots.data.items || [];
  const slotA = pickSlot(schedulingSlots, (slot) => slot.dayOfWeek === 1 && slot.hour === 8 && slot.roomNo === 1, 'slotA');
  const slotB = pickSlot(schedulingSlots, (slot) => slot.dayOfWeek === 1 && slot.hour === 8 && slot.roomNo === 2, 'slotB');
  const slotC = pickSlot(schedulingSlots, (slot) => slot.dayOfWeek === 1 && slot.hour === 9 && slot.roomNo === 1, 'slotC');
  await request('POST', '/scheduling/preferences', {
    token: rankingStudent.token,
    expectedStatus: 200,
    json: {
      semesterId: state.created.semesterId,
      slotIds: [slotA.id],
      classMatchingPriority: true
    }
  });
  await request('POST', '/scheduling/preferences', {
    token: rankingTeacher.token,
    expectedStatus: 200,
    json: {
      semesterId: state.created.semesterId,
      slotIds: [slotB.id]
    }
  });
  await request('POST', '/scheduling/preferences', {
    token: directStudent.token,
    expectedStatus: 200,
    json: {
      semesterId: state.created.semesterId,
      slotIds: [slotC.id]
    }
  });
  await request('POST', '/admin/scheduling/run', {
    token: adminToken,
    expectedStatus: 201,
    json: { semesterId: state.created.semesterId }
  });
  const proposedSchedule = await request('GET', `/admin/scheduling/proposed?semesterId=${state.created.semesterId}`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert((proposedSchedule.data.assignments || []).length >= 3, 'Proposed schedule missing expected assignments');
  await downloadToFile(`/admin/scheduling/preferences/export?semesterId=${state.created.semesterId}`, 'compat-scheduling-preferences.csv', {
    token: adminToken,
    expectedStatus: 200
  });
  await downloadToFile(`/admin/scheduling/export?semesterId=${state.created.semesterId}`, 'compat-scheduling-export.csv', {
    token: adminToken,
    expectedStatus: 200
  });
  await request('POST', '/admin/scheduling/publish', {
    token: adminToken,
    expectedStatus: 200,
    json: { semesterId: state.created.semesterId }
  });
  const mySchedule = await request('GET', `/scheduling/my-assignment?semesterId=${state.created.semesterId}`, {
    token: rankingStudent.token,
    expectedStatus: 200
  });
  assert(mySchedule.data.hasPublishedSchedule === true, 'Published schedule not visible to member');
  recordStep('scheduling-flow-ok', {
    semesterId: state.created.semesterId,
    batchId: proposedSchedule.data.batch?.id,
    totalAssignments: proposedSchedule.data.assignments?.length || 0
  });

  const createdTerm = await request('POST', '/admin/class-matching/terms', {
    token: adminToken,
    expectedStatus: 201,
    json: {
      name: `Compat Term ${tag}`,
      startDate: '2026-04-01',
      endDate: '2026-07-01',
      activate: false,
      semesterId: state.created.semesterId
    }
  });
  state.created.termId = Number(createdTerm.data.id);
  for (const [user, payload] of [
    [rankingStudent, {
      participantType: 'student',
      matchingMode: 'ranking',
      skillLevel: '已学琴 5 年\n希望稳定提升',
      learningGoals: '系统提升视奏\n加强伴奏能力'
    }],
    [rankingTeacher, {
      participantType: 'teacher',
      matchingMode: 'ranking',
      capacity: 2,
      teachingExperience: '有教学经验\n可带初学者',
      skillSpecialization: '古典基础\n视奏'
    }],
    [directStudent, {
      participantType: 'student',
      matchingMode: 'direct',
      skillLevel: '希望固定老师'
    }],
    [directTeacher, {
      participantType: 'teacher',
      matchingMode: 'direct',
      capacity: 1,
      teachingExperience: '可接受互选直连',
      skillSpecialization: '演奏指导'
    }]
  ]) {
    await request('PUT', '/class-matching/profile', {
      token: user.token,
      expectedStatus: 200,
      json: {
        termId: state.created.termId,
        ...payload
      }
    });
  }
  const classMatchingOverview = await request('GET', `/class-matching/overview?termId=${state.created.termId}`, {
    token: rankingStudent.token,
    expectedStatus: 200
  });
  const termSlots = classMatchingOverview.data.slots || [];
  const cmSlot1 = pickSlot(
    termSlots,
    (slot) => slot.dayOfWeek === 1 && slot.hour === 10,
    'cmSlot1'
  );
  const cmSlot2 = pickSlot(
    termSlots,
    (slot) => slot.dayOfWeek === 1 && slot.hour === 11,
    'cmSlot2'
  );
  for (const user of [rankingStudent, rankingTeacher, directStudent, directTeacher]) {
    await request('POST', '/class-matching/availability', {
      token: user.token,
      expectedStatus: 200,
      json: {
        termId: state.created.termId,
        slotIds: [cmSlot1.id, cmSlot2.id]
      }
    });
  }
  await request('PATCH', `/admin/class-matching/terms/${state.created.termId}/teachers/${rankingTeacher.userId}/qualification`, {
    token: adminToken,
    expectedStatus: 200,
    json: { status: 'approved', feedback: 'Compatibility validation teacher' }
  });
  await request('PATCH', `/admin/class-matching/terms/${state.created.termId}/teachers/${directTeacher.userId}/qualification`, {
    token: adminToken,
    expectedStatus: 200,
    json: { status: 'approved', feedback: 'Compatibility validation direct teacher' }
  });
  await request('PUT', '/class-matching/profile', {
    token: directStudent.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      matchingMode: 'direct',
      directTargetUserId: directTeacher.userId
    }
  });
  await request('PUT', '/class-matching/profile', {
    token: directTeacher.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      matchingMode: 'direct',
      directTargetUserId: directStudent.userId
    }
  });
  await request('POST', '/class-matching/rankings', {
    token: rankingStudent.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      targetUserIds: [rankingTeacher.userId]
    }
  });
  await request('POST', '/class-matching/rankings', {
    token: rankingTeacher.token,
    expectedStatus: 200,
    json: {
      termId: state.created.termId,
      targetUserIds: [rankingStudent.userId]
    }
  });
  await request('POST', '/class-matching/rankings', {
    token: directStudent.token,
    expectedStatus: 400,
    json: {
      termId: state.created.termId,
      targetUserIds: [directTeacher.userId]
    }
  });
  await request('POST', `/admin/class-matching/terms/${state.created.termId}/generate`, {
    token: adminToken,
    expectedStatus: 201,
    json: {
      changeSummary: 'Compatibility validation generation'
    }
  });
  const adminMatchingOverview = await request('GET', `/admin/class-matching/terms/${state.created.termId}/overview`, {
    token: adminToken,
    expectedStatus: 200
  });
  const matchingRows = adminMatchingOverview.data.matches || [];
  const rankingMatch = matchingRows.find((item) => Number(item.studentUserId) === rankingStudent.userId);
  const directMatch = matchingRows.find((item) => Number(item.studentUserId) === directStudent.userId);
  assert(rankingMatch, 'Ranking class matching result missing');
  assert(directMatch && directMatch.matchType === 'locked', 'Direct locked class matching result missing');
  await downloadToFile(`/admin/class-matching/terms/${state.created.termId}/export`, 'compat-class-matching.csv', {
    token: adminToken,
    expectedStatus: 200
  });
  const rankingStudentView = await request('GET', `/class-matching/overview?termId=${state.created.termId}`, {
    token: rankingStudent.token,
    expectedStatus: 200
  });
  assert(
    (rankingStudentView.data.matches || []).some((item) => Number(item.studentUserId) === rankingStudent.userId),
    'Class matching result not visible to member'
  );
  recordStep('class-matching-flow-ok', {
    termId: state.created.termId,
    currentVersion: adminMatchingOverview.data.currentVersion,
    matchCount: matchingRows.length
  });

  state.passed = true;
  state.summary = {
    passed: true,
    warnings: state.warnings.length,
    createdIds: state.created,
    exportCount: state.exports.length
  };
  persistState();
  console.log(JSON.stringify(state.summary, null, 2));
} catch (error) {
  state.passed = false;
  state.summary = {
    passed: false,
    error: {
      name: error.name,
      message: error.message,
      stack: error.stack
    },
    details: compact(error.details || null),
    warnings: state.warnings
  };
  persistState();
  console.error(JSON.stringify(state.summary, null, 2));
  process.exitCode = 1;
}
