import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linquan-sqlite-upgrade-'));
const dbPath = path.join(tempRoot, 'legacy.sqlite');
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_number TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member'
  );
  CREATE TABLE profiles (
    user_id INTEGER PRIMARY KEY,
    public_id TEXT
  );
`);
legacy.close();

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = '';
process.env.DB_PATH = dbPath;
process.env.UPLOAD_ROOT = path.join(tempRoot, 'uploads');

const { default: db } = await import('../src/config/db.js');
try {
  const tableNames = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
  );
  assert(tableNames.has('notifications'));
  assert(tableNames.has('auth_security_audit'));
  const userColumns = new Set(db.prepare('PRAGMA table_info(users)').all().map((row) => row.name));
  assert(userColumns.has('must_change_password'));
  console.log('SQLite legacy upgrade validation passed.');
} finally {
  db.close();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
