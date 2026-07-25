import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

if (process.env.ACCESS_MIGRATION_CONFIRM !== 'BACKUP_AND_MIGRATE_ACCESS') {
  throw new Error('Set ACCESS_MIGRATION_CONFIRM=BACKUP_AND_MIGRATE_ACCESS after confirming the target database');
}
if (process.env.DATABASE_URL) throw new Error('Use the tracked PostgreSQL SQL migration when DATABASE_URL is set');

const dbPath = path.resolve(process.cwd(), process.env.DB_PATH || '../database/linquan.db');
if (!fs.existsSync(dbPath)) throw new Error(`SQLite database not found: ${dbPath}`);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `${dbPath}.pre-access-${stamp}.bak`;

const source = new Database(dbPath, { readonly: true });
const before = {
  users: source.prepare('SELECT COUNT(*) AS count FROM users').get().count,
  profiles: source.prepare('SELECT COUNT(*) AS count FROM profiles').get().count
};
await source.backup(backupPath);
source.close();

process.env.DATABASE_URL = '';
process.env.DB_PATH = dbPath;
const { default: db } = await import('../src/config/db.js');
const after = {
  users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
  profiles: db.prepare('SELECT COUNT(*) AS count FROM profiles').get().count,
  missingPublicIds: db.prepare("SELECT COUNT(*) AS count FROM profiles WHERE public_id IS NULL OR TRIM(public_id) = ''").get().count,
  activeMaintainers: db.prepare("SELECT COUNT(*) AS count FROM users WHERE account_type = 'maintainer' AND is_active = 1").get().count
};
if (before.users !== after.users || before.profiles !== after.profiles || after.missingPublicIds !== 0 || after.activeMaintainers > 1) {
  throw new Error(`Migration verification failed. Restore ${backupPath}`);
}
console.log(JSON.stringify({ dbPath, backupPath, before, after }, null, 2));
if (typeof db.close === 'function') db.close();
