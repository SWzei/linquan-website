import express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import multer from 'multer';
import { z } from 'zod';
import db from '../config/db.js';
import { UPLOAD_ROOT } from '../config/env.js';
import { authenticate, requireMember } from '../middleware/auth.js';
import HttpError from '../utils/httpError.js';
import { assertStoredRasterImage } from '../utils/safeUpload.js';
import { uploadLimiter } from '../middleware/rateLimits.js';
import { checkUploadCapacity, enforceUploadedFileBudget } from '../middleware/uploadProtection.js';

const router = express.Router();

const uploadRoot = path.resolve(process.cwd(), UPLOAD_ROOT);
const profileImageUploadDir = path.join(uploadRoot, 'avatars');
if (!fs.existsSync(profileImageUploadDir)) {
  fs.mkdirSync(profileImageUploadDir, { recursive: true });
}

function toPublicUploadPath(filePath) {
  const relativePath = path.relative(uploadRoot, filePath).replaceAll('\\', '/').replace(/^\/+/, '');
  return `/uploads/${relativePath}`;
}

function removeStoredProfileImage(publicPath) {
  if (!publicPath || !String(publicPath).startsWith('/uploads/')) return;
  const relativePath = String(publicPath).slice('/uploads/'.length);
  const targetPath = path.resolve(uploadRoot, relativePath);
  if (targetPath === uploadRoot || !targetPath.startsWith(`${uploadRoot}${path.sep}`)) return;
  try {
    fs.unlinkSync(targetPath);
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn('Failed to delete replaced profile image:', err);
  }
}

function removeIncomingProfileImage(file) {
  if (!file?.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn('Failed to delete rejected profile image:', err);
  }
}

const imageUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, profileImageUploadDir),
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase();
      cb(null, `profile-${req.user.id}-${Date.now()}${ext || '.bin'}`);
    }
  }),
  limits: {
    fileSize: 5 * 1024 * 1024
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      return cb(null, true);
    }
    return cb(new HttpError(400, 'Profile image must be an image file'));
  }
});

function ensureProfileRow(userId) {
  const existing = db.prepare('SELECT user_id FROM profiles WHERE user_id = ?').get(userId);
  if (!existing) {
    db.prepare('INSERT INTO profiles (user_id, public_id) VALUES (?, ?)').run(userId, crypto.randomUUID());
  }
}

const profileUpdateSchema = z.object({
  displayName: z.string().max(64).optional(),
  avatarUrl: z.string().max(512).optional().or(z.literal('')).transform((v) => (v === '' ? null : v)),
  photoUrl: z.string().max(512).optional().or(z.literal('')).transform((v) => (v === '' ? null : v)),
  bio: z.string().max(1000).optional(),
  grade: z.string().max(32).optional(),
  major: z.string().max(128).optional(),
  academy: z.string().max(128).optional(),
  hobbies: z.string().max(512).optional(),
  pianoInterests: z.string().max(512).optional(),
  wechatAccount: z.string().max(64).optional(),
  phone: z.string().max(32).optional()
});

router.use('/profiles', authenticate, requireMember);

router.get('/profiles/me', (req, res) => {
  const row = db
    .prepare(
      `SELECT
         u.id,
         u.student_number AS "studentNumber",
         u.email,
         u.account_type AS "accountType",
         u.is_admin AS "isAdmin",
         p.public_id AS "publicId",
         p.display_name AS "displayName",
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
       WHERE u.id = ? AND u.is_active = 1`
    )
    .get(req.user.id);

  if (!row) return res.json(null);
  return res.json({
    ...row,
    isAdmin: Boolean(row.isAdmin),
    avatarUrl: String(row.avatarUrl || '').startsWith('/uploads/')
      ? `/api/members/${row.publicId}/avatar`
      : row.avatarUrl,
    photoUrl: String(row.photoUrl || '').startsWith('/uploads/')
      ? `/api/members/${row.publicId}/photo`
      : row.photoUrl
  });
});

router.post('/profiles/me/avatar', uploadLimiter, checkUploadCapacity, imageUpload.single('avatar'), enforceUploadedFileBudget, (req, res, next) => {
  try {
    if (!req.file) {
      throw new HttpError(400, 'Avatar file is required');
    }
    assertStoredRasterImage(req.file);

    ensureProfileRow(req.user.id);

    const previous = db.prepare('SELECT avatar_url AS avatarUrl FROM profiles WHERE user_id = ?').get(req.user.id);
    const avatarPath = toPublicUploadPath(req.file.path);
    db.prepare(
      `UPDATE profiles
       SET avatar_url = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`
    ).run(avatarPath, req.user.id);

    if (previous?.avatarUrl !== avatarPath) removeStoredProfileImage(previous?.avatarUrl);

    const publicId = db.prepare('SELECT public_id AS publicId FROM profiles WHERE user_id = ?').get(req.user.id)?.publicId;
    res.status(201).json({ avatarUrl: `/api/members/${publicId}/avatar` });
  } catch (err) {
    removeIncomingProfileImage(req.file);
    next(err);
  }
});

