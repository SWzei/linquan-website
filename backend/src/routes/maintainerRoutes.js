import express from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import db from '../config/db.js';
import { authenticate, requireMaintainer } from '../middleware/auth.js';
import HttpError from '../utils/httpError.js';
import { assertStrongMaintainerPassword, setAdministratorPrivilege } from '../services/maintainerService.js';
import { serializeSessionUser, signSessionToken } from '../utils/authTokens.js';
import { maintainerLoginLimiter } from '../middleware/rateLimits.js';

const router = express.Router();
const loginSchema = z.object({ credential: z.string().min(5).max(64), password: z.string().min(1).max(128) });
const privilegeSchema = z.object({ isAdmin: z.boolean() });
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(128), newPassword: z.string().min(1).max(128) });

router.post('/maintainer/auth/login', maintainerLoginLimiter, (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);
    const user = db.prepare(`SELECT id, student_number, email, password_hash, account_type, is_admin, auth_version
      FROM users WHERE account_type = 'maintainer' AND is_active = 1
        AND (student_number = ? OR email = ?)`).get(input.credential, input.credential);
    if (!user || !bcrypt.compareSync(input.password, user.password_hash)) {
      throw new HttpError(401, 'Invalid Maintainer credential or password');
    }
    res.json({ token: signSessionToken(user, { maintainer: true }), user: serializeSessionUser(user) });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ message: 'Invalid login payload', details: err.issues });
    return next(err);
  }
});

router.use('/maintainer', authenticate, requireMaintainer);

router.get('/maintainer/me', (req, res) => {
  const user = db.prepare(`SELECT id, student_number, email, account_type, is_admin FROM users WHERE id = ?`).get(req.user.id);
  res.json(serializeSessionUser(user));
});

router.get('/maintainer/members', (req, res) => {
  const keyword = `%${String(req.query.q || '').trim()}%`;
  const items = db.prepare(`SELECT u.id, u.student_number AS "studentNumber", u.email,
      COALESCE(p.display_name, u.student_number) AS "displayName", u.is_admin AS "isAdmin"
    FROM users u LEFT JOIN profiles p ON p.user_id = u.id
    WHERE u.account_type = 'member' AND u.is_active = 1
      AND (? = '%%' OR u.student_number LIKE ? OR COALESCE(u.email, '') LIKE ? OR COALESCE(p.display_name, '') LIKE ?)
    ORDER BY u.is_admin DESC, u.student_number ASC LIMIT 200`).all(keyword, keyword, keyword, keyword)
    .map((item) => ({ ...item, isAdmin: Boolean(item.isAdmin) }));
  res.json({ items });
});

router.put('/maintainer/members/:userId(\\d+)/administrator', (req, res, next) => {
  try {
    const input = privilegeSchema.parse(req.body);
    const result = setAdministratorPrivilege({ operatorUserId: req.user.id, targetUserId: Number(req.params.userId), isAdmin: input.isAdmin });
    res.json(result);
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ message: 'Invalid privilege payload', details: err.issues });
    return next(err);
  }
});

router.get('/maintainer/audit-log', (req, res) => {
  const items = db.prepare(`SELECT a.id, a.action, a.created_at AS "createdAt",
      operator.student_number AS "operatorCredential", target.student_number AS "targetStudentNumber",
      COALESCE(p.display_name, target.student_number) AS "targetDisplayName"
    FROM admin_privilege_audit a
    JOIN users operator ON operator.id = a.operator_user_id
    JOIN users target ON target.id = a.target_user_id
    LEFT JOIN profiles p ON p.user_id = target.id
    ORDER BY a.created_at DESC, a.id DESC LIMIT 500`).all();
  res.json({ items });
});

router.post('/maintainer/change-password', (req, res, next) => {
  try {
    const input = passwordSchema.parse(req.body);
    assertStrongMaintainerPassword(input.newPassword);
    const current = db.prepare('SELECT password_hash AS passwordHash FROM users WHERE id = ?').get(req.user.id);
    if (!current || !bcrypt.compareSync(input.currentPassword, current.passwordHash)) throw new HttpError(401, 'Current password is incorrect');
    db.prepare(`UPDATE users SET password_hash = ?, auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .run(bcrypt.hashSync(input.newPassword, 12), req.user.id);
    res.json({ message: 'Password updated; sign in again' });
  } catch (err) {
    if (err instanceof z.ZodError) return res.status(400).json({ message: 'Invalid password payload', details: err.issues });
    return next(err);
  }
});

export default router;
