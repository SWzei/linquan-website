import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { assertStrongMemberPassword } from './memberPassword.js';

export const SEED_CONFIRMATION = 'SEED_TEST_MEMBERS_IN_DISPOSABLE_SQLITE';

function isWithin(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function resolveExplicitDisposablePath(env) {
  if (!env.DB_PATH || !path.isAbsolute(env.DB_PATH)) {
    throw new Error('DB_PATH must be an explicit absolute path for test-member seeding');
  }
  const databasePath = path.resolve(env.DB_PATH);
  const allowedRoots = [
    path.resolve(os.tmpdir()),
    env.DISPOSABLE_DATABASE_ROOT ? path.resolve(env.DISPOSABLE_DATABASE_ROOT) : null
  ].filter(Boolean);
  if (!allowedRoots.some((root) => isWithin(root, databasePath))) {
    throw new Error('Disposable SQLite must be inside the operating-system temp directory or DISPOSABLE_DATABASE_ROOT');
  }
  if (!/(?:test|disposable|validation|sandbox|scratch)/i.test(path.basename(databasePath))) {
    throw new Error('Disposable SQLite filename must clearly identify its test purpose');
  }
  if (!fs.existsSync(databasePath) || !fs.statSync(databasePath).isFile()) {
    throw new Error('Disposable SQLite file does not exist; initialize it explicitly before seeding');
  }
  return databasePath;
}

function verifyDatabaseContents(databasePath, testPrefix) {
  const sqlite = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const integrity = sqlite.pragma('integrity_check');
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
      throw new Error('Disposable SQLite integrity check failed');
    }
    const requiredTables = ['users', 'profiles', 'semesters', 'room_slots'];
    const present = new Set(
      sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
    );
    if (requiredTables.some((table) => !present.has(table))) {
      throw new Error('Target is not an initialized Linquan SQLite database');
    }
    const unsafeAccount = sqlite.prepare(
      `SELECT student_number AS credential
       FROM users
       WHERE account_type <> 'member'
          OR is_admin <> 0
          OR student_number NOT LIKE ?
          OR COALESCE(email, '') NOT LIKE '%@nju-linquan.test'
       LIMIT 1`
    ).get(`${testPrefix}%`);
    if (unsafeAccount) {
      throw new Error('Target contains a Maintainer, Admin, or non-test Member and is not disposable');
    }
    const foreignKeyViolation = sqlite.pragma('foreign_key_check')[0];
    if (foreignKeyViolation) {
      throw new Error('Disposable SQLite has foreign-key violations');
    }
  } finally {
    sqlite.close();
  }
}

export function assertTestMemberSeedAllowed(env = process.env) {
  if (String(env.NODE_ENV || '').toLowerCase() === 'production') {
    throw new Error('Test-member seeding is forbidden in production');
  }
  if (String(env.ALLOW_DISPOSABLE_DATABASE_TESTS || '').toLowerCase() !== 'true') {
    throw new Error('ALLOW_DISPOSABLE_DATABASE_TESTS=true is required');
  }
  if (env.SEED_TEST_MEMBERS_CONFIRM !== SEED_CONFIRMATION) {
    throw new Error(`SEED_TEST_MEMBERS_CONFIRM=${SEED_CONFIRMATION} is required`);
  }
  if (String(env.DATABASE_URL || '').trim()) {
    throw new Error('Test-member seeding refuses PostgreSQL; use an isolated disposable SQLite database');
  }
  if (!env.TEST_MEMBER_PASSWORD) {
    throw new Error('TEST_MEMBER_PASSWORD must be supplied explicitly');
  }
  assertStrongMemberPassword(env.TEST_MEMBER_PASSWORD);
  const testPrefix = String(env.TEST_MEMBER_PREFIX || '26990000');
  if (!/^[A-Za-z0-9_-]{4,24}$/.test(testPrefix)) {
    throw new Error('TEST_MEMBER_PREFIX must be 4-24 safe identifier characters');
  }
  const databasePath = resolveExplicitDisposablePath(env);
  verifyDatabaseContents(databasePath, testPrefix);
  return { databasePath, testPrefix };
}
