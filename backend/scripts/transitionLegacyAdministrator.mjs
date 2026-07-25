import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

const isPostgres = Boolean(String(process.env.DATABASE_URL || '').trim());

const phase = String(process.env.ADMIN_TRANSITION_PHASE || '').trim().toLowerCase();
const requiredConfirmation = phase === 'grant'
  ? 'GRANT_TARGET_ADMIN'
  : phase === 'deactivate' ? 'DEACTIVATE_VERIFIED_LEGACY' : null;
if (!requiredConfirmation) {
  throw new Error('Set ADMIN_TRANSITION_PHASE to grant or deactivate');
}
if (process.env.ADMIN_TRANSITION_CONFIRM !== requiredConfirmation) {
  throw new Error(`Set ADMIN_TRANSITION_CONFIRM=${requiredConfirmation} after reviewing the backup and target identities`);
}

const targetStudentNumber = String(process.env.TARGET_ADMIN_STUDENT_NUMBER || '').trim();
const legacyStudentNumber = String(process.env.LEGACY_ADMIN_STUDENT_NUMBER || '').trim();
if (!targetStudentNumber || !legacyStudentNumber || targetStudentNumber === legacyStudentNumber) {
  throw new Error('Distinct TARGET_ADMIN_STUDENT_NUMBER and LEGACY_ADMIN_STUDENT_NUMBER are required');
}
if (phase === 'deactivate' && process.env.TARGET_ADMIN_VERIFIED !== 'true') {
  throw new Error('Set TARGET_ADMIN_VERIFIED=true only after the target has logged in and passed a direct admin API check');
}

let rollbackReference;
if (isPostgres) {
  if (process.env.ADMIN_TRANSITION_BACKUP_CONFIRMED !== 'VERIFIED_POSTGRES_ROLLBACK') {
    throw new Error('Set ADMIN_TRANSITION_BACKUP_CONFIRMED=VERIFIED_POSTGRES_ROLLBACK only after testing a current PostgreSQL dump restore');
  }
  rollbackReference = String(process.env.ADMIN_TRANSITION_BACKUP_REFERENCE || '').trim();
  if (!rollbackReference) throw new Error('ADMIN_TRANSITION_BACKUP_REFERENCE is required for PostgreSQL transitions');
} else {
  const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || '../database/linquan.db');
  if (!fs.existsSync(dbPath)) throw new Error(`SQLite database not found: ${dbPath}`);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  rollbackReference = `${dbPath}.pre-admin-${phase}-${stamp}.bak`;
  const source = new Database(dbPath, { readonly: true });
  await source.backup(rollbackReference);
  source.close();
  process.env.DB_PATH = dbPath;
  process.env.DATABASE_URL = '';
}

const { default: db } = await import('../src/config/db.js');
const { setAdministratorPrivilege } = await import('../src/services/maintainerService.js');

const maintainer = db.prepare("SELECT id FROM users WHERE account_type = 'maintainer' AND is_active = 1").get();
const target = db.prepare("SELECT id, is_active AS isActive, account_type AS accountType, is_admin AS isAdmin FROM users WHERE student_number = ?").get(targetStudentNumber);
const legacy = db.prepare('SELECT id, is_active AS isActive, is_admin AS isAdmin FROM users WHERE student_number = ?').get(legacyStudentNumber);
if (!maintainer) throw new Error(`No active Maintainer; rollback reference: ${rollbackReference}`);
if (!target || target.accountType !== 'member' || !Boolean(target.isActive)) throw new Error(`Target is not an active member; rollback reference: ${rollbackReference}`);
if (!legacy) throw new Error(`Legacy account was not found; rollback reference: ${rollbackReference}`);

if (phase === 'grant') {
  setAdministratorPrivilege({ operatorUserId: maintainer.id, targetUserId: target.id, isAdmin: true });
  const verified = db.prepare("SELECT id FROM users WHERE id = ? AND account_type = 'member' AND is_active = 1 AND is_admin = 1").get(target.id);
  if (!verified) throw new Error(`Target administrator verification failed; rollback reference: ${rollbackReference}`);
  console.log(JSON.stringify({
    phase,
    databaseMode: isPostgres ? 'postgresql' : 'sqlite',
    rollbackReference,
    targetAdminUserId: target.id,
    legacyUserId: legacy.id,
    legacyDeactivated: false,
    nextCheckpoint: 'Log in as the target and verify a direct /api/admin request before running the deactivate phase.'
  }, null, 2));
} else {
  if (!Boolean(target.isAdmin)) {
    throw new Error(`Target is not currently an administrator; do not deactivate the legacy account. Rollback reference: ${rollbackReference}`);
  }
  const grantAudit = db.prepare("SELECT id FROM admin_privilege_audit WHERE target_user_id = ? AND action = 'grant' ORDER BY id DESC LIMIT 1").get(target.id);
  if (!grantAudit) {
    throw new Error(`No Maintainer grant audit exists for the target; do not deactivate the legacy account. Rollback reference: ${rollbackReference}`);
  }

  const deactivate = db.transaction(() => {
    db.prepare(`UPDATE users SET is_admin = 0, is_active = 0, auth_version = auth_version + 1,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(legacy.id);
  });
  deactivate();

  const finalState = db.prepare('SELECT is_active AS isActive, is_admin AS isAdmin FROM users WHERE id = ?').get(legacy.id);
  if (Boolean(finalState.isActive) || Boolean(finalState.isAdmin)) throw new Error(`Legacy deactivation verification failed; rollback reference: ${rollbackReference}`);
  console.log(JSON.stringify({ phase, databaseMode: isPostgres ? 'postgresql' : 'sqlite', rollbackReference, targetAdminUserId: target.id, legacyUserId: legacy.id, legacyDeactivated: true }, null, 2));
}

if (typeof db.close === 'function') db.close();
