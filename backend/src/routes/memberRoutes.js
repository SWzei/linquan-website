import express from 'express';
import fs from 'fs';
import path from 'path';
import db from '../config/db.js';
import { UPLOAD_ROOT } from '../config/env.js';
import HttpError from '../utils/httpError.js';

const router = express.Router();
const uploadRoot = path.resolve(process.cwd(), UPLOAD_ROOT);

function publicProjection(row) {
  const publicMediaUrl = (storedPath, kind) => {
    const value = String(storedPath || '');
    if (value.startsWith('/uploads/avatars/')) {
      return `/api/members/${encodeURIComponent(row.publicId)}/${kind}`;
    }
    return /^https:\/\//i.test(value) ? value : null;
  };
  return {
    publicId: row.publicId,
    displayName: row.displayName || '',
    academy: row.academy || '',
    major: row.major || '',
    grade: row.grade || '',
    bio: row.bio || '',
    hobbies: row.hobbies || '',
    pianoInterests: row.pianoInterests || '',
    avatarUrl: publicMediaUrl(row.avatarPath, 'avatar'),
    photoUrl: publicMediaUrl(row.photoPath, 'photo')
  };
}

function memberSelect(whereClause) {
  return `SELECT p.public_id AS "publicId", p.display_name AS "displayName",
      p.avatar_url AS "avatarPath", p.photo_url AS "photoPath", p.bio, p.grade, p.major, p.academy,
      p.hobbies, p.piano_interests AS "pianoInterests"
    FROM users u JOIN profiles p ON p.user_id = u.id
    WHERE u.account_type = 'member' AND u.is_active = 1 AND ${whereClause}`;
}

function resolveMemberMedia(storedPath) {
  const raw = String(storedPath || '').replaceAll('\\', '/');
  if (!raw.startsWith('/uploads/avatars/')) return null;
  const relative = raw.slice('/uploads/'.length);
  const target = path.resolve(uploadRoot, relative);
  if (target === uploadRoot || !target.startsWith(`${uploadRoot}${path.sep}`)) return null;
  return target;
}

router.get('/members', (req, res) => {
  const items = db.prepare(`${memberSelect("p.public_id IS NOT NULL AND TRIM(p.public_id) <> ''")} ORDER BY COALESCE(p.display_name, '') ASC, p.public_id ASC`)
    .all().map(publicProjection);
  res.json({ items });
});

router.get('/members/:publicId', (req, res, next) => {
  try {
    const publicId = String(req.params.publicId || '');
    if (!/^[A-Za-z0-9-]{16,64}$/.test(publicId)) throw new HttpError(404, 'Member not found');
    const row = db.prepare(memberSelect('p.public_id = ?')).get(publicId);
    if (!row) throw new HttpError(404, 'Member not found');
    res.json(publicProjection(row));
  } catch (err) {
    next(err);
  }
});

router.get('/members/:publicId/:kind(avatar|photo)', (req, res, next) => {
  try {
    const row = db.prepare(memberSelect('p.public_id = ?')).get(String(req.params.publicId || ''));
    if (!row) throw new HttpError(404, 'Member media not found');
    const target = resolveMemberMedia(req.params.kind === 'avatar' ? row.avatarPath : row.photoPath);
    if (!target || !fs.existsSync(target) || !fs.statSync(target).isFile()) throw new HttpError(404, 'Member media not found');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type(path.extname(target));
    res.sendFile(target);
  } catch (err) {
    next(err);
  }
});

export default router;
