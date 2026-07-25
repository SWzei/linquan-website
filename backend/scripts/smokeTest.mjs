import fs from 'fs';
import os from 'os';
import path from 'path';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linquan-smoke-'));
process.env.DATABASE_URL = '';
process.env.DB_PATH = path.join(tempRoot, 'smoke.db');
process.env.UPLOAD_ROOT = path.join(tempRoot, 'uploads');
process.env.NODE_ENV = 'test';

const smokeHost = process.env.SMOKE_HOST || '127.0.0.1';
const smokePort = Number(process.env.SMOKE_PORT || 4100);
const base = process.env.SMOKE_BASE_URL || `http://${smokeHost}:${smokePort}/api`;

await import('../src/scripts/initDb.js');
const { default: app } = await import('../src/app.js');
const { default: db } = await import('../src/config/db.js');
const { provisionMaintainer } = await import('../src/services/maintainerService.js');
const { UPLOAD_ROOT } = await import('../src/config/env.js');
const uploadRoot = path.resolve(process.cwd(), UPLOAD_ROOT);

const legacyAuditionTable = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'audition_slots'"
).get();
assert(!legacyAuditionTable, 'Canonical schema must not recreate the obsolete audition_slots table');
const concertArchiveTable = db.prepare(
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'legacy_concert_workflow_archive'"
).get();
assert(concertArchiveTable, 'Legacy concert preservation archive table is missing');

provisionMaintainer({
  credential: 'maintainer.smoke',
  password: 'SmokeMaintainer#2026'
});

const server = await new Promise((resolve, reject) => {
  const instance = app.listen(smokePort, smokeHost, () => resolve(instance));
  instance.once('error', reject);
});

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function isUtcIsoString(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}

function assertUtcIso(value, message) {
  assert(isUtcIsoString(value), `${message}: ${value}`);
}

