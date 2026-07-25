import express from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import db from '../config/db.js';
import HttpError from '../utils/httpError.js';
import { serializeSessionUser, signSessionToken } from '../utils/authTokens.js';
import { authenticate, requireMemberIdentity } from '../middleware/auth.js';
import { memberLoginLimiter, registrationLimiter } from '../middleware/rateLimits.js';
import { MEMBER_PASSWORD_REQUIREMENT, memberPasswordSchema } from '../utils/memberPassword.js';
import { recordAuthSecurityEvent } from '../services/authAuditService.js';
import { isUniqueConstraintError } from '../utils/databaseErrors.js';

const router = express.Router();

const registerSchema = z.object({
  studentNumber: z.string().min(3).max(32),
  email: z
    .string()
    .email()
    .optional()
    .or(z.literal(''))
    .transform((value) => (value ? value : null)),
  password: memberPasswordSchema,
  displayName: z.string().trim().min(1).max(64)
});

const loginSchema = z.object({
  credential: z.string().min(3),
  password: z.string().min(6).max(128)
});
const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: memberPasswordSchema
});

router.post('/register', registrationLimiter, (req, res, next) => {
  try {
    const input = registerSchema.parse(req.body);

    const existingByStudentNumber = db
      .prepare('SELECT id FROM users WHERE student_number = ?')
      .get(input.studentNumber);
    if (existingByStudentNumber) {
      throw new HttpError(409, 'Student number is already registered');
    }

    if (input.email) {
      const existingByEmail = db
        .prepare('SELECT id FROM users WHERE email = ?')
        .get(input.email);
      if (existingByEmail) {
        throw new HttpError(409, 'Email is already registered');
      }
    }

    const passwordHash = bcrypt.hashSync(input.password, 10);
    const tx = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO users (
             student_number, email, password_hash, role, account_type, is_admin,
             profile_reminder_pending
           )
           VALUES (?, ?, ?, 'member', 'member', 0, 1)`
        )
        .run(input.studentNumber, input.email, passwordHash);

      const userId = Number(result.lastInsertRowid);
      db.prepare(
        `INSERT INTO profiles (user_id, public_id, display_name)
         VALUES (?, ?, ?)`
      ).run(userId, crypto.randomUUID(), input.displayName);

      return userId;
    });

    let userId;
    try {
      userId = tx();
    } catch (err) {
      if (isUniqueConstraintError(err, {
        table: 'users',
        constraints: ['users_student_number_key', 'users_email_key']
      })) {
        throw new HttpError(409, 'Student number or email is already registered');
      }
      throw err;
    }
    const user = db
      .prepare(
        `SELECT id, student_number, email, account_type, is_admin, auth_version,
                must_change_password, profile_reminder_pending
         FROM users
         WHERE student_number = ?`
      )
      .get(input.studentNumber);
    if (!user) {
      throw new HttpError(500, 'Registered user cannot be loaded');
    }

    const token = signSessionToken(user);
    res.status(201).json({
      token,
      user: serializeSessionUser(user)
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid registration payload', details: err.issues });
    }
    return next(err);
  }
});

router.post('/login', memberLoginLimiter, (req, res, next) => {
  try {
    const input = loginSchema.parse(req.body);

    const user = db
      .prepare(
        `SELECT id, student_number, email, password_hash, account_type, is_admin, auth_version,
                must_change_password, profile_reminder_pending
         FROM users
         WHERE is_active = 1
           AND account_type = 'member'
           AND (student_number = ? OR email = ?)`
      )
      .get(input.credential, input.credential);

    if (!user) {
      throw new HttpError(401, 'Invalid student number/email or password');
    }

    const isValidPassword = bcrypt.compareSync(input.password, user.password_hash);
    if (!isValidPassword) {
      throw new HttpError(401, 'Invalid student number/email or password');
    }

    const token = signSessionToken(user);
    return res.json({
      token,
      user: serializeSessionUser(user)
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: 'Invalid login payload', details: err.issues });
    }
    return next(err);
  }
});

router.get('/me', authenticate, requireMemberIdentity, (req, res) => {
  const user = db.prepare(
    `SELECT id, student_number, email, account_type, is_admin, auth_version,
            must_change_password, profile_reminder_pending
     FROM users WHERE id = ? AND is_active = 1 AND account_type = 'member'`
  ).get(req.user.id);
  res.json({ user: serializeSessionUser(user) });
});

router.post('/change-password', authenticate, requireMemberIdentity, (req, res, next) => {
  try {
    const input = changePasswordSchema.parse(req.body);
    const user = db.prepare(
      `SELECT id, student_number AS "studentNumber", password_hash AS "passwordHash"
       FROM users
       WHERE id = ? AND is_active = 1 AND account_type = 'member'`
    ).get(req.user.id);
    if (!user || !bcrypt.compareSync(input.currentPassword, user.passwordHash)) {
      throw new HttpError(401, 'Current password is incorrect');
    }
    if (bcrypt.compareSync(input.newPassword, user.passwordHash)) {
      throw new HttpError(400, 'New password must be different from the current password');
    }

    const passwordHash = bcrypt.hashSync(input.newPassword, 10);
    db.transaction(() => {
      db.prepare(
        `UPDATE users
         SET password_hash = ?, must_change_password = 0,
             auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`
      ).run(passwordHash, user.id);
      recordAuthSecurityEvent({
        actorUserId: user.id,
        actorAccountType: 'member',
        actorCredential: user.studentNumber,
        targetUserId: user.id,
        targetCredential: user.studentNumber,
        action: 'member_password_change'
      });
    })();

    return res.json({ message: 'Password changed. Please sign in again.' });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: MEMBER_PASSWORD_REQUIREMENT, details: err.issues });
    }
    return next(err);
  }
});

router.post('/profile-reminder/acknowledge', authenticate, requireMemberIdentity, (req, res) => {
  db.prepare(`UPDATE users
    SET profile_reminder_pending = 0, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND account_type = 'member'`).run(req.user.id);
  res.json({ profileReminderPending: false });
});

export default router;
