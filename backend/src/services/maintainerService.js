import bcrypt from 'bcryptjs';
import db from '../config/db.js';
import HttpError from '../utils/httpError.js';

export function assertStrongMaintainerPassword(password) {
  const value = String(password || '');
  if (value.length < 14 || !/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    throw new HttpError(400, 'Maintainer password must be at least 14 characters and include upper, lower, number, and symbol characters');
  }
}

export function provisionMaintainer({ credential, email = null, password, replaceActive = false, recoverActive = false }) {
  const normalizedCredential = String(credential || '').trim();
  if (normalizedCredential.length < 5 || normalizedCredential.length > 64) {
    throw new HttpError(400, 'Maintainer credential must contain 5 to 64 characters');
  }
  if (!/^[A-Za-z0-9._-]+$/.test(normalizedCredential)) {
    throw new HttpError(400, 'Maintainer credential contains unsupported characters');
  }
  assertStrongMaintainerPassword(password);
  const existingActive = db.prepare("SELECT id, student_number AS credential FROM users WHERE account_type = 'maintainer' AND is_active = 1").get();
  const sameAccount = db.prepare("SELECT id FROM users WHERE student_number = ? AND account_type = 'maintainer'").get(normalizedCredential);
  if (existingActive && !replaceActive && existingActive.credential !== normalizedCredential) {
    throw new HttpError(409, 'An active Maintainer already exists');
  }
  if (existingActive && existingActive.credential === normalizedCredential && !recoverActive) {
    throw new HttpError(409, 'Active Maintainer recovery requires the explicit recovery procedure');
  }

  const passwordHash = bcrypt.hashSync(password, 12);
  const tx = db.transaction(() => {
    if (existingActive && replaceActive && existingActive.credential !== normalizedCredential) {
      db.prepare("UPDATE users SET is_active = 0, is_admin = 0, auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(existingActive.id);
    }
    if (sameAccount) {
      db.prepare(`UPDATE users SET email = ?, password_hash = ?, role = 'member', account_type = 'maintainer',
                    is_admin = 0, is_active = 1, auth_version = auth_version + 1, updated_at = CURRENT_TIMESTAMP
                  WHERE id = ?`).run(email || null, passwordHash, sameAccount.id);
      return sameAccount.id;
    }
    const result = db.prepare(`INSERT INTO users
        (student_number, email, password_hash, role, account_type, is_admin, auth_version, is_active)
      VALUES (?, ?, ?, 'member', 'maintainer', 0, 0, 1)`).run(normalizedCredential, email || null, passwordHash);
    return Number(result.lastInsertRowid);
  });
  return tx();
}

export function setAdministratorPrivilege({ operatorUserId, targetUserId, isAdmin }) {
  const target = db.prepare(`SELECT id, account_type AS accountType, is_active AS isActive, is_admin AS isAdmin
    FROM users WHERE id = ?`).get(targetUserId);
  if (!target) throw new HttpError(404, 'Member not found');
  if (target.accountType !== 'member') throw new HttpError(400, 'Administrator privilege can only be assigned to members');
  if (!Boolean(target.isActive)) throw new HttpError(409, 'Inactive members cannot receive administrator privilege');
  const desired = Boolean(isAdmin);
  if (Boolean(target.isAdmin) === desired) return { changed: false, isAdmin: desired };
  const action = desired ? 'grant' : 'revoke';
  const tx = db.transaction(() => {
    // Authorization middleware reloads this capability from the database on every
    // request, so existing member sessions gain or lose admin access immediately.
    // Do not invalidate the whole member session for a capability-only change.
    db.prepare(`UPDATE users SET is_admin = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(desired ? 1 : 0, target.id);
    db.prepare(`INSERT INTO admin_privilege_audit (operator_user_id, target_user_id, action) VALUES (?, ?, ?)`).run(operatorUserId, target.id, action);
  });
  tx();
  return { changed: true, isAdmin: desired, action };
}
