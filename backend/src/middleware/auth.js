import jwt from 'jsonwebtoken';
import db from '../config/db.js';
import { JWT_SECRET } from '../config/env.js';

export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const [scheme, token] = authHeader.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ message: 'Missing or invalid authorization token' });
  }

  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const user = db
      .prepare(
        `SELECT
           id,
           account_type AS accountType,
           is_admin AS isAdmin,
           auth_version AS authVersion,
           student_number AS studentNumber,
           is_active AS isActive,
           must_change_password AS mustChangePassword
         FROM users
         WHERE id = ?`
      )
      .get(payload.id);
    if (!user || !Boolean(user.isActive) || Number(payload.authVersion) !== Number(user.authVersion)) {
      return res.status(401).json({ message: 'Account is inactive' });
    }
    const expectedSessionType = user.accountType === 'maintainer' ? 'maintainer' : 'member';
    if (payload.sessionType !== expectedSessionType) {
      return res.status(401).json({ message: 'Token is invalid or expired' });
    }
    req.user = {
      ...payload,
      accountType: user.accountType,
      role: user.accountType,
      isAdmin: Boolean(user.isAdmin),
      mustChangePassword: Boolean(user.mustChangePassword),
      studentNumber: user.studentNumber
    };
    return next();
  } catch (err) {
    return res.status(401).json({ message: 'Token is invalid or expired' });
  }
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Authentication required' });
    }

    const allowed = roles.some((role) => {
      if (role === 'admin') return req.user.accountType === 'member' && req.user.isAdmin;
      if (role === 'member') return req.user.accountType === 'member';
      if (role === 'maintainer') return req.user.accountType === 'maintainer';
      return false;
    });
    if (!allowed) {
      return res.status(403).json({ message: 'Insufficient permission' });
    }
    if (req.user.accountType === 'member' && req.user.mustChangePassword) {
      return res.status(403).json({
        message: 'Password change required before accessing this resource',
        code: 'PASSWORD_CHANGE_REQUIRED'
      });
    }

    return next();
  };
}

export const requireMember = requireRole('member');
export const requireAdmin = requireRole('admin');
export const requireMaintainer = requireRole('maintainer');

export function requireMemberIdentity(req, res, next) {
  if (!req.user) return res.status(401).json({ message: 'Authentication required' });
  if (req.user.accountType !== 'member') {
    return res.status(403).json({ message: 'Insufficient permission' });
  }
  return next();
}