function uploadUrlToDiskPath(uploadPath) {
  if (!uploadPath) {
    return null;
  }
  const relativePath = String(uploadPath).replace(/^\/uploads\//, '');
  return path.resolve(uploadRoot, relativePath);
}

function attachmentDiskPath(attachmentId) {
  const row = db.prepare('SELECT file_path AS filePath FROM content_attachments WHERE id = ?').get(attachmentId);
  return uploadUrlToDiskPath(row?.filePath);
}

function concertAttachmentDiskPath(concertId) {
  const row = db.prepare('SELECT attachment_path AS filePath FROM concerts WHERE id = ?').get(concertId);
  return uploadUrlToDiskPath(row?.filePath);
}

function scoreDiskPath(applicationId) {
  const row = db.prepare('SELECT score_file_path AS filePath FROM concert_applications WHERE id = ?').get(applicationId);
  return uploadUrlToDiskPath(row?.filePath);
}

function resolveApiUrl(urlPath) {
  if (/^https?:\/\//i.test(String(urlPath || ''))) {
    return String(urlPath);
  }
  if (String(urlPath || '').startsWith('/api/')) {
    const root = base.replace(/\/api$/, '');
    return `${root}${urlPath}`;
  }
  return `${base}${urlPath}`;
}

async function request(method, urlPath, { token, json, form, expectedStatus = 200 } = {}) {
  const headers = {};
  let body;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  } else if (form !== undefined) {
    body = form;
  }

  const res = await fetch(resolveApiUrl(urlPath), {
    method,
    headers,
    body
  });

  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : await res.text();
  if (res.status !== expectedStatus) {
    throw new Error(`${method} ${urlPath} expected ${expectedStatus}, got ${res.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

async function download(method, urlPath, { token, expectedStatus = 200 } = {}) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(resolveApiUrl(urlPath), { method, headers });
  const text = await res.text();
  if (res.status !== expectedStatus) {
    throw new Error(`${method} ${urlPath} expected ${expectedStatus}, got ${res.status}: ${text}`);
  }
  return text;
}

async function downloadBuffer(urlPath, { token, expectedStatus = 200 } = {}) {
  const headers = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const res = await fetch(resolveApiUrl(urlPath), { method: 'GET', headers });
  const arrayBuffer = await res.arrayBuffer();
  if (res.status !== expectedStatus) {
    throw new Error(
      `GET ${urlPath} expected ${expectedStatus}, got ${res.status}: ${Buffer.from(arrayBuffer).toString('utf8')}`
    );
  }
  return {
    body: Buffer.from(arrayBuffer),
    contentType: res.headers.get('content-type') || '',
    disposition: res.headers.get('content-disposition') || ''
  };
}

async function registerMemberAccount({ studentNumber, displayName, email }) {
  const register = await request('POST', '/auth/register', {
    json: {
      studentNumber,
      displayName,
      password: 'Member@123',
      email
    },
    expectedStatus: 201
  });
  const profile = await request('GET', '/profiles/me', {
    token: register.token,
    expectedStatus: 200
  });
  return {
    token: register.token,
    userId: profile.userId || profile.id,
    studentNumber,
    displayName
  };
}

try {
  const imageBuffer = Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex');
  const noteBuffer = Buffer.from('smoke attachment content', 'utf8');
  const csvBuffer = Buffer.from('name,slot\nAlice,Mon 08:00\n', 'utf8');
  const pdfBuffer = Buffer.from('%PDF-1.4\n% smoke pdf\n%%EOF\n', 'utf8');
  const xlsxBuffer = Buffer.from('504b0506000000000000000000000000000000000000', 'hex');
  const activityTextName = '活动说明（测试）.txt';
  const activityImageName = '海报 2026(终版).jpg';
  const activitySheetName = '南京大学院系、教学单位和大类本科教务员通讯录.xlsx';
  const activityPdfName = '活动安排（终版）#1.pdf';
  const activityReplacementName = '活动安排（替换）.csv';
  const announcementImageName = '公告海报（测试）.jpg';
  const announcementSheetName = '审核结果（钢琴社）#1.xlsx';
  const announcementReplacementName = '公告附件（更新）.pdf';

  const maintainerLogin = await request('POST', '/maintainer/auth/login', {
    json: { credential: 'maintainer.smoke', password: 'SmokeMaintainer#2026' },
    expectedStatus: 200
  });
  const maintainerToken = maintainerLogin.token;
  assert(maintainerToken, 'Maintainer token missing');
  await request('GET', '/admin/members', { token: maintainerToken, expectedStatus: 403 });
  await request('GET', '/scheduling/semester', { token: maintainerToken, expectedStatus: 403 });
  const initialPublicContributors = await request('GET', '/contributors', { expectedStatus: 200 });
  assert(initialPublicContributors.items.some((item) => item.name === 'SWzei' && item.githubUrl === 'https://github.com/swzei'), 'Initial contributor credit missing');
  assert(initialPublicContributors.items.every((item) => Object.keys(item).sort().join(',') === 'githubUrl,name'), 'Public contributor projection exposed internal fields');
  await request('GET', '/maintainer/contributors', { expectedStatus: 401 });

  const suffix = Date.now();
  const memberStudentNumber = `M${String(suffix).slice(-7)}`;
  const memberRegister = await request('POST', '/auth/register', {
    json: {
      studentNumber: memberStudentNumber,
      displayName: `测试成员${String(suffix).slice(-4)}`,
      password: 'Member@123',
      email: `m${suffix}@example.com`
    },
    expectedStatus: 201
  });
  const memberToken = memberRegister.token;
  assert(memberToken, 'Member token missing after register');
  assert(memberRegister.user.profileReminderPending === true, 'New member profile reminder should be pending');
  const memberMeBeforeReminder = await request('GET', '/auth/me', { token: memberToken, expectedStatus: 200 });
  assert(memberMeBeforeReminder.user.profileReminderPending === true, 'Profile reminder did not persist in the session API');
  await request('POST', '/auth/profile-reminder/acknowledge', { expectedStatus: 401 });
  await request('POST', '/auth/profile-reminder/acknowledge', { token: maintainerToken, expectedStatus: 403 });
  const reminderAcknowledged = await request('POST', '/auth/profile-reminder/acknowledge', {
    token: memberToken,
    expectedStatus: 200
  });
  assert(reminderAcknowledged.profileReminderPending === false, 'Profile reminder acknowledgement failed');
  const memberLoginAfterReminder = await request('POST', '/auth/login', {
    json: { credential: memberStudentNumber, password: 'Member@123' },
    expectedStatus: 200
  });
  assert(
    memberLoginAfterReminder.user.profileReminderPending === false,
    'Acknowledged profile reminder returned in a later login session'
  );
  await request('POST', '/maintainer/contributors', {
    token: memberToken,
    json: { name: 'Denied Member', githubUrl: 'https://github.com/denied-member' },
    expectedStatus: 403
  });
  const maintainerMembers = await request('GET', '/maintainer/members', { token: maintainerToken });
  const intendedAdmin = maintainerMembers.items.find((item) => item.studentNumber === memberStudentNumber);
  assert(intendedAdmin && !intendedAdmin.isAdmin, 'Registered member missing from Maintainer member list');
  const grantResult = await request('PUT', `/maintainer/members/${intendedAdmin.id}/administrator`, {
    token: maintainerToken,
    json: { isAdmin: true }
  });
  assert(grantResult.changed && grantResult.isAdmin, 'Maintainer grant failed');
  const adminToken = memberToken;
  await request('GET', '/admin/members', { token: adminToken, expectedStatus: 200 });
  await request('GET', '/maintainer/members', { token: adminToken, expectedStatus: 403 });
  await request('POST', '/maintainer/contributors', {
    token: adminToken,
    json: { name: 'Denied Admin', githubUrl: 'https://github.com/denied-admin' },
    expectedStatus: 403
  });
  await request('POST', '/maintainer/contributors', {
    token: maintainerToken,
    json: { name: 'Unsafe Link', githubUrl: 'http://github.com/unsafe-link' },
    expectedStatus: 400
  });
  await request('POST', '/maintainer/contributors', {
    token: maintainerToken,
    json: { name: 'Repository Link', githubUrl: 'https://github.com/SWzei/NJU' },
    expectedStatus: 400
  });
  const contributorA = await request('POST', '/maintainer/contributors', {
    token: maintainerToken,
    json: { name: 'Smoke Contributor A', githubUrl: 'https://github.com/linquan-smoke-a' },
    expectedStatus: 201
  });
  const contributorB = await request('POST', '/maintainer/contributors', {
    token: maintainerToken,
    json: { name: 'Smoke Contributor B', githubUrl: 'https://github.com/linquan-smoke-b' },
    expectedStatus: 201
  });
  await request('POST', '/maintainer/contributors', {
    token: maintainerToken,
    json: { name: 'Duplicate Profile', githubUrl: 'https://github.com/LINQUAN-SMOKE-A' },
    expectedStatus: 409
  });
  const maintainerContributors = await request('GET', '/maintainer/contributors', {
    token: maintainerToken,
    expectedStatus: 200
  });
  const reorderedContributorIds = [
    contributorB.id,
    ...maintainerContributors.items.filter((item) => item.id !== contributorA.id && item.id !== contributorB.id).map((item) => item.id),
    contributorA.id
  ];
  const reorderedContributors = await request('PUT', '/maintainer/contributors/order', {
    token: maintainerToken,
    json: { ids: reorderedContributorIds },
    expectedStatus: 200
  });
  assert(reorderedContributors.items[0].id === contributorB.id, 'Contributor reorder failed');
  await request('PUT', '/maintainer/contributors/order', {
    token: maintainerToken,
    json: { ids: [contributorA.id] },
    expectedStatus: 400
  });
  const updatedContributor = await request('PATCH', `/maintainer/contributors/${contributorB.id}`, {
    token: maintainerToken,
    json: { name: 'Smoke Contributor B Updated', githubUrl: 'https://github.com/linquan-smoke-updated' },
    expectedStatus: 200
  });
  assert(updatedContributor.name === 'Smoke Contributor B Updated', 'Contributor update failed');
  const publicContributorsAfterChanges = await request('GET', '/contributors', { expectedStatus: 200 });
  assert(publicContributorsAfterChanges.items[0].name === 'Smoke Contributor B Updated', 'Public contributor ordering did not update');
  assert(publicContributorsAfterChanges.items.every((item) => !Object.hasOwn(item, 'id') && !Object.hasOwn(item, 'displayOrder')), 'Public contributor projection leaked management fields');
  await request('DELETE', `/maintainer/contributors/${contributorA.id}`, { token: maintainerToken, expectedStatus: 200 });
  await request('DELETE', `/maintainer/contributors/${contributorB.id}`, { token: maintainerToken, expectedStatus: 200 });
  const publicContributorsAfterCleanup = await request('GET', '/contributors', { expectedStatus: 200 });
  assert(publicContributorsAfterCleanup.items.length === initialPublicContributors.items.length, 'Contributor smoke records were not removed');
  await request('GET', '/does-not-exist', { expectedStatus: 404 });
  await request('GET', '/does-not-exist', { token: memberToken, expectedStatus: 404 });

  const secondStudentNumber = `T${String(suffix + 1).slice(-7)}`;
  const secondMemberRegister = await request('POST', '/auth/register', {
    json: {
      studentNumber: secondStudentNumber,
      displayName: `测试成员B${String(suffix).slice(-4)}`,
      password: 'Member@123',
      email: `t${suffix}@example.com`
    },
    expectedStatus: 201
  });
  const secondMemberToken = secondMemberRegister.token;
  assert(secondMemberToken, 'Second member token missing');

  const profileBefore = await request('GET', '/profiles/me', { token: memberToken, expectedStatus: 200 });
  assert(profileBefore.studentNumber === memberStudentNumber, 'Profile me student number mismatch');

  const rejectedAvatarForm = new FormData();
  rejectedAvatarForm.append('avatar', new Blob([Buffer.from('<html>not an image</html>')], { type: 'image/jpeg' }), 'spoofed.jpg');
  await request('POST', '/profiles/me/avatar', {
    token: memberToken,
    form: rejectedAvatarForm,
    expectedStatus: 400
  });
  const avatarDirBeforeValidUpload = path.join(uploadRoot, 'avatars');
  assert(!fs.existsSync(avatarDirBeforeValidUpload) || fs.readdirSync(avatarDirBeforeValidUpload).length === 0, 'Rejected avatar left a stored file');

  await request('PUT', '/profiles/me', {
    token: memberToken,
    json: {
      displayName: '测试成员-更新',
      academy: '计算机学院',
      major: '软件工程',
      bio: '烟测简介\n第二行保留',
      hobbies: '钢琴\n阅读',
      pianoInterests: '即兴伴奏\n视奏',
      wechatAccount: 'linquan_test',
      phone: '18800001111'
    },
    expectedStatus: 200
  });

  const avatarForm = new FormData();
  avatarForm.append('avatar', new Blob([imageBuffer], { type: 'image/jpeg' }), 'avatar.jpg');
  const avatarUpload = await request('POST', '/profiles/me/avatar', {
    token: memberToken,
    form: avatarForm,
    expectedStatus: 201
  });
  const photoForm = new FormData();
  photoForm.append('photo', new Blob([imageBuffer], { type: 'image/jpeg' }), 'photo.jpg');
  const photoUpload = await request('POST', '/profiles/me/photo', {
    token: memberToken,
    form: photoForm,
    expectedStatus: 201
  });
  assert(avatarUpload.avatarUrl.startsWith('/api/members/'), 'Avatar did not use controlled media URL');
  assert(photoUpload.photoUrl.startsWith('/api/members/'), 'Photo did not use controlled media URL');
  let storedProfileMedia = db.prepare('SELECT avatar_url AS avatarUrl, photo_url AS photoUrl FROM profiles WHERE user_id = ?').get(profileBefore.id);
  assert(fs.existsSync(uploadUrlToDiskPath(storedProfileMedia.avatarUrl)), 'Avatar upload file missing');
  assert(fs.existsSync(uploadUrlToDiskPath(storedProfileMedia.photoUrl)), 'Photo upload file missing');
  const originalAvatarDiskPath = uploadUrlToDiskPath(storedProfileMedia.avatarUrl);
  const replacementAvatarForm = new FormData();
  replacementAvatarForm.append('avatar', new Blob([imageBuffer], { type: 'image/jpeg' }), 'avatar-replacement.jpg');
  const replacementAvatarUpload = await request('POST', '/profiles/me/avatar', {
    token: memberToken,
    form: replacementAvatarForm,
    expectedStatus: 201
  });
  assert(!fs.existsSync(originalAvatarDiskPath), 'Replaced avatar file was not removed');
  storedProfileMedia = db.prepare('SELECT avatar_url AS avatarUrl FROM profiles WHERE user_id = ?').get(profileBefore.id);
  assert(fs.existsSync(uploadUrlToDiskPath(storedProfileMedia.avatarUrl)), 'Replacement avatar file missing');

  const profileAfterUpload = await request('GET', '/profiles/me', { token: memberToken, expectedStatus: 200 });
  assert(profileAfterUpload.displayName === '测试成员-更新', 'Profile displayName not saved');
  assert(profileAfterUpload.avatarUrl, 'Avatar URL not saved');
  assert(profileAfterUpload.photoUrl, 'Photo URL not saved');
  assert(profileAfterUpload.bio === '烟测简介\n第二行保留', 'Profile bio newline was not preserved');
  assert(profileAfterUpload.hobbies === '钢琴\n阅读', 'Profile hobbies newline was not preserved');
  assert(profileAfterUpload.pianoInterests === '即兴伴奏\n视奏', 'Profile piano interests newline was not preserved');

  await request('GET', '/profiles', { expectedStatus: 401 });
  await request('GET', '/profiles', { token: memberToken, expectedStatus: 404 });
  const directory = await request('GET', '/members', { expectedStatus: 200 });
  assert(Array.isArray(directory.items) && directory.items.length >= 2, 'Member directory not available');
  const publicMe = directory.items.find((item) => item.displayName === '测试成员-更新');
  const secondPublicMember = directory.items.find((item) => item.displayName.startsWith('测试成员B'));
  assert(publicMe && !('studentNumber' in publicMe) && !('email' in publicMe) && !('wechatAccount' in publicMe), 'Public member projection leaked private data');
  const myDetail = await request('GET', `/members/${publicMe.publicId}`, {
    expectedStatus: 200
  });
  assert(myDetail.displayName === '测试成员-更新', 'Member detail endpoint failed');

  const memberList = await request('GET', '/admin/members', { token: adminToken, expectedStatus: 200 });
  assert(Array.isArray(memberList.items) && memberList.items.length >= 2, 'Admin member list failed');
  const managedMember = memberList.items.find((item) => item.studentNumber === secondStudentNumber);
  assert(managedMember, 'Second member not found in admin list');
  assert(!Object.hasOwn(managedMember, 'passwordHash'), 'Admin member list must not expose password hashes');
  await request('GET', `/admin/members/${managedMember.id}`, { token: adminToken, expectedStatus: 200 });
  const weakPasswordReset = await request('POST', `/admin/members/${managedMember.id}/reset-password`, {
    token: adminToken,
    json: { newPassword: 'weakpass' },
    expectedStatus: 400
  });
  assert(
    /8-128 characters.*letter.*number/i.test(weakPasswordReset.message),
    'Admin reset password policy message is inconsistent'
  );
  const boundaryPasswordReset = await request('POST', `/admin/members/${managedMember.id}/reset-password`, {
    token: adminToken,
    json: { newPassword: 'A1234567' },
    expectedStatus: 200
  });
  assert(boundaryPasswordReset.temporaryPassword === 'A1234567', 'Eight-character member password boundary failed');
  const forcedLogin = await request('POST', '/auth/login', {
    json: { credential: secondStudentNumber, password: 'A1234567' },
    expectedStatus: 200
  });
  assert(forcedLogin.user.mustChangePassword === true, 'Admin reset must require a first-login password change');
  assert(
    forcedLogin.user.profileReminderPending === true,
    'Forced-password member should retain the unacknowledged profile reminder'
  );
  const forcedAccess = await request('GET', '/profiles/me', {
    token: forcedLogin.token,
    expectedStatus: 403
  });
  assert(forcedAccess.code === 'PASSWORD_CHANGE_REQUIRED', 'Forced password change did not isolate protected routes');
  const forcedReminderAcknowledged = await request('POST', '/auth/profile-reminder/acknowledge', {
    token: forcedLogin.token,
    expectedStatus: 200
  });
  assert(
    forcedReminderAcknowledged.profileReminderPending === false,
    'Forced-password member could not acknowledge their own profile reminder'
  );
  db.prepare(
    `UPDATE users
     SET profile_reminder_pending = 1
     WHERE id = ?`
  ).run(managedMember.id);
  await request('POST', '/auth/change-password', {
    token: forcedLogin.token,
    json: { currentPassword: 'A1234567', newPassword: 'weakpass' },
    expectedStatus: 400
  });
  await request('POST', '/auth/change-password', {
    token: forcedLogin.token,
    json: { currentPassword: 'Wrong123', newPassword: 'Changed123' },
    expectedStatus: 401
  });
  await request('POST', '/auth/change-password', {
    token: forcedLogin.token,
    json: { currentPassword: 'A1234567', newPassword: 'Changed123' },
    expectedStatus: 200
  });
  await request('GET', '/auth/me', { token: forcedLogin.token, expectedStatus: 401 });
  await request('POST', '/auth/login', {
    json: { credential: secondStudentNumber, password: 'A1234567' },
    expectedStatus: 401
  });
  const changedLogin = await request('POST', '/auth/login', {
    json: { credential: secondStudentNumber, password: 'Changed123' },
    expectedStatus: 200
  });
  assert(changedLogin.user.mustChangePassword === false, 'Self-service password change did not clear forced-change state');
  assert(
    changedLogin.user.profileReminderPending === true,
    'Password change incorrectly cleared the pending profile reminder'
  );
  const postChangeReminderAcknowledged = await request('POST', '/auth/profile-reminder/acknowledge', {
    token: changedLogin.token,
    expectedStatus: 200
  });
  assert(
    postChangeReminderAcknowledged.profileReminderPending === false,
    'Profile reminder could not be acknowledged after password change'
  );
  const passwordAudit = db.prepare(
    `SELECT action FROM auth_security_audit
     WHERE target_user_id = ?
     ORDER BY id ASC`
  ).all(managedMember.id);
  assert(
    passwordAudit.some((item) => item.action === 'admin_password_reset')
      && passwordAudit.some((item) => item.action === 'member_password_change'),
    'Password reset/change security audit is incomplete'
  );
  const resetPassword = await request('POST', `/admin/members/${managedMember.id}/reset-password`, {
    token: adminToken,
    json: {},
    expectedStatus: 200
  });
  assert(resetPassword.temporaryPassword, 'Temporary password missing after reset');
  await request('DELETE', `/admin/members/${managedMember.id}`, { token: adminToken, expectedStatus: 200 });
  const memberListAfterDeactivate = await request('GET', '/admin/members', { token: adminToken, expectedStatus: 200 });
  assert(
    !(memberListAfterDeactivate.items || []).some((item) => item.studentNumber === secondStudentNumber),
    'Deactivated member should be excluded from admin member list'
  );
  await request('GET', `/admin/members/${managedMember.id}`, { token: adminToken, expectedStatus: 404 });
  const directoryAfterDeactivate = await request('GET', '/members', { expectedStatus: 200 });
  assert(
    !(directoryAfterDeactivate.items || []).some((item) => item.publicId === secondPublicMember?.publicId),
    'Deactivated member should be excluded from public member directory'
  );
  await request('GET', '/profiles/me', { token: secondMemberToken, expectedStatus: 401 });
  await request('GET', `/members/${secondPublicMember.publicId}`, { expectedStatus: 404 });
  await request('POST', '/auth/login', {
    json: {
      credential: secondStudentNumber,
      password: resetPassword.temporaryPassword
    },
    expectedStatus: 401
  });

  const galleryUploadForm = new FormData();
  galleryUploadForm.append('imageFile', new Blob([imageBuffer], { type: 'image/jpeg' }), 'gallery.jpg');
  const galleryUpload = await request('POST', '/admin/gallery/upload', {
    token: adminToken,
    form: galleryUploadForm,
    expectedStatus: 201
  });
  assert(galleryUpload.src, 'Gallery upload path missing');
  const galleryDiskPath = uploadUrlToDiskPath(galleryUpload.src);
  assert(fs.existsSync(galleryDiskPath), 'Gallery upload file missing on disk');
  const createdGalleryItem = await request('POST', '/admin/gallery', {
    token: adminToken,
    json: {
      src: galleryUpload.src,
      titleZh: '烟测相册',
      titleEn: 'Smoke Gallery',
      descriptionZh: '烟测描述\n第二行',
      descriptionEn: 'Smoke description\nSecond line',
      altZh: '烟测图片',
      altEn: 'Smoke image',
      displayOrder: 999,
      isVisible: true
    },
    expectedStatus: 201
  });
  await request('PATCH', `/admin/gallery/${createdGalleryItem.id}`, {
    token: adminToken,
    json: {
      titleZh: '烟测相册-更新',
      titleEn: 'Smoke Gallery Updated'
    },
    expectedStatus: 200
  });
  const galleryPublic = await request('GET', '/gallery', { expectedStatus: 200 });
  const smokeGalleryPublic = (galleryPublic.items || []).find((item) => item.id === createdGalleryItem.id);
  assert(smokeGalleryPublic, 'Public gallery missing created item');
  assert(smokeGalleryPublic.descriptionZh === '烟测描述\n第二行', 'Gallery description newline was not preserved');
  await request('DELETE', `/admin/gallery/${createdGalleryItem.id}`, { token: adminToken, expectedStatus: 200 });
  assert(fs.existsSync(galleryDiskPath), 'Archiving a gallery item must preserve its file');
  const galleryAfterArchive = await request('GET', '/gallery', { expectedStatus: 200 });
  assert(!(galleryAfterArchive.items || []).some((item) => item.id === createdGalleryItem.id), 'Archived gallery item remained public');
  const archiveDeniedMember = await registerMemberAccount({
    studentNumber: `AR${String(suffix).slice(-6)}`,
    displayName: `归档权限测试${String(suffix).slice(-3)}`,
    email: `archive-denied-${suffix}@example.com`
  });
  await request('GET', '/admin/archive', { expectedStatus: 401 });
  await request('GET', '/admin/archive', { token: archiveDeniedMember.token, expectedStatus: 403 });
  await request('GET', '/admin/archive', { token: maintainerToken, expectedStatus: 403 });
  await request('GET', '/maintainer/archive', { token: adminToken, expectedStatus: 403 });
  const galleryArchives = await request('GET', '/admin/archive?module=gallery_display', { token: adminToken });
  const galleryArchive = (galleryArchives.items || []).find((item) => item.recordId === createdGalleryItem.id);
  assert(galleryArchive && galleryArchive.status === 'archived', 'Gallery archive record missing');
  await request('POST', `/admin/archive/${galleryArchive.id}/restore`, { token: adminToken, json: {}, expectedStatus: 200 });
  const galleryAfterRestore = await request('GET', '/gallery', { expectedStatus: 200 });
  assert((galleryAfterRestore.items || []).some((item) => item.id === createdGalleryItem.id), 'Restored gallery item did not return to active data');
  const restoredArchives = await request('GET', '/admin/archive?status=restored', { token: adminToken });
  assert((restoredArchives.items || []).some((item) => item.id === galleryArchive.id), 'Restored archive history is not searchable');
  const restoredHistory = await request('GET', `/admin/archive/history?archiveId=${galleryArchive.id}`, { token: adminToken });
  assert((restoredHistory.items || []).some((item) => item.action === 'restore'), 'Archive restore history is missing');
  await request('DELETE', `/admin/gallery/${createdGalleryItem.id}`, { token: adminToken, expectedStatus: 200 });

  const slotsRes = await request('GET', '/scheduling/slots', { token: memberToken, expectedStatus: 200 });
  const semestersRes = await request('GET', '/scheduling/semesters', { token: memberToken, expectedStatus: 200 });
  assert(Array.isArray(slotsRes.items) && slotsRes.items.length > 0, 'Scheduling slots empty');
  assert(Array.isArray(semestersRes.items) && semestersRes.items.length > 0, 'Scheduling semesters empty');
  await request('POST', '/scheduling/preferences', {
    token: memberToken,
    json: {
      semesterId: slotsRes.semesterId,
      slotIds: slotsRes.items.slice(0, 5).map((item) => item.id)
    },
    expectedStatus: 200
  });
  await request('POST', '/admin/scheduling/run', {
    token: adminToken,
    json: { semesterId: slotsRes.semesterId },
    expectedStatus: 201
  });
  const proposed = await request('GET', `/admin/scheduling/proposed?semesterId=${slotsRes.semesterId}`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(Array.isArray(proposed.assignments), 'Proposed assignments missing');
  await request('POST', '/admin/scheduling/publish', {
    token: adminToken,
    json: { semesterId: slotsRes.semesterId },
    expectedStatus: 200
  });
  const myAssignment = await request('GET', `/scheduling/my-assignment?semesterId=${slotsRes.semesterId}`, {
    token: memberToken,
    expectedStatus: 200
  });
  assert(Array.isArray(myAssignment.assignments), 'My assignment endpoint invalid');

  const prioritySemester = await request('POST', '/admin/semesters', {
    token: adminToken,
    json: {
      name: `Smoke Priority ${suffix}`,
      startDate: '2026-03-01',
      endDate: '2026-07-01',
      activate: false
    },
    expectedStatus: 201
  });
  const prioritySemesterId = prioritySemester.id;
  const adminSemesters = await request('GET', '/admin/semesters', {
    token: adminToken,
    expectedStatus: 200
  });
  assert((adminSemesters.items || []).some((item) => item.id === prioritySemesterId), 'Admin semester list missing created semester');
  const updatedPrioritySemester = await request('PATCH', `/admin/semesters/${prioritySemesterId}`, {
    token: adminToken,
    json: {
      name: `Smoke Priority ${suffix} Updated`,
      startDate: '2026-03-02',
      endDate: '2026-07-02',
      activate: false
    },
    expectedStatus: 200
  });
  assert(updatedPrioritySemester.item.name.endsWith('Updated'), 'Semester update did not persist');
  const duplicateSemester = await request('POST', '/admin/semesters', {
    token: adminToken,
    json: {
      name: `Smoke Priority ${suffix} Updated`,
      startDate: '2026-08-01',
      endDate: '2026-12-01',
      activate: false
    },
    expectedStatus: 409
  });
  assert(
    duplicateSemester.message.includes('already exists'),
    'Duplicate semester error message should be user-friendly'
  );
  const noPrefsSemester = await request('POST', '/admin/semesters', {
    token: adminToken,
    json: {
      name: `Smoke Empty ${suffix}`,
      startDate: '2026-08-01',
      endDate: '2026-12-31',
      activate: false
    },
    expectedStatus: 201
  });
  const emptyProposed = await request('GET', `/admin/scheduling/proposed?semesterId=${noPrefsSemester.id}`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(
    Number(emptyProposed.preferenceSummary?.membersWithPreferences || 0) === 0,
    'Scheduling overview should report zero preference submissions for empty semester'
  );
  const noPrefsRun = await request('POST', '/admin/scheduling/run', {
    token: adminToken,
    json: { semesterId: noPrefsSemester.id },
    expectedStatus: 400
  });
  assert(
    noPrefsRun.message === 'No member preferences found for this semester',
    'Scheduling run without preferences should keep the core validation message'
  );
  await request('DELETE', `/admin/semesters/${noPrefsSemester.id}`, {
    token: adminToken,
    expectedStatus: 200
  });

  const prioritySlots = await request('GET', `/scheduling/slots?semesterId=${prioritySemesterId}`, {
    token: memberToken,
    expectedStatus: 200
  });
  const contestedSlotId = prioritySlots.items[0].id;
  const contestedSlot = prioritySlots.items[0];
  const parallelSlot = prioritySlots.items.find(
    (item) => item.dayOfWeek === contestedSlot.dayOfWeek
      && item.hour === contestedSlot.hour
      && item.id !== contestedSlot.id
  );
  assert(parallelSlot, 'Parallel piano room slot missing for conflict validation');
  await request('POST', '/scheduling/preferences', {
    token: memberToken,
    json: {
      semesterId: prioritySemesterId,
      slotIds: [contestedSlotId],
      classMatchingPriority: true
    },
    expectedStatus: 200
  });
  const prioritySlotsReloaded = await request('GET', `/scheduling/slots?semesterId=${prioritySemesterId}`, {
    token: memberToken,
    expectedStatus: 200
  });
  assert(prioritySlotsReloaded.classMatchingPriority === true, 'Scheduling priority flag not returned');
  const plainSchedulingMember = await registerMemberAccount({
    studentNumber: `P${String(suffix).slice(-6)}`,
    displayName: `普通排班成员${String(suffix).slice(-3)}`,
    email: `plain-scheduling-${suffix}@example.com`
  });
  await request('POST', '/scheduling/preferences', {
    token: plainSchedulingMember.token,
    json: {
      semesterId: prioritySemesterId,
      slotIds: [contestedSlotId, parallelSlot.id],
      classMatchingPriority: false
    },
    expectedStatus: 200
  });
  await request('POST', '/admin/scheduling/run', {
    token: adminToken,
    json: { semesterId: prioritySemesterId },
    expectedStatus: 201
  });
  const priorityDraft = await request('GET', `/admin/scheduling/proposed?semesterId=${prioritySemesterId}`, {
    token: adminToken,
    expectedStatus: 200
  });
  const priorityUserId = profileAfterUpload.userId || profileAfterUpload.id;
  assert(
    (priorityDraft.assignments || []).some((item) => item.userId === priorityUserId && item.slotId === contestedSlotId),
    'Class matching priority user did not receive the contested first slot'
  );
  assert(
    (priorityDraft.assignments || []).filter((item) => item.slotId === contestedSlotId).length === 1,
    'Non-priority user should not receive the contested first slot'
  );
  await request('POST', '/scheduling/preferences', {
    token: plainSchedulingMember.token,
    json: {
      semesterId: prioritySemesterId,
      slotIds: [],
      classMatchingPriority: false
    },
    expectedStatus: 200
  });
  const staleCleanup = await request('POST', '/admin/scheduling/update', {
    token: adminToken,
    json: { semesterId: prioritySemesterId },
    expectedStatus: 201
  });
  assert(staleCleanup.removedStaleAssignments >= 1, 'Piano Time update should remove stale assignments');
  const priorityDraftAfterCleanup = await request('GET', `/admin/scheduling/proposed?semesterId=${prioritySemesterId}`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(
    !(priorityDraftAfterCleanup.assignments || []).some((item) => item.userId === plainSchedulingMember.userId),
    'Member without current preferences retained a stale Piano Time assignment'
  );
  const sameTimePianoConflict = await request('POST', '/admin/scheduling/assignments', {
    token: adminToken,
    json: {
      batchId: priorityDraftAfterCleanup.batch.id,
      userId: priorityUserId,
      slotId: parallelSlot.id
    },
    expectedStatus: 409
  });
  assert(
    sameTimePianoConflict.message.includes('already has a Piano Time assignment'),
    'A member must not occupy two rooms at the same time'
  );

  await request('POST', '/admin/scheduling/publish', {
    token: adminToken,
    json: { semesterId: prioritySemesterId },
    expectedStatus: 200
  });
  const replacementPianoSlot = prioritySlots.items[prioritySlots.items.length - 1];
  await request('POST', '/scheduling/preferences', {
    token: memberToken,
    json: {
      semesterId: prioritySemesterId,
      slotIds: [replacementPianoSlot.id],
      classMatchingPriority: true
    },
    expectedStatus: 200
  });
  await request('POST', '/admin/scheduling/run', {
    token: adminToken,
    json: { semesterId: prioritySemesterId },
    expectedStatus: 201
  });
  const priorityDraftForClass = await request('GET', `/admin/scheduling/proposed?semesterId=${prioritySemesterId}`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(
    (priorityDraftForClass.assignments || []).some((item) => Number(item.slotId) === Number(replacementPianoSlot.id)),
    'Replacement Piano Time proposal was not generated'
  );
  const effectivePianoRoomIds = new Set([
    ...(priorityDraftAfterCleanup.assignments || []).map((item) => Number(item.slotId)),
    ...(priorityDraftForClass.assignments || []).map((item) => Number(item.slotId))
  ]);

  const classTermCreate = await request('POST', '/admin/class-matching/terms', {
    token: adminToken,
    json: {
      semesterId: prioritySemesterId,
      name: `2026春季琴课匹配-${suffix}`,
      startDate: '2026-03-01',
      endDate: '2026-06-30',
      activate: true
    },
    expectedStatus: 201
  });
  const classTermId = classTermCreate.id;
  const stringActivateTerm = await request('POST', '/admin/class-matching/terms', {
    token: adminToken,
    json: {
      semesterId: prioritySemesterId,
      name: `非法布尔值-${suffix}`,
      startDate: '2026-03-01',
      endDate: '2026-06-30',
      activate: 'false'
    },
    expectedStatus: 400
  });
  assert(stringActivateTerm.message === 'Invalid class matching term payload', 'String boolean should be rejected');
  const invalidDateTerm = await request('POST', '/admin/class-matching/terms', {
    token: adminToken,
    json: {
      semesterId: prioritySemesterId,
      name: `非法日期-${suffix}`,
      startDate: '2026-02-31',
      endDate: '2026-06-30',
      activate: false
    },
    expectedStatus: 400
  });
  assert(invalidDateTerm.message === 'Invalid class matching term payload', 'Invalid calendar date should be rejected');
  const extraClassTerm = await request('POST', '/admin/class-matching/terms', {
    token: adminToken,
    json: {
      semesterId: prioritySemesterId,
      name: `备用学期-${suffix}`,
      startDate: '2026-09-01',
      endDate: '2026-12-31',
      activate: false
    },
    expectedStatus: 201
  });
  await request('PATCH', `/admin/class-matching/terms/${classTermId}`, {
    token: adminToken,
    json: {
      semesterId: prioritySemesterId,
      name: `2026春季琴课匹配-${suffix}-更新`,
      startDate: '2026-03-02',
      endDate: '2026-06-30',
      activate: true
    },
    expectedStatus: 200
  });
  const duplicateClassTerm = await request('POST', '/admin/class-matching/terms', {
    token: adminToken,
    json: {
      semesterId: prioritySemesterId,
      name: `2026春季琴课匹配-${suffix}-更新`,
      startDate: '2026-07-01',
      endDate: '2026-09-01',
      activate: false
    },
    expectedStatus: 409
  });
  assert(
    duplicateClassTerm.message.includes('already exists'),
    'Duplicate class matching term error message should be user-friendly'
  );
  await request('DELETE', `/admin/class-matching/terms/${extraClassTerm.id}`, {
    token: adminToken,
    expectedStatus: 200
  });
  const classTerms = await request('GET', '/class-matching/terms', {
    token: memberToken,
    expectedStatus: 200
  });
  assert(
    (classTerms.items || []).some((item) => item.id === classTermId),
    'Class matching term list missing created term'
  );

  const lockedStudent = await registerMemberAccount({
    studentNumber: `CM${String(suffix).slice(-5)}1`,
    displayName: `锁定学生${String(suffix).slice(-3)}`,
    email: `cm-locked-student-${suffix}@example.com`
  });
  const lockedTeacher = await registerMemberAccount({
    studentNumber: `CM${String(suffix).slice(-5)}2`,
    displayName: `锁定教师${String(suffix).slice(-3)}`,
    email: `cm-locked-teacher-${suffix}@example.com`
  });
  const rankedStudentA = await registerMemberAccount({
    studentNumber: `CM${String(suffix).slice(-5)}3`,
    displayName: `排序学生A${String(suffix).slice(-3)}`,
    email: `cm-ranked-student-a-${suffix}@example.com`
  });
  const rankedStudentB = await registerMemberAccount({
    studentNumber: `CM${String(suffix).slice(-5)}4`,
    displayName: `排序学生B${String(suffix).slice(-3)}`,
    email: `cm-ranked-student-b-${suffix}@example.com`
  });
  const incrementalStudent = await registerMemberAccount({
    studentNumber: `CM${String(suffix).slice(-5)}5`,
    displayName: `增量学生${String(suffix).slice(-3)}`,
    email: `cm-incremental-student-${suffix}@example.com`
  });
  const rankedTeacherA = await registerMemberAccount({
    studentNumber: `CM${String(suffix).slice(-5)}6`,
    displayName: `排序教师A${String(suffix).slice(-3)}`,
    email: `cm-ranked-teacher-a-${suffix}@example.com`
  });
  const rankedTeacherB = await registerMemberAccount({
    studentNumber: `CM${String(suffix).slice(-5)}7`,
    displayName: `排序教师B${String(suffix).slice(-3)}`,
    email: `cm-ranked-teacher-b-${suffix}@example.com`
  });
  const incrementalTeacher = await registerMemberAccount({
    studentNumber: `CM${String(suffix).slice(-5)}8`,
    displayName: `增量教师${String(suffix).slice(-3)}`,
    email: `cm-incremental-teacher-${suffix}@example.com`
  });
  const unrankedStudent = await registerMemberAccount({
    studentNumber: `CM${String(suffix).slice(-5)}9`,
    displayName: `未排序学生${String(suffix).slice(-3)}`,
    email: `cm-unranked-student-${suffix}@example.com`
  });
  const unrankedTeacher = await registerMemberAccount({
    studentNumber: `CM${String(suffix).slice(-5)}0`,
    displayName: `未排序教师${String(suffix).slice(-3)}`,
    email: `cm-unranked-teacher-${suffix}@example.com`
  });

  const lockedStudentProfile = await request('PUT', '/class-matching/profile', {
    token: lockedStudent.token,
    json: {
      termId: classTermId,
      participantType: 'student',
      matchingMode: 'direct',
      skillLevel: '基础较稳\n已学琴五年',
      learningGoals: '找固定老师补基础\n希望稳定上课',
      budgetExpectation: '100'
    },
    expectedStatus: 200
  });
  assert(
    lockedStudentProfile.profile.skillLevel === '基础较稳\n已学琴五年',
    'Class matching skill level newline was not preserved'
  );
  await request('PUT', '/class-matching/profile', {
    token: lockedTeacher.token,
    json: {
      termId: classTermId,
      participantType: 'teacher',
      matchingMode: 'direct',
      teachingExperience: '两年教学经验\n有陪练经历',
      skillSpecialization: '古典基础\n视奏训练',
      feeExpectation: '120',
      capacity: 1,
      directTargetUserId: lockedStudent.userId
    },
    expectedStatus: 200
  });
  await request('PUT', '/class-matching/profile', {
    token: rankedStudentA.token,
    json: {
      termId: classTermId,
      participantType: 'student',
      matchingMode: 'ranking',
      skillLevel: '中级',
      learningGoals: '提升技术',
      budgetExpectation: '100'
    },
    expectedStatus: 200
  });
  await request('PUT', '/class-matching/profile', {
    token: rankedStudentB.token,
    json: {
      termId: classTermId,
      participantType: 'student',
      matchingMode: 'ranking',
      skillLevel: '初级',
      learningGoals: '系统入门',
      budgetExpectation: '90'
    },
    expectedStatus: 200
  });
  await request('PUT', '/class-matching/profile', {
    token: rankedTeacherA.token,
    json: {
      termId: classTermId,
      participantType: 'teacher',
      matchingMode: 'ranking',
      teachingExperience: '擅长基础训练',
      skillSpecialization: '古典基本功',
      feeExpectation: '150',
      capacity: 1
    },
    expectedStatus: 200
  });
  await request('PUT', '/class-matching/profile', {
    token: rankedTeacherB.token,
    json: {
      termId: classTermId,
      participantType: 'teacher',
      matchingMode: 'ranking',
      teachingExperience: '擅长伴奏训练',
      skillSpecialization: '伴奏与即兴',
      feeExpectation: '140',
      capacity: 1
    },
    expectedStatus: 200
  });
  await request('PUT', '/class-matching/profile', {
    token: incrementalTeacher.token,
    json: {
      termId: classTermId,
      participantType: 'teacher',
      matchingMode: 'ranking',
      teachingExperience: '增量教师\n可接受手动改派',
      skillSpecialization: '视奏',
      feeExpectation: '130',
      capacity: 2
    },
    expectedStatus: 200
  });
  await request('PUT', '/class-matching/profile', {
    token: unrankedStudent.token,
    json: {
      termId: classTermId,
      participantType: 'student',
      matchingMode: 'ranking',
      learningGoals: '验证未列入排序仍属于低优先级候选'
    },
    expectedStatus: 200
  });
  await request('PUT', '/class-matching/profile', {
    token: unrankedTeacher.token,
    json: {
      termId: classTermId,
      participantType: 'teacher',
      matchingMode: 'ranking',
      capacity: 1,
      teachingExperience: '未排序候选验证'
    },
    expectedStatus: 200
  });

  await request('PATCH', `/admin/class-matching/terms/${classTermId}/teachers/${lockedTeacher.userId}/qualification`, {
    token: adminToken,
    json: {
      status: 'approved',
      feedback: '可参与直接互选'
    },
    expectedStatus: 200
  });
  await request('PATCH', `/admin/class-matching/terms/${classTermId}/teachers/${rankedTeacherA.userId}/qualification`, {
    token: adminToken,
    json: {
      status: 'approved',
      feedback: '可参与排序匹配'
    },
    expectedStatus: 200
  });
  await request('PATCH', `/admin/class-matching/terms/${classTermId}/teachers/${rankedTeacherB.userId}/qualification`, {
    token: adminToken,
    json: {
      status: 'approved',
      feedback: '可参与排序匹配'
    },
    expectedStatus: 200
  });
  await request('PATCH', `/admin/class-matching/terms/${classTermId}/teachers/${incrementalTeacher.userId}/qualification`, {
    token: adminToken,
    json: {
      status: 'approved',
      feedback: '可参与增量匹配'
    },
    expectedStatus: 200
  });
  await request('PATCH', `/admin/class-matching/terms/${classTermId}/teachers/${unrankedTeacher.userId}/qualification`, {
    token: adminToken,
    json: {
      status: 'approved',
      feedback: '验证省略排序代表较低偏好'
    },
    expectedStatus: 200
  });

  await request('PUT', '/class-matching/profile', {
    token: lockedStudent.token,
    json: {
      termId: classTermId,
      participantType: 'student',
      matchingMode: 'direct',
      directTargetUserId: lockedTeacher.userId,
      skillLevel: '基础较稳\n已学琴五年',
      learningGoals: '找固定老师补基础\n希望稳定上课',
      budgetExpectation: '100'
    },
    expectedStatus: 200
  });

  const classOverviewStudent = await request('GET', `/class-matching/overview?termId=${classTermId}`, {
    token: rankedStudentA.token,
    expectedStatus: 200
  });
  assert(classOverviewStudent.baseProfile.studentNumber === rankedStudentA.studentNumber, 'Class matching base profile mismatch');
  assert(Array.isArray(classOverviewStudent.slots) && classOverviewStudent.slots.length === 98, 'Class matching slots should contain 98 weekly hours');

  const slotIdsFor = (...indexes) => indexes.map((index) => classOverviewStudent.slots[index].id);
  const lockedOverlap = slotIdsFor(0, 1);
  const studentAOverlap = slotIdsFor(2, 3, 4);
  const studentBOverlap = slotIdsFor(5, 6, 7);
  const teacherAOverlap = slotIdsFor(2, 3, 4);
  const teacherBOverlap = slotIdsFor(5, 6, 7);
  const incrementalOverlap = slotIdsFor(8, 9);
  const unrankedOverlap = slotIdsFor(10, 11);

  await request('POST', '/class-matching/availability', {
    token: lockedStudent.token,
    json: { termId: classTermId, slotIds: lockedOverlap },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: lockedTeacher.token,
    json: { termId: classTermId, slotIds: lockedOverlap },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: rankedStudentA.token,
    json: { termId: classTermId, slotIds: studentAOverlap },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: rankedStudentB.token,
    json: { termId: classTermId, slotIds: studentBOverlap },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: rankedTeacherA.token,
    json: { termId: classTermId, slotIds: teacherAOverlap },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: rankedTeacherB.token,
    json: { termId: classTermId, slotIds: teacherBOverlap },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: incrementalTeacher.token,
    json: { termId: classTermId, slotIds: lockedOverlap },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: unrankedStudent.token,
    json: { termId: classTermId, slotIds: unrankedOverlap },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: unrankedTeacher.token,
    json: { termId: classTermId, slotIds: unrankedOverlap },
    expectedStatus: 200
  });

  const invalidRankingTarget = await request('POST', '/class-matching/rankings', {
    token: rankedStudentA.token,
    json: { termId: classTermId, targetUserIds: [lockedTeacher.userId] },
    expectedStatus: 400
  });
  assert(
    invalidRankingTarget.message === 'Ranking targets must also use ranking mode in this term',
    'Direct-mode teacher should not be accepted as a ranking target'
  );
  const directModeRankingAttempt = await request('POST', '/class-matching/rankings', {
    token: lockedStudent.token,
    json: { termId: classTermId, targetUserIds: [rankedTeacherA.userId] },
    expectedStatus: 400
  });
  assert(
    directModeRankingAttempt.message === 'Ranking preferences are only available in ranking mode',
    'Direct-mode participant ranking submission should be rejected'
  );

  await request('POST', '/class-matching/rankings', {
    token: rankedStudentA.token,
    json: { termId: classTermId, targetUserIds: [rankedTeacherA.userId, rankedTeacherB.userId] },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/rankings', {
    token: rankedStudentB.token,
    json: { termId: classTermId, targetUserIds: [rankedTeacherA.userId, rankedTeacherB.userId] },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/rankings', {
    token: rankedTeacherA.token,
    json: { termId: classTermId, targetUserIds: [rankedStudentA.userId, rankedStudentB.userId] },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/rankings', {
    token: rankedTeacherB.token,
    json: { termId: classTermId, targetUserIds: [rankedStudentB.userId, rankedStudentA.userId] },
    expectedStatus: 200
  });

  const adminClassOverviewBefore = await request('GET', `/admin/class-matching/terms/${classTermId}/overview`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(adminClassOverviewBefore.summary.participantCount === 9, 'Class matching participant count before incremental is invalid');
  assert(adminClassOverviewBefore.summary.approvedTeacherCount === 5, 'Approved teacher count mismatch');

  const generatedVersion = await request('POST', `/admin/class-matching/terms/${classTermId}/generate`, {
    token: adminToken,
    json: { changeSummary: 'Smoke stable matching generation' },
    expectedStatus: 201
  });
  assert(generatedVersion.version.versionNumber === 1, 'Initial class matching version number should be 1');
  assert(
    generatedVersion.matches.some(
      (item) =>
        item.studentUserId === lockedStudent.userId
        && item.teacherUserId === lockedTeacher.userId
        && item.matchType === 'locked'
    ),
    'Locked direct match missing from generated version'
  );
  assert(
    generatedVersion.matches.some(
      (item) =>
        item.studentUserId === rankedStudentA.userId
        && item.teacherUserId === rankedTeacherA.userId
        && item.matchType === 'algorithm'
    ),
    'Student A should be matched to ranked teacher A by algorithm'
  );
  assert(
    generatedVersion.matches.some(
      (item) =>
        item.studentUserId === rankedStudentB.userId
        && item.teacherUserId === rankedTeacherB.userId
        && item.matchType === 'algorithm'
    ),
    'Student B should be matched to ranked teacher B by algorithm'
  );
  assert(
    generatedVersion.matches.some(
      (item) => item.studentUserId === unrankedStudent.userId && item.teacherUserId === unrankedTeacher.userId
    ),
    'Omitted rankings should remain eligible as lower-preference candidates'
  );
  const generatedRoomIds = generatedVersion.matches.map((item) => Number(item.roomSlotId));
  assert(generatedRoomIds.every((id) => Number.isInteger(id) && id > 0), 'Every class match must reserve a room slot');
  assert(new Set(generatedRoomIds).size === generatedRoomIds.length, 'Class matches reused a room slot');
  assert(
    generatedRoomIds.every((id) => !effectivePianoRoomIds.has(id)),
    'Class Matching used a room reserved by the latest published or proposed Piano Time batch'
  );
  const noSharedAvailability = await request('POST', `/admin/class-matching/terms/${classTermId}/manual`, {
    token: adminToken,
    json: {
      studentUserId: rankedStudentA.userId,
      teacherUserId: incrementalTeacher.userId,
      changeSummary: 'Reject no-overlap manual match'
    },
    expectedStatus: 409
  });
  assert(
    noSharedAvailability.message.includes('No shared conflict-free'),
    'Manual match without shared availability should be rejected'
  );
  const classReservedRoomId = generatedRoomIds.find((id) => !effectivePianoRoomIds.has(id));
  const pianoCannotTakeClassRoom = await request('POST', '/admin/scheduling/assignments', {
    token: adminToken,
    json: {
      batchId: priorityDraftForClass.batch.id,
      userId: plainSchedulingMember.userId,
      slotId: classReservedRoomId
    },
    expectedStatus: 409
  });
  assert(
    pianoCannotTakeClassRoom.message.includes('reserved by the current Class Matching'),
    'Additional Piano Time assignment displaced a Class Matching room'
  );
  const lockedManualClear = await request('POST', `/admin/class-matching/terms/${classTermId}/manual`, {
    token: adminToken,
    json: {
      studentUserId: lockedStudent.userId,
      teacherUserId: null,
      notes: 'Smoke locked clear attempt',
      changeSummary: 'Smoke locked clear attempt'
    },
    expectedStatus: 409
  });
  assert(
    lockedManualClear.message.includes('cannot be cleared manually'),
    'Locked direct matches should explain why clear is rejected'
  );
  const lockedManualOverride = await request('POST', `/admin/class-matching/terms/${classTermId}/manual`, {
    token: adminToken,
    json: {
      studentUserId: lockedStudent.userId,
      teacherUserId: incrementalTeacher.userId,
      notes: 'Smoke locked override\nPreserve manual priority',
      changeSummary: 'Smoke manual override for locked pair'
    },
    expectedStatus: 201
  });
  assert(lockedManualOverride.version.versionNumber === 2, 'Locked manual override version number should be 2');
  assert(
    lockedManualOverride.matches.some(
      (item) =>
        item.studentUserId === lockedStudent.userId
        && item.teacherUserId === incrementalTeacher.userId
        && item.matchType === 'manual'
    ),
    'Manual override should replace the locked pair in the current version'
  );

  await request('PUT', '/class-matching/profile', {
    token: incrementalStudent.token,
    json: {
      termId: classTermId,
      participantType: 'student',
      matchingMode: 'ranking',
      skillLevel: '中级',
      learningGoals: '找一位视奏老师',
      budgetExpectation: '95'
    },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: incrementalStudent.token,
    json: { termId: classTermId, slotIds: incrementalOverlap },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: incrementalTeacher.token,
    json: { termId: classTermId, slotIds: [...lockedOverlap, ...incrementalOverlap] },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/rankings', {
    token: incrementalStudent.token,
    json: { termId: classTermId, targetUserIds: [incrementalTeacher.userId] },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/rankings', {
    token: incrementalTeacher.token,
    json: { termId: classTermId, targetUserIds: [incrementalStudent.userId] },
    expectedStatus: 200
  });
  await request('POST', '/class-matching/availability', {
    token: rankedTeacherB.token,
    json: { termId: classTermId, slotIds: slotIdsFor(12) },
    expectedStatus: 200
  });

  const incrementalVersion = await request('POST', `/admin/class-matching/terms/${classTermId}/incremental`, {
    token: adminToken,
    json: { changeSummary: 'Smoke incremental matching' },
    expectedStatus: 201
  });
  assert(incrementalVersion.version.versionNumber === 3, 'Incremental version number should be 3');
  assert(
    Number(incrementalVersion.revalidation?.dropped || 0) >= 1,
    'Incremental regeneration should report invalidated preserved matches'
  );
  assert(
    !incrementalVersion.matches.some((item) => item.studentUserId === rankedStudentB.userId),
    'Incremental regeneration retained a match without shared availability'
  );
  assert(
    incrementalVersion.matches.some(
      (item) =>
        item.studentUserId === incrementalStudent.userId
        && item.teacherUserId === incrementalTeacher.userId
    ),
    'Incremental student should be matched to incremental teacher'
  );
  assert(
    incrementalVersion.matches.some(
      (item) =>
        item.studentUserId === lockedStudent.userId
        && item.teacherUserId === incrementalTeacher.userId
        && item.matchType === 'manual'
    ),
    'Incremental matching should keep the manual locked override unchanged'
  );
  assert(
    incrementalVersion.matches.some(
      (item) =>
        item.studentUserId === rankedStudentA.userId
        && item.teacherUserId === rankedTeacherA.userId
    ),
    'Incremental matching should keep existing student A match unchanged'
  );

  const manualVersion = await request('POST', `/admin/class-matching/terms/${classTermId}/manual`, {
    token: adminToken,
    json: {
      studentUserId: incrementalStudent.userId,
      teacherUserId: null,
      notes: 'Smoke manual clear',
      changeSummary: 'Smoke manual adjustment'
    },
    expectedStatus: 201
  });
  assert(manualVersion.version.versionNumber === 4, 'Manual version number should be 4');
  assert(
    !manualVersion.matches.some((item) => item.studentUserId === incrementalStudent.userId),
    'Manual adjustment should remove incremental student match'
  );

  const compareResult = await request('GET', `/admin/class-matching/terms/${classTermId}/compare?fromVersionId=${incrementalVersion.version.id}&toVersionId=${manualVersion.version.id}`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(compareResult.removed.length === 1, 'Version comparison should report one removed match after manual clear');

  const restoreVersion = await request('POST', `/admin/class-matching/terms/${classTermId}/versions/${incrementalVersion.version.id}/restore`, {
    token: adminToken,
    json: { changeSummary: 'Smoke restore incremental version' },
    expectedStatus: 201
  });
  assert(restoreVersion.version.versionNumber === 5, 'Restore version number should be 5');
  assert(
    restoreVersion.matches.some((item) => item.studentUserId === incrementalStudent.userId),
    'Restored version should recover incremental student match'
  );

  const versionList = await request('GET', `/admin/class-matching/terms/${classTermId}/versions`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert((versionList.items || []).length === 5, 'Class matching version history length is invalid');
  const versionDetail = await request('GET', `/admin/class-matching/terms/${classTermId}/versions/${restoreVersion.version.id}`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(versionDetail.matches.length === restoreVersion.matches.length, 'Version detail match count mismatch');

  const classCsv = await download('GET', `/admin/class-matching/terms/${classTermId}/export`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(classCsv.includes(`2026春季琴课匹配-${suffix}-更新`), 'Class matching CSV should include term name');
  assert(classCsv.includes('学生学号'), 'Class matching CSV header mismatch');
  assert(classCsv.includes(incrementalStudent.studentNumber), 'Class matching CSV missing restored incremental student');

  const adminClassOverviewAfter = await request('GET', `/admin/class-matching/terms/${classTermId}/overview`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(adminClassOverviewAfter.summary.participantCount === 10, 'Class matching participant count after incremental is invalid');
  assert(adminClassOverviewAfter.currentVersion.versionNumber === 5, 'Current class matching version should be restored version');
  const incompatibleDirectTarget = await request('PUT', '/class-matching/profile', {
    token: rankedStudentA.token,
    json: {
      termId: classTermId,
      participantType: 'student',
      matchingMode: 'direct',
      directTargetUserId: rankedTeacherA.userId
    },
    expectedStatus: 400
  });
  assert(/also use direct mode/i.test(incompatibleDirectTarget.message), 'Direct-to-ranking target mismatch was not rejected');
  await request('PUT', '/class-matching/profile', {
    token: rankedTeacherA.token,
    json: {
      termId: classTermId,
      participantType: 'teacher',
      matchingMode: 'direct',
      directTargetUserId: null
    },
    expectedStatus: 200
  });
  await request('PUT', '/class-matching/profile', {
    token: rankedStudentA.token,
    json: {
      termId: classTermId,
      participantType: 'student',
      matchingMode: 'direct',
      directTargetUserId: rankedTeacherA.userId
    },
    expectedStatus: 200
  });
  await request('PUT', '/class-matching/profile', {
    token: rankedTeacherA.token,
    json: {
      termId: classTermId,
      participantType: 'teacher',
      matchingMode: 'ranking'
    },
    expectedStatus: 409
  });
  const clearedRankings = db
    .prepare(
      `SELECT COUNT(*) AS count
       FROM class_matching_rankings
       WHERE term_id = ? AND user_id = ?`
    )
    .get(classTermId, rankedStudentA.userId);
  assert(Number(clearedRankings?.count || 0) === 0, 'Switching to direct mode should clear persisted rankings');

  const activityCreateForm = new FormData();
  activityCreateForm.append('title', `烟测活动-${suffix}`);
  activityCreateForm.append('content', '用于自动化测试的活动内容');
  activityCreateForm.append('eventTime', '2026-03-01T17:30:00');
  activityCreateForm.append('location', '大活325');
  activityCreateForm.append('attachmentFiles', new Blob([noteBuffer], { type: 'text/plain' }), activityTextName);
  activityCreateForm.append('attachmentFiles', new Blob([imageBuffer], { type: 'image/jpeg' }), activityImageName);
  activityCreateForm.append(
    'attachmentFiles',
    new Blob([xlsxBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    activitySheetName
  );
  const createdActivity = await request('POST', '/admin/activities', {
    token: adminToken,
    form: activityCreateForm,
    expectedStatus: 201
  });
  assert(createdActivity.eventTime === '2026-03-01T09:30:00.000Z', `Activity event time UTC conversion failed: ${createdActivity.eventTime}`);
  assertUtcIso(createdActivity.createdAt, 'Activity createdAt should be UTC ISO');
  assertUtcIso(createdActivity.updatedAt, 'Activity updatedAt should be UTC ISO');
  assertUtcIso(createdActivity.publishedAt, 'Activity publishedAt should be UTC ISO');
  assert((createdActivity.attachments || []).length === 3, 'Activity attachments not saved');
  assert(createdActivity.attachments[0].originalName === activityTextName, 'Activity text filename not preserved');
  assert(
    (createdActivity.attachments || []).some((item) => item.originalName === activitySheetName),
    'Activity xlsx filename not preserved'
  );
  const activityAttachmentDiskPath = attachmentDiskPath(createdActivity.attachments[0].id);
  assert(fs.existsSync(activityAttachmentDiskPath), 'Activity attachment file missing on disk');
  const activityDownload = await downloadBuffer(createdActivity.attachments[0].downloadUrl);
  assert(activityDownload.body.equals(noteBuffer), 'Activity download content mismatch');
  assert(
    activityDownload.disposition.includes(`filename*=UTF-8''${encodeURIComponent(activityTextName)}`),
    'Activity download filename mismatch'
  );

  const activityPatchForm = new FormData();
  activityPatchForm.append('title', '烟测活动-更新');
  activityPatchForm.append('content', '用于自动化测试的活动内容-更新');
  activityPatchForm.append('isPublished', 'true');
  activityPatchForm.append('removeAttachmentIds', String(createdActivity.attachments[0].id));
  activityPatchForm.append('attachmentFiles', new Blob([pdfBuffer], { type: 'application/pdf' }), activityPdfName);
  const updatedActivity = await request('PATCH', `/admin/activities/${createdActivity.id}`, {
    token: adminToken,
    form: activityPatchForm,
    expectedStatus: 200
  });
  assert(updatedActivity.eventTime === '2026-03-01T09:30:00.000Z', 'Activity event time changed unexpectedly after update');
  assertUtcIso(updatedActivity.createdAt, 'Updated activity createdAt should stay UTC ISO');
  assertUtcIso(updatedActivity.updatedAt, 'Updated activity updatedAt should be UTC ISO');
  assertUtcIso(updatedActivity.publishedAt, 'Updated activity publishedAt should be UTC ISO');
  assert((updatedActivity.attachments || []).length === 3, 'Activity attachment update failed');
  assert(!fs.existsSync(activityAttachmentDiskPath), 'Removed activity attachment file still exists');
  const updatedActivityPdf = (updatedActivity.attachments || []).find((item) => item.originalName === activityPdfName);
  assert(updatedActivityPdf, 'Updated activity PDF missing');
  const updatedActivityPdfDownload = await downloadBuffer(updatedActivityPdf.downloadUrl);
  assert(updatedActivityPdfDownload.body.equals(pdfBuffer), 'Updated activity PDF corrupted');

  const activityReplaceTarget = (updatedActivity.attachments || []).find((item) => item.originalName === activitySheetName);
  assert(activityReplaceTarget, 'Activity attachment replacement target missing');
  const activityReplaceDiskPath = attachmentDiskPath(activityReplaceTarget.id);
  const activityReplaceForm = new FormData();
  activityReplaceForm.append('attachmentFile', new Blob([csvBuffer], { type: 'text/csv' }), activityReplacementName);
  const activityReplaceRes = await request('POST', `/admin/activities/${createdActivity.id}/attachments/${activityReplaceTarget.id}/replace`, {
    token: adminToken,
    form: activityReplaceForm,
    expectedStatus: 200
  });
  const activityAfterReplace = activityReplaceRes.item;
  const replacedActivityAttachment = (activityAfterReplace.attachments || []).find((item) => item.originalName === activityReplacementName);
  assert(replacedActivityAttachment, 'Replaced activity attachment missing');
  assert(!fs.existsSync(activityReplaceDiskPath), 'Old replaced activity attachment still exists');
  const replacedActivityDownload = await downloadBuffer(replacedActivityAttachment.downloadUrl);
  assert(replacedActivityDownload.body.equals(csvBuffer), 'Replaced activity attachment content mismatch');

  const activityDeleteTarget = (activityAfterReplace.attachments || []).find((item) => item.originalName === activityImageName);
  assert(activityDeleteTarget, 'Activity attachment delete target missing');
  const activityDeleteDiskPath = attachmentDiskPath(activityDeleteTarget.id);
  const activityDeleteRes = await request('DELETE', `/admin/activities/${createdActivity.id}/attachments/${activityDeleteTarget.id}`, {
    token: adminToken,
    expectedStatus: 200
  });
  const activityAfterAttachmentDelete = activityDeleteRes.item;
  assert((activityAfterAttachmentDelete.attachments || []).length === 2, 'Activity attachment delete failed');
  assert(!fs.existsSync(activityDeleteDiskPath), 'Deleted activity attachment still exists');
  await request('DELETE', `/admin/activities/${createdActivity.id}/attachments/${activityDeleteTarget.id}`, {
    token: adminToken,
    expectedStatus: 404
  });

  const publicActivities = await request('GET', '/activities', { expectedStatus: 200 });
  const publicActivity = (publicActivities.items || []).find((item) => item.id === createdActivity.id);
  assert(publicActivity && (publicActivity.attachments || []).length === 2, 'Public activities missing attachments');
  assert(publicActivity.eventTime === '2026-03-01T09:30:00.000Z', 'Public activity eventTime should stay UTC ISO');
  assertUtcIso(publicActivity.createdAt, 'Public activity createdAt should be UTC ISO');
  assertUtcIso(publicActivity.updatedAt, 'Public activity updatedAt should be UTC ISO');
  assertUtcIso(publicActivity.publishedAt, 'Public activity publishedAt should be UTC ISO');
  assert(
    (publicActivity.attachments || []).some((item) => item.originalName === activityReplacementName),
    'Public activity replacement filename not preserved'
  );

  const adminActivities = await request('GET', '/admin/activities', { token: adminToken, expectedStatus: 200 });
  const adminActivity = (adminActivities.items || []).find((item) => item.id === createdActivity.id);
  assert(adminActivity, 'Admin activity list missing created activity');
  assert(adminActivity.eventTime === '2026-03-01T09:30:00.000Z', 'Admin activity eventTime should be UTC ISO');
  assertUtcIso(adminActivity.createdAt, 'Admin activity createdAt should be UTC ISO');
  assertUtcIso(adminActivity.updatedAt, 'Admin activity updatedAt should be UTC ISO');
  assertUtcIso(adminActivity.publishedAt, 'Admin activity publishedAt should be UTC ISO');

  const announcementCreateForm = new FormData();
  announcementCreateForm.append('title', `  烟测公告-${suffix}  `);
  announcementCreateForm.append('content', '  用于自动化测试的公告内容  ');
  announcementCreateForm.append('isPublished', 'false');
  const createdAnnouncement = await request('POST', '/admin/announcements', {
    token: adminToken,
    form: announcementCreateForm,
    expectedStatus: 201
  });
  assert(createdAnnouncement.title === `烟测公告-${suffix}`, 'Announcement title was not trimmed correctly');
  assert(createdAnnouncement.content === '用于自动化测试的公告内容', 'Announcement content was not trimmed correctly');
  assert(createdAnnouncement.publishedAt === null, 'Draft announcement publishedAt should be null');
  assertUtcIso(createdAnnouncement.createdAt, 'Draft announcement createdAt should be UTC ISO');
  assertUtcIso(createdAnnouncement.updatedAt, 'Draft announcement updatedAt should be UTC ISO');
  assert((createdAnnouncement.attachments || []).length === 0, 'Announcement should allow creation without attachments');

  const announcementPatchForm = new FormData();
  announcementPatchForm.append('title', '烟测公告-更新');
  announcementPatchForm.append('content', '用于自动化测试的公告内容-更新');
  announcementPatchForm.append('isPublished', 'true');
  announcementPatchForm.append(
    'attachmentFiles',
    new Blob([imageBuffer], { type: 'image/jpeg' }),
    announcementImageName
  );
  announcementPatchForm.append(
    'attachmentFiles',
    new Blob([xlsxBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
    announcementSheetName
  );
  const updatedAnnouncement = await request('PATCH', `/admin/announcements/${createdAnnouncement.id}`, {
    token: adminToken,
    form: announcementPatchForm,
    expectedStatus: 200
  });
  assertUtcIso(updatedAnnouncement.createdAt, 'Published announcement createdAt should be UTC ISO');
  assertUtcIso(updatedAnnouncement.updatedAt, 'Published announcement updatedAt should be UTC ISO');
  assertUtcIso(updatedAnnouncement.publishedAt, 'Published announcement publishedAt should be UTC ISO');
  assert((updatedAnnouncement.attachments || []).length === 2, 'Announcement attachment update failed');
  const announcementAttachmentDiskPath = attachmentDiskPath(updatedAnnouncement.attachments[0].id);
  assert(fs.existsSync(announcementAttachmentDiskPath), 'Announcement attachment file missing on disk');
  const announcementSheet = (updatedAnnouncement.attachments || []).find((item) => item.originalName === announcementSheetName);
  assert(announcementSheet, 'Announcement xlsx attachment missing');
  const announcementSheetDownload = await downloadBuffer(announcementSheet.downloadUrl);
  assert(announcementSheetDownload.body.equals(xlsxBuffer), 'Announcement xlsx download corrupted');
  assert(
    announcementSheetDownload.disposition.includes(`filename*=UTF-8''${encodeURIComponent(announcementSheetName)}`),
    'Announcement xlsx filename mismatch'
  );

  const announcementReplaceDiskPath = attachmentDiskPath(announcementSheet.id);
  const announcementReplaceForm = new FormData();
  announcementReplaceForm.append('attachmentFile', new Blob([pdfBuffer], { type: 'application/pdf' }), announcementReplacementName);
  const announcementReplaceRes = await request(
    'POST',
    `/admin/announcements/${createdAnnouncement.id}/attachments/${announcementSheet.id}/replace`,
    {
      token: adminToken,
      form: announcementReplaceForm,
      expectedStatus: 200
    }
  );
  const announcementAfterReplace = announcementReplaceRes.item;
  const replacedAnnouncementAttachment = (announcementAfterReplace.attachments || []).find(
    (item) => item.originalName === announcementReplacementName
  );
  assert(replacedAnnouncementAttachment, 'Replaced announcement attachment missing');
  assert(!fs.existsSync(announcementReplaceDiskPath), 'Old replaced announcement attachment still exists');
  const replacedAnnouncementDownload = await downloadBuffer(replacedAnnouncementAttachment.downloadUrl);
  assert(replacedAnnouncementDownload.body.equals(pdfBuffer), 'Replaced announcement attachment content mismatch');

  const announcementDeleteTarget = (announcementAfterReplace.attachments || []).find((item) => item.originalName === announcementImageName);
  assert(announcementDeleteTarget, 'Announcement attachment delete target missing');
  const announcementDeleteDiskPath = attachmentDiskPath(announcementDeleteTarget.id);
  const announcementDeleteRes = await request(
    'DELETE',
    `/admin/announcements/${createdAnnouncement.id}/attachments/${announcementDeleteTarget.id}`,
    { token: adminToken, expectedStatus: 200 }
  );
  const announcementAfterAttachmentDelete = announcementDeleteRes.item;
  assert((announcementAfterAttachmentDelete.attachments || []).length === 1, 'Announcement attachment delete failed');
  assert(!fs.existsSync(announcementDeleteDiskPath), 'Deleted announcement attachment still exists');

  const publicAnnouncements = await request('GET', '/announcements', { expectedStatus: 200 });
  const publicAnnouncement = (publicAnnouncements.items || []).find((item) => item.id === createdAnnouncement.id);
  assert(publicAnnouncement && (publicAnnouncement.attachments || []).length === 1, 'Public announcements missing attachments');
  assertUtcIso(publicAnnouncement.createdAt, 'Public announcement createdAt should be UTC ISO');
  assertUtcIso(publicAnnouncement.updatedAt, 'Public announcement updatedAt should be UTC ISO');
  assertUtcIso(publicAnnouncement.publishedAt, 'Public announcement publishedAt should be UTC ISO');
  assert(
    (publicAnnouncement.attachments || []).some((item) => item.originalName === announcementReplacementName),
    'Public announcement replacement filename not preserved'
  );

  const adminAnnouncements = await request('GET', '/admin/announcements', { token: adminToken, expectedStatus: 200 });
  const adminAnnouncement = (adminAnnouncements.items || []).find((item) => item.id === createdAnnouncement.id);
  assert(adminAnnouncement, 'Admin announcements list missing created announcement');
  assertUtcIso(adminAnnouncement.createdAt, 'Admin announcement createdAt should be UTC ISO');
  assertUtcIso(adminAnnouncement.updatedAt, 'Admin announcement updatedAt should be UTC ISO');
  assertUtcIso(adminAnnouncement.publishedAt, 'Admin announcement publishedAt should be UTC ISO');

  const concertCreateForm = new FormData();
  concertCreateForm.append('title', `  烟测音乐会-${suffix}  `);
  concertCreateForm.append('description', '  烟测描述  ');
  concertCreateForm.append('announcement', '  烟测公告  ');
  concertCreateForm.append('applicationDeadline', '2099-03-10T12:00:00');
  concertCreateForm.append('status', 'open');
  concertCreateForm.append('attachmentFile', new Blob([imageBuffer], { type: 'image/jpeg' }), 'poster.jpg');
  const createdConcert = await request('POST', '/admin/concerts', {
    token: adminToken,
    form: concertCreateForm,
    expectedStatus: 201
  });
  const concertId = createdConcert.id;
  assert(concertId, 'Concert creation failed');
  assert(createdConcert.title === `烟测音乐会-${suffix}`, 'Concert title was not trimmed correctly');
  assert(createdConcert.description === '烟测描述', 'Concert description was not trimmed correctly');
  assert(createdConcert.applicationDeadline === '2099-03-10T04:00:00.000Z', 'Concert create deadline UTC conversion failed');
  assertUtcIso(createdConcert.createdAt, 'Concert createdAt should be UTC ISO');
  assertUtcIso(createdConcert.updatedAt, 'Concert updatedAt should be UTC ISO');

  const invalidConcert = await request('POST', '/admin/concerts', {
    token: adminToken,
    form: (() => {
      const form = new FormData();
      form.append('title', 'x');
      return form;
    })(),
    expectedStatus: 400
  });
  assert(invalidConcert.message === 'Invalid concert payload', 'Invalid concert error message changed');
  assert(Array.isArray(invalidConcert.details) && invalidConcert.details.length > 0, 'Invalid concert details missing');

  const originalConcertAttachmentPath = concertAttachmentDiskPath(concertId);
  const concertPatchForm = new FormData();
  concertPatchForm.append('title', `  烟测音乐会-${suffix}-更新  `);
  concertPatchForm.append('description', '  更新后的描述  ');
  concertPatchForm.append('announcement', '');
  concertPatchForm.append('applicationDeadline', '2099-03-12T18:30:00');
  concertPatchForm.append('status', 'closed');
  concertPatchForm.append('attachmentFile', new Blob([pdfBuffer], { type: 'application/pdf' }), 'concert-booklet.pdf');
  const updatedConcert = await request('PATCH', `/admin/concerts/${concertId}`, {
    token: adminToken,
    form: concertPatchForm,
    expectedStatus: 200
  });
  assert(updatedConcert.title === `烟测音乐会-${suffix}-更新`, 'Concert update title normalization failed');
  assert(updatedConcert.description === '更新后的描述', 'Concert update description normalization failed');
  assert(updatedConcert.announcement === null, 'Concert announcement clearing failed');
  assert(updatedConcert.applicationDeadline === '2099-03-12T10:30:00.000Z', 'Concert update deadline UTC conversion failed');
  assertUtcIso(updatedConcert.createdAt, 'Updated concert createdAt should stay UTC ISO');
  assertUtcIso(updatedConcert.updatedAt, 'Updated concert updatedAt should be UTC ISO');
  assert(!fs.existsSync(originalConcertAttachmentPath), 'Original concert attachment was not removed');
  const updatedConcertAttachmentPath = concertAttachmentDiskPath(concertId);
  assert(fs.existsSync(updatedConcertAttachmentPath), 'Updated concert attachment missing on disk');

  await request('GET', '/concerts', { expectedStatus: 401 });
  const concerts = await request('GET', '/concerts', { token: memberToken, expectedStatus: 200 });
  const closedConcert = (concerts.items || []).find((item) => item.id === concertId);
  assert(closedConcert && closedConcert.status === 'closed', 'Closed concert should remain visible with closed status');
  assert(closedConcert.applicationDeadline === '2099-03-12T10:30:00.000Z', 'Public concert deadline should be UTC ISO');
  assertUtcIso(closedConcert.createdAt, 'Public concert createdAt should be UTC ISO');
  assertUtcIso(closedConcert.updatedAt, 'Public concert updatedAt should be UTC ISO');
  const scoresDir = path.join(uploadRoot, 'scores');
  const rejectedScoreCountBefore = fs.existsSync(scoresDir) ? fs.readdirSync(scoresDir).length : 0;
  const closedApplyAttempt = await request('POST', `/concerts/${concertId}/applications`, {
    token: memberToken,
    form: (() => {
      const form = new FormData();
      form.append('applicantStudentNumber', memberStudentNumber);
      form.append('pieceZh', '关闭状态测试');
      form.append('scoreFile', new Blob([Buffer.from('rejected score')], { type: 'text/plain' }), 'rejected-score.txt');
      return form;
    })(),
    expectedStatus: 400
  });
  assert(closedApplyAttempt.message === 'Score file must be a PDF or supported raster image', 'Unsafe score rejection changed');
  const rejectedScoreCountAfter = fs.existsSync(scoresDir) ? fs.readdirSync(scoresDir).length : 0;
  assert(rejectedScoreCountAfter === rejectedScoreCountBefore, 'Rejected concert application left an orphan score file');
  await request('PATCH', `/admin/concerts/${concertId}`, {
    token: adminToken,
    form: (() => {
      const form = new FormData();
      form.append('status', 'open');
      return form;
    })(),
    expectedStatus: 200
  });
  const concertsAfterReopen = await request('GET', '/concerts', { token: memberToken, expectedStatus: 200 });
  assert((concertsAfterReopen.items || []).some((item) => item.id === concertId), 'Updated concert not visible publicly after reopen');
  await request('GET', `/admin/concerts/${concertId}/review-slots`, {
    token: adminToken,
    expectedStatus: 404
  });

  const applyForm = new FormData();
  applyForm.append('applicantName', '测试成员-更新');
  applyForm.append('applicantStudentNumber', memberStudentNumber);
  applyForm.append('pieceZh', '久石让：人生的旋转木马');
  applyForm.append('pieceEn', 'Joe Hisaishi: Merry-Go-Round of Life');
  applyForm.append('durationMin', '6');
  applyForm.append('contactQq', '12345678');
  applyForm.append('scoreFile', new Blob([pdfBuffer], { type: 'application/pdf' }), 'score.pdf');
  const createdApplication = await request('POST', `/concerts/${concertId}/applications`, {
    token: memberToken,
    form: applyForm,
    expectedStatus: 201
  });
  assert(createdApplication.id, 'First application creation failed');
  const createdScoreDiskPath = scoreDiskPath(createdApplication.id);
  assert(fs.existsSync(createdScoreDiskPath), 'Score upload file missing on disk');

  const applyLegacyForm = new FormData();
  applyLegacyForm.append('applicantStudentNumber', memberStudentNumber);
  applyLegacyForm.append('pieceTitle', '李斯特：b小调奏鸣曲');
  applyLegacyForm.append('composer', 'Liszt: Sonata in B minor, S.178');
  applyLegacyForm.append('duration', '8');
  applyLegacyForm.append('qq', '87654321');
  const secondApplication = await request('POST', `/concerts/${concertId}/applications`, {
    token: memberToken,
    form: applyLegacyForm,
    expectedStatus: 201
  });
  assert(secondApplication.id && secondApplication.id !== createdApplication.id, 'Second application was not created separately');

  const updateApplicationForm = new FormData();
  updateApplicationForm.append('applicationId', String(createdApplication.id));
  updateApplicationForm.append('applicantName', '测试成员-更新');
  updateApplicationForm.append('applicantStudentNumber', memberStudentNumber);
  updateApplicationForm.append('pieceZh', '久石让：人生的旋转木马（修订）');
  updateApplicationForm.append('pieceEn', 'Joe Hisaishi: Merry-Go-Round of Life (Updated)');
  updateApplicationForm.append('durationMin', '7');
  updateApplicationForm.append('contactQq', '12345679');
  await request('POST', `/concerts/${concertId}/applications`, {
    token: memberToken,
    form: updateApplicationForm,
    expectedStatus: 200
  });

  const myApps = await request('GET', `/concerts/${concertId}/my-applications`, {
    token: memberToken,
    expectedStatus: 200
  });
  assert(Array.isArray(myApps.items) && myApps.items.length === 2, 'My applications query failed');

  db.prepare('UPDATE concerts SET application_deadline = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), concertId);
  const countBeforeDeadlineRejection = db.prepare(
    'SELECT COUNT(*) AS count FROM concert_applications WHERE concert_id = ?'
  ).get(concertId).count;
  const deadlineRejected = await request('POST', `/concerts/${concertId}/applications`, {
    token: memberToken,
    form: (() => {
      const form = new FormData();
      form.append('applicantStudentNumber', memberStudentNumber);
      form.append('pieceZh', '截止后测试');
      return form;
    })(),
    expectedStatus: 409
  });
  assert(/deadline has passed/i.test(deadlineRejected.message), 'Expired concert deadline was not enforced');
  assert(
    db.prepare('SELECT COUNT(*) AS count FROM concert_applications WHERE concert_id = ?').get(concertId).count
      === countBeforeDeadlineRejection,
    'Deadline rejection changed concert applications'
  );

  const appList = await request('GET', `/admin/concerts/${concertId}/applications`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(Array.isArray(appList.items) && appList.items.length === 2, 'Admin applications list count invalid');
  const applicationsCsv = await download('GET', `/admin/concerts/${concertId}/applications/export`, {
    token: adminToken,
    expectedStatus: 200
  });
  assert(applicationsCsv.includes('报名ID'), 'Applications CSV export invalid');

  await request('DELETE', `/concerts/${concertId}/applications/${secondApplication.id}`, {
    token: memberToken,
    expectedStatus: 200
  });

  const releaseCandidate = await request('POST', '/admin/concerts', {
    token: adminToken,
    form: (() => {
      const form = new FormData();
      form.append('title', `发布幂等测试-${suffix}`);
      form.append('status', 'draft');
      return form;
    })(),
    expectedStatus: 201
  });
  const firstRelease = await request('POST', `/admin/concerts/${releaseCandidate.id}/release`, {
    token: adminToken,
    json: {},
    expectedStatus: 200
  });
  assert(firstRelease.status === 'open', 'Draft concert first release failed');
  const notificationCountAfterFirstRelease = db.prepare(
    "SELECT COUNT(*) AS count FROM notifications WHERE related_type = 'concert' AND related_id = ?"
  ).get(releaseCandidate.id).count;
  await request('POST', `/admin/concerts/${releaseCandidate.id}/release`, {
    token: adminToken,
    json: {},
    expectedStatus: 409
  });
  assert(
    db.prepare("SELECT COUNT(*) AS count FROM notifications WHERE related_type = 'concert' AND related_id = ?")
      .get(releaseCandidate.id).count === notificationCountAfterFirstRelease,
    'Duplicate concert release created notification side effects'
  );

  const deleteConcert = await request('POST', '/admin/concerts', {
    token: adminToken,
    form: (() => {
      const form = new FormData();
      form.append('title', `待删除音乐会-${suffix}`);
      form.append('description', 'delete me');
      form.append('status', 'open');
      form.append('attachmentFile', new Blob([imageBuffer], { type: 'image/jpeg' }), 'delete-poster.jpg');
      return form;
    })(),
    expectedStatus: 201
  });

  const deleteConcertApply = new FormData();
  deleteConcertApply.append('applicantName', '测试成员-更新');
  deleteConcertApply.append('applicantStudentNumber', memberStudentNumber);
  deleteConcertApply.append('pieceZh', '删除测试曲目');
  deleteConcertApply.append('pieceEn', 'Delete Test Piece');
  deleteConcertApply.append('durationMin', '5');
  deleteConcertApply.append('contactQq', '12340000');
  deleteConcertApply.append('scoreFile', new Blob([pdfBuffer], { type: 'application/pdf' }), 'delete-score.pdf');
  const deleteConcertApplication = await request('POST', `/concerts/${deleteConcert.id}/applications`, {
    token: memberToken,
    form: deleteConcertApply,
    expectedStatus: 201
  });
  const deletePosterDiskPath = concertAttachmentDiskPath(deleteConcert.id);
  const deleteScoreDiskPath = scoreDiskPath(deleteConcertApplication.id);
  await request('DELETE', `/admin/concerts/${deleteConcert.id}`, { token: adminToken, expectedStatus: 200 });
  assert(fs.existsSync(deletePosterDiskPath), 'Archiving a concert must preserve its attachment');
  assert(fs.existsSync(deleteScoreDiskPath), 'Archiving a concert must preserve application scores');
  const concertsAfterArchive = await request('GET', '/concerts', { token: memberToken, expectedStatus: 200 });
  assert(!(concertsAfterArchive.items || []).some((item) => item.id === deleteConcert.id), 'Archived concert remained visible');

  const finalActivityAttachmentPath = attachmentDiskPath(updatedActivityPdf.id);
  const finalAnnouncementAttachmentPath = attachmentDiskPath(replacedAnnouncementAttachment.id);
  await request('DELETE', `/admin/activities/${createdActivity.id}`, { token: adminToken, expectedStatus: 200 });
  await request('DELETE', `/admin/announcements/${createdAnnouncement.id}`, { token: adminToken, expectedStatus: 200 });

  assert(fs.existsSync(finalActivityAttachmentPath), 'Archiving an activity must preserve attachments');
  assert(fs.existsSync(finalAnnouncementAttachmentPath), 'Archiving an announcement must preserve attachments');

  const audit = await request('GET', '/maintainer/audit-log', { token: maintainerToken });
  assert(audit.items.some((item) => item.action === 'grant' && item.targetStudentNumber === memberStudentNumber), 'Administrator grant audit entry missing');
  await request('PUT', `/maintainer/members/${intendedAdmin.id}/administrator`, {
    token: maintainerToken,
    json: { isAdmin: false }
  });
  await request('GET', '/admin/members', { token: adminToken, expectedStatus: 403 });
  const auditAfterRevoke = await request('GET', '/maintainer/audit-log', { token: maintainerToken });
  assert(auditAfterRevoke.items.some((item) => item.action === 'revoke' && item.targetStudentNumber === memberStudentNumber), 'Administrator revoke audit entry missing');

  const publicMembersAtEnd = await request('GET', '/members');
  assert(!publicMembersAtEnd.items.some((item) => item.displayName === 'maintainer.smoke'), 'Maintainer leaked into public member directory');
  assert(db.prepare("SELECT COUNT(*) AS count FROM users WHERE account_type = 'maintainer' AND is_active = 1").get().count === 1, 'Active Maintainer count is not exactly one');

  console.log('SMOKE_OK');
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (typeof db.close === 'function') {
    db.close();
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
