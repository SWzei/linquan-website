import { parentPort, workerData } from 'worker_threads';
import pg from 'pg';

const { Pool, types } = pg;
types.setTypeParser(20, (value) => Number(value)); // int8
types.setTypeParser(21, (value) => Number(value)); // int2
types.setTypeParser(23, (value) => Number(value)); // int4
// All timestamp-without-time-zone values in this project represent UTC.
// node-postgres otherwise interprets OID 1114 in the host's local timezone.
types.setTypeParser(1114, (value) => new Date(`${String(value).replace(' ', 'T')}Z`));
types.setTypeParser(1184, (value) => new Date(value));

const encoder = new TextEncoder();

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const statementTimeoutMs = positiveInteger(process.env.PG_QUERY_TIMEOUT_MS, 30000);

const pool = new Pool({
  connectionString: workerData.databaseUrl,
  options: '-c timezone=UTC',
  max: Number(process.env.PG_POOL_MAX || 4),
  idleTimeoutMillis: Number(process.env.PG_IDLE_TIMEOUT_MS || 30000),
  connectionTimeoutMillis: Number(process.env.PG_CONNECT_TIMEOUT_MS || 10000),
  statement_timeout: statementTimeoutMs,
  keepAlive: true
});

let queue = Promise.resolve();
let transactionClient = null;

pool.on('error', (err) => {
  // eslint-disable-next-line no-console
  console.error('Postgres pool error:', err.message);
});

function writeResponse(sab, payload, statusCode) {
  const header = new Int32Array(sab, 0, 2);
  const body = new Uint8Array(sab, 8);

  const raw = encoder.encode(JSON.stringify(payload));
  const length = raw.length;
  if (length > body.length) {
    const overflowPayload = encoder.encode(
      JSON.stringify({
        ok: false,
        error: {
          message: `Worker response too large (${length} bytes > ${body.length} bytes buffer).`
        }
      })
    );
    body.fill(0);
    body.set(overflowPayload.subarray(0, body.length), 0);
    Atomics.store(header, 1, Math.min(overflowPayload.length, body.length));
    Atomics.store(header, 0, 2);
    Atomics.notify(header, 0, 1);
    return;
  }

  body.fill(0);
  body.set(raw, 0);

  Atomics.store(header, 1, length);
  Atomics.store(header, 0, statusCode);
  Atomics.notify(header, 0, 1);
}

async function executeQuery({ sql, params, mode }) {
  const normalized = String(sql || '').trim().toUpperCase();
  if (mode === 'close') {
    if (transactionClient) {
      try {
        await transactionClient.query('ROLLBACK');
      } finally {
        transactionClient.release();
        transactionClient = null;
      }
    }
    await pool.end();
    return { rowCount: 0, rows: [] };
  }
  if (mode === 'exec') {
    if (normalized === 'BEGIN') {
      if (transactionClient) throw new Error('A PostgreSQL transaction is already active');
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        transactionClient = client;
      } catch (err) {
        client.release();
        throw err;
      }
      return { rowCount: 0, rows: [] };
    }
    if ((normalized === 'COMMIT' || normalized === 'ROLLBACK') && transactionClient) {
      const client = transactionClient;
      try {
        await client.query(normalized);
      } finally {
        transactionClient = null;
        client.release();
      }
      return { rowCount: 0, rows: [] };
    }
    await (transactionClient || pool).query(sql);
    return { rowCount: 0, rows: [] };
  }

  const result = await (transactionClient || pool).query(sql, Array.isArray(params) ? params : []);
  return {
    rowCount: Number(result.rowCount || 0),
    rows: result.rows || []
  };
}

parentPort.on('message', (message) => {
  queue = queue
    .then(async () => {
      const { sab, sql, params, mode } = message;
      if (!sab) {
        return;
      }

      try {
        const result = await executeQuery({ sql, params, mode });
        writeResponse(sab, { ok: true, result }, 1);
        if (mode === 'close') parentPort.close();
      } catch (err) {
        writeResponse(
          sab,
          {
            ok: false,
            error: {
              message: err.message,
              code: err.code || null,
              detail: err.detail || null,
              constraint: err.constraint || null,
              table: err.table || null,
              column: err.column || null,
              schema: err.schema || null
            }
          },
          2
        );
      }
    })
    .catch(() => {
      // Keep queue alive for subsequent requests.
    });
});

process.on('beforeExit', async () => {
  try {
    if (transactionClient) {
      await transactionClient.query('ROLLBACK');
      transactionClient.release();
      transactionClient = null;
    }
    await pool.end();
  } catch (err) {
    // Ignore shutdown errors.
  }
});
