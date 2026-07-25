import db from '../config/db.js';

export function recordAuthSecurityEvent({
  actorUserId,
  actorAccountType,
  actorCredential,
  targetUserId,
  targetCredential,
  action
}) {
  db.prepare(
    `INSERT INTO auth_security_audit (
       actor_user_id, target_user_id, actor_account_type,
       actor_credential, target_credential, action
     ) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    actorUserId || null,
    targetUserId || null,
    actorAccountType,
    String(actorCredential || ''),
    String(targetCredential || ''),
    action
  );
}