router.post('/profiles/me/photo', uploadLimiter, checkUploadCapacity, imageUpload.single('photo'), enforceUploadedFileBudget, (req, res, next) => {
  try {
    if (!req.file) {
      throw new HttpError(400, 'Photo file is required');
    }
    assertStoredRasterImage(req.file);

    ensureProfileRow(req.user.id);

    const previous = db.prepare('SELECT photo_url AS photoUrl FROM profiles WHERE user_id = ?').get(req.user.id);
    const photoPath = toPublicUploadPath(req.file.path);
    db.prepare(
      `UPDATE profiles
       SET photo_url = ?, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`
    ).run(photoPath, req.user.id);

    if (previous?.photoUrl !== photoPath) removeStoredProfileImage(previous?.photoUrl);

    const publicId = db.prepare('SELECT public_id AS publicId FROM profiles WHERE user_id = ?').get(req.user.id)?.publicId;
    res.status(201).json({ photoUrl: `/api/members/${publicId}/photo` });
  } catch (err) {
    removeIncomingProfileImage(req.file);
    next(err);
  }
});

router.put('/profiles/me', (req, res, next) => {
  try {
    const input = profileUpdateSchema.parse(req.body);
    ensureProfileRow(req.user.id);

    const current = db
      .prepare(
        `SELECT
           display_name,
           avatar_url,
           photo_url,
           bio,
           grade,
           major,
           academy,
           hobbies,
           piano_interests,
           wechat_account,
           phone,
           public_id
         FROM profiles
         WHERE user_id = ?`
      )
      .get(req.user.id);

    function normalizeMediaInput(value, existing, kind) {
      if (value === undefined) return existing || null;
      if (value === null) return null;
      const controlledUrl = `/api/members/${current.public_id}/${kind}`;
      if (value === controlledUrl) return existing || null;
      if (String(value).startsWith('/uploads/') || !/^https:\/\//i.test(String(value))) {
        throw new HttpError(400, `${kind} URL must use HTTPS or the profile upload endpoint`);
      }
      return value;
    }

    const nextProfile = {
      displayName: Object.prototype.hasOwnProperty.call(input, 'displayName')
        ? input.displayName
        : current?.display_name || null,
      avatarUrl: normalizeMediaInput(input.avatarUrl, current?.avatar_url, 'avatar'),
      photoUrl: normalizeMediaInput(input.photoUrl, current?.photo_url, 'photo'),
      bio: Object.prototype.hasOwnProperty.call(input, 'bio')
        ? input.bio
        : current?.bio || null,
      grade: Object.prototype.hasOwnProperty.call(input, 'grade')
        ? input.grade
        : current?.grade || null,
      major: Object.prototype.hasOwnProperty.call(input, 'major')
        ? input.major
        : current?.major || null,
      academy: Object.prototype.hasOwnProperty.call(input, 'academy')
        ? input.academy
        : current?.academy || null,
      hobbies: Object.prototype.hasOwnProperty.call(input, 'hobbies')
        ? input.hobbies
        : current?.hobbies || null,
      pianoInterests: Object.prototype.hasOwnProperty.call(input, 'pianoInterests')
        ? input.pianoInterests
        : current?.piano_interests || null,
      wechatAccount: Object.prototype.hasOwnProperty.call(input, 'wechatAccount')
        ? input.wechatAccount
        : current?.wechat_account || null,
      phone: Object.prototype.hasOwnProperty.call(input, 'phone')
        ? input.phone
        : current?.phone || null
    };

    db.prepare(
      `UPDATE profiles
       SET
         display_name = ?,
         avatar_url = ?,
         photo_url = ?,
         bio = ?,
         grade = ?,
         major = ?,
         academy = ?,
         hobbies = ?,
         piano_interests = ?,
         wechat_account = ?,
         phone = ?,
         updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`
    ).run(
      nextProfile.displayName,
      nextProfile.avatarUrl,
      nextProfile.photoUrl,
      nextProfile.bio,
      nextProfile.grade,
      nextProfile.major,
      nextProfile.academy,
      nextProfile.hobbies,
      nextProfile.pianoInterests,
      nextProfile.wechatAccount,
      nextProfile.phone,
      req.user.id
    );

    if (current?.avatar_url && current.avatar_url !== nextProfile.avatarUrl) removeStoredProfileImage(current.avatar_url);
    if (current?.photo_url && current.photo_url !== nextProfile.photoUrl) removeStoredProfileImage(current.photo_url);

    const updated = db
      .prepare(
        `SELECT
           u.id,
           u.student_number AS "studentNumber",
           u.email,
           u.account_type AS "accountType",
           u.is_admin AS "isAdmin",
           p.public_id AS "publicId",
           p.display_name AS "displayName",
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
      .get(req.user.id);

    res.json({
      ...updated,
      isAdmin: Boolean(updated.isAdmin),
      avatarUrl: String(updated.avatarUrl || '').startsWith('/uploads/')
        ? `/api/members/${updated.publicId}/avatar`
        : updated.avatarUrl,
      photoUrl: String(updated.photoUrl || '').startsWith('/uploads/')
        ? `/api/members/${updated.publicId}/photo`
        : updated.photoUrl
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid profile payload', details: err.issues });
    }
    return next(err);
  }
});

export default router;
