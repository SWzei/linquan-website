import assert from 'assert/strict';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, spawnSync } from 'child_process';
import Database from 'better-sqlite3';

const backendRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'linquan-clean-start-'));
const databasePath = path.join(tempRoot, 'linquan-disposable-clean-start.sqlite');
const uploadRoot = path.join(tempRoot, 'uploads');
const password = `Aa1!${crypto.randomBytes(18).toString('base64url')}`;
const port = 4217;
const validationEnv = {
  ...process.env,
  DATABASE_URL: '',
  DB_PATH: databasePath,
  UPLOAD_ROOT: uploadRoot,
  NODE_ENV: 'development',
  HOST: '127.0.0.1',
  PORT: String(port),
  SERVE_FRONTEND: 'true',
  JWT_SECRET: 'clean-start-validation-secret-not-for-deployment',
  ALLOWED_ORIGINS: '',
  MAINTAINER_CREDENTIAL: 'validation.maintainer',
  MAINTAINER_PASSWORD: password,
  MAINTAINER_CONFIRM: 'PROVISION_MAINTAINER'
};

function run(script) {
  const result = spawnSync(process.execPath, [script], {
    cwd: backendRoot,
    env: validationEnv,
    encoding: 'utf8',
    windowsHide: true
  });
  assert.equal(result.status, 0, `${script} failed: ${result.stderr}`);
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok && (await response.json()).status === 'ok') return;
    } catch {
      // Server may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('Clean-start server did not become healthy');
}

let server;
try {
  run('src/scripts/initDb.js');
  run('src/scripts/initDb.js');
  run('scripts/provisionMaintainer.mjs');
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: backendRoot,
    env: validationEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  let serverError = '';
  server.stderr.on('data', (chunk) => {
    serverError += chunk.toString();
  });
  await waitForHealth();

  const maintainerLogin = await fetch(`http://127.0.0.1:${port}/api/maintainer/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'validation.maintainer', password })
  });
  assert.equal(maintainerLogin.status, 200);
  const maintainerSession = await maintainerLogin.json();
  assert(maintainerSession.token);
  assert.equal(maintainerSession.user.accountType, 'maintainer');

  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/admin/members`)).status, 401);
  const missingMember = await fetch(`http://127.0.0.1:${port}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'no-such-member', password: 'Invalid1x' })
  });
  assert.equal(missingMember.status, 401);

  const sqlite = new Database(databasePath, { readonly: true });
  const roleCounts = sqlite.prepare(
    `SELECT
       SUM(CASE WHEN account_type = 'maintainer' AND is_active = 1 THEN 1 ELSE 0 END) AS maintainers,
       SUM(CASE WHEN account_type = 'member' THEN 1 ELSE 0 END) AS members,
       SUM(CASE WHEN is_admin = 1 THEN 1 ELSE 0 END) AS admins
     FROM users`
  ).get();
  sqlite.close();
  assert.deepEqual(roleCounts, { maintainers: 1, members: 0, admins: 0 });
  assert.equal(server.exitCode, null, serverError);
  console.log('CLEAN_START_VALIDATION_OK');
} finally {
  if (server && server.exitCode === null) {
    server.kill();
    await new Promise((resolve) => {
      server.once('exit', resolve);
      setTimeout(resolve, 2000);
    });
  }
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
