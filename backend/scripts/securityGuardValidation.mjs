import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';
import Database from 'better-sqlite3';
import {
  MEMBER_PASSWORD_MAX_LENGTH,
  assertStrongMemberPassword,
  generateStrongMemberPassword
} from '../src/utils/memberPassword.js';
import {
  SEED_CONFIRMATION,
  assertTestMemberSeedAllowed
} from '../src/utils/disposableDatabaseGuard.js';
import {
  HIGH_RISK_CONFIRMATION,
  INSECURE_TLS_CONFIRMATION,
  MIGRATION_CONFIRMATION,
  PRODUCTION_CONFIRMATION,
  buildPostgresTlsOptions,
  validateLegacyMigrationEnvironment
} from './migrateLegacySqliteToPostgres.mjs';

const backendRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linquan-security-'));
const databasePath = path.join(tempRoot, 'linquan-disposable-test.db');
const password = `Aa1!${crypto.randomBytes(12).toString('base64url')}`;

function runNode(script, env) {
  return spawnSync(process.execPath, [script], {
    cwd: backendRoot,
    env,
    encoding: 'utf8',
    windowsHide: true
  });
}

function expectThrow(fn, pattern) {
  assert.throws(fn, pattern);
}

try {
  assertStrongMemberPassword('A1234567');
  assertStrongMemberPassword(`A1${'x'.repeat(MEMBER_PASSWORD_MAX_LENGTH - 2)}`);
  expectThrow(() => assertStrongMemberPassword('12345678'), /letter and one number/);
  expectThrow(() => assertStrongMemberPassword('abcdefgh'), /letter and one number/);
  expectThrow(() => assertStrongMemberPassword('A123456'), /8-128/);
  expectThrow(
    () => assertStrongMemberPassword(`A1${'x'.repeat(MEMBER_PASSWORD_MAX_LENGTH - 1)}`),
    /8-128/
  );
  assertStrongMemberPassword(generateStrongMemberPassword());

  const cleanEnv = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: '',
    DB_PATH: databasePath,
    JWT_SECRET: 'security-validation-only-not-a-real-secret',
    ALLOWED_ORIGINS: ''
  };
  const init = runNode('src/scripts/initDb.js', cleanEnv);
  assert.equal(init.status, 0, `Disposable init failed: ${init.stderr}`);

  const allowedEnv = {
    ...cleanEnv,
    ALLOW_DISPOSABLE_DATABASE_TESTS: 'true',
    SEED_TEST_MEMBERS_CONFIRM: SEED_CONFIRMATION,
    TEST_MEMBER_PASSWORD: password,
    TEST_MEMBER_PREFIX: 'TESTSEED',
    TEST_MEMBER_COUNT: '2'
  };
  expectThrow(
    () => assertTestMemberSeedAllowed({ ...allowedEnv, SEED_TEST_MEMBERS_CONFIRM: '' }),
    /SEED_TEST_MEMBERS_CONFIRM/
  );
  expectThrow(
    () => assertTestMemberSeedAllowed({ ...allowedEnv, NODE_ENV: 'production' }),
    /forbidden in production/
  );
  expectThrow(
    () => assertTestMemberSeedAllowed({ ...allowedEnv, DB_PATH: path.resolve(backendRoot, '../database/linquan.db') }),
    /temp directory|DISPOSABLE_DATABASE_ROOT|filename must clearly identify/
  );
  expectThrow(
    () => assertTestMemberSeedAllowed({ ...allowedEnv, TEST_MEMBER_PASSWORD: 'weakpass' }),
    /letter and one number/
  );
  assert.equal(assertTestMemberSeedAllowed(allowedEnv).databasePath, databasePath);

  const seed = runNode('src/scripts/seedTestMembers.js', allowedEnv);
  assert.equal(seed.status, 0, `Disposable seed failed: ${seed.stderr}`);
  assert(!seed.stdout.includes(password), 'Seed output exposed the supplied password');
  assert(!seed.stderr.includes(password), 'Seed error output exposed the supplied password');
  const sqlite = new Database(databasePath, { readonly: true });
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE account_type='member' AND is_admin=0").get().count,
    2
  );
  sqlite.close();

  const localTarget = 'postgresql://postgres:local-only@127.0.0.1:55439/linquan_disposable_test?sslmode=disable';
  const migrationBase = {
    ...allowedEnv,
    LEGACY_SQLITE_PATH: databasePath,
    DATABASE_URL: localTarget,
    LEGACY_MIGRATION_CONFIRM: MIGRATION_CONFIRMATION,
    LEGACY_MIGRATION_DRY_RUN: 'true'
  };
  expectThrow(
    () => validateLegacyMigrationEnvironment({ ...migrationBase, LEGACY_MIGRATION_CONFIRM: '' }),
    /LEGACY_MIGRATION_CONFIRM/
  );
  expectThrow(
    () => validateLegacyMigrationEnvironment({
      ...migrationBase,
      DATABASE_URL: 'postgresql://user:secret@database.example.com/linquan'
    }),
    /high-risk confirmation/
  );
  expectThrow(
    () => validateLegacyMigrationEnvironment({ ...migrationBase, NODE_ENV: 'production' }),
    /PRODUCTION_CONFIRM/
  );
  validateLegacyMigrationEnvironment({
    ...migrationBase,
    NODE_ENV: 'production',
    LEGACY_MIGRATION_PRODUCTION_CONFIRM: PRODUCTION_CONFIRMATION
  });
  validateLegacyMigrationEnvironment({
    ...migrationBase,
    DATABASE_URL: 'postgresql://user:secret@database.example.com/linquan',
    ALLOW_HIGH_RISK_LEGACY_MIGRATION: 'true',
    LEGACY_MIGRATION_HIGH_RISK_CONFIRM: HIGH_RISK_CONFIRMATION
  });
  assert.equal(buildPostgresTlsOptions(new URL(localTarget), migrationBase, true), false);
  expectThrow(
    () => buildPostgresTlsOptions(
      new URL('postgresql://user:secret@database.example.com/linquan'),
      { PG_TLS_REJECT_UNAUTHORIZED: 'false' },
      false
    ),
    /local-only TLS confirmation/
  );
  assert.deepEqual(
    buildPostgresTlsOptions(
      new URL('postgresql://user:secret@127.0.0.1:55439/linquan_disposable_test'),
      {
        PG_TLS_REJECT_UNAUTHORIZED: 'false',
        INSECURE_PG_TLS_CONFIRM: INSECURE_TLS_CONFIRMATION
      },
      true
    ),
    { rejectUnauthorized: false }
  );

  console.log('SECURITY_GUARD_VALIDATION_OK');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
