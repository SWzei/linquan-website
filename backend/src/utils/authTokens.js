import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/env.js';

export function signSessionToken(user, { maintainer = false } = {}) {
  return jwt.sign(
    {
      id: Number(user.id),
      authVersion: Number(user.auth_version ?? user.authVersion ?? 0),
      sessionType: maintainer ? 'maintainer' : 'member'
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: maintainer ? '4h' : '7d' }
  );
}

export function serializeSessionUser(user) {
  return {
    id: Number(user.id),
    studentNumber: user.student_number ?? user.studentNumber,
    email: user.email || null,
    accountType: user.account_type ?? user.accountType ?? 'member',
    isAdmin: Boolean(user.is_admin ?? user.isAdmin),
    mustChangePassword: Boolean(user.must_change_password ?? user.mustChangePassword),
    profileReminderPending: Boolean(user.profile_reminder_pending ?? user.profileReminderPending)
  };
}
