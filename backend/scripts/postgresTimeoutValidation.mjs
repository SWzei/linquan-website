import pg from 'pg';

const databaseUrl = String(process.env.DATABASE_URL || '').trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required');
}
if (process.env.ALLOW_DISPOSABLE_DATABASE_TESTS !== 'true') {
  throw new Error('Set ALLOW_DISPOSABLE_DATABASE_TESTS=true only for an isolated disposable database');
}

const parsedUrl = new URL(databaseUrl);
const databaseName = parsedUrl.pathname.replace(/^\//, '').toLowerCase();
if (!/(test|validation|disposable|prodreview)/.test(databaseName)) {
  throw new Error(`Refusing timeout probe against non-disposable database: ${databaseName}`);
}

process.env.PG_QUERY_TIMEOUT_MS = process.env.PG_QUERY_TIMEOUT_MS || '100';
process.env.PG_CONNECT_TIMEOUT_MS = process.env.PG_CONNECT_TIMEOUT_MS || '2000';
process.env.PG_TIMEOUT_GRACE_MS = process.env.PG_TIMEOUT_GRACE_MS || '1000';

const { default: createPostgresCompatDb } = await import('../src/config/postgresCompat.js');
const { Pool } = pg;
const verifier = new Pool({ connectionString: databaseUrl, max: 1 });
const tableName = 'postgres_timeout_validation_probe';
const db = createPostgresCompatDb(databaseUrl);

try {
  await verifier.query(`DROP TABLE IF EXISTS ${tableName}`);
  await verifier.query(`CREATE TABLE ${tableName} (id bigserial PRIMARY KEY, marker text NOT NULL)`);

  let timeoutMessage = '';
  try {
    db.prepare(
      `WITH delay AS MATERIALIZED (SELECT pg_sleep(0.25))
       INSERT INTO ${tableName}(marker)
       SELECT ? FROM delay`
    ).run('must-not-commit');
  } catch (err) {
    timeoutMessage = String(err?.message || err);
  }

  if (!/statement timeout|canceling statement/i.test(timeoutMessage)) {
    throw new Error(`Expected server-side statement cancellation, received: ${timeoutMessage || 'no error'}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 400));
  const result = await verifier.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
  if (Number(result.rows[0]?.count || 0) !== 0) {
    throw new Error('Timed-out PostgreSQL write committed after the API received an error');
  }

  console.log(JSON.stringify({
    status: 'POSTGRES_TIMEOUT_OK',
    serverCancellation: timeoutMessage,
    committedRows: 0
  }));
} finally {
  try {
    db.close();
  } catch {
    // The verifier still performs deterministic cleanup if the adapter is unavailable.
  }
  await verifier.query(`DROP TABLE IF EXISTS ${tableName}`);
  await verifier.end();
}
