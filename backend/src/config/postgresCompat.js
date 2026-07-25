import { Worker } from 'worker_threads';

const RESPONSE_BUFFER_BYTES = 4 * 1024 * 1024;
const DEFAULT_QUERY_TIMEOUT_MS = 30000;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_TIMEOUT_GRACE_MS = 2000;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSqlText(rawSql) {
  if (typeof rawSql !== 'string') {
    throw new Error('SQL statement must be a string');
  }

  let sql = rawSql.trim().replace(/;+\s*$/g, '');

  const insertOrIgnorePattern = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i;
  const isInsertOrIgnore = insertOrIgnorePattern.test(sql);
  if (isInsertOrIgnore) {
    sql = sql.replace(insertOrIgnorePattern, 'INSERT INTO');
  }

  let paramIndex = 0;
  sql = sql.replace(/\?/g, () => `$${++paramIndex}`);

  if (isInsertOrIgnore) {
    const returningMatch = /\bRETURNING\b/i.exec(sql);
    if (returningMatch) {
      const idx = returningMatch.index;
      sql = `${sql.slice(0, idx).trimEnd()} ON CONFLICT DO NOTHING ${sql.slice(idx)}`;
    } else {
      sql = `${sql} ON CONFLICT DO NOTHING`;
    }
  }

  return { sql, placeholderCount: paramIndex };
}

function splitStatements(rawSql) {
  return String(rawSql)
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean);
}

function inferInsertId(rows) {
  const firstRow = Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  if (!firstRow || typeof firstRow !== 'object') {
    return undefined;
  }

  if (Object.prototype.hasOwnProperty.call(firstRow, 'id')) {
    const idValue = Number(firstRow.id);
    return Number.isNaN(idValue) ? firstRow.id : idValue;
  }

  const firstValue = Object.values(firstRow)[0];
  if (firstValue === undefined) {
    return undefined;
  }
  const numeric = Number(firstValue);
  return Number.isNaN(numeric) ? firstValue : numeric;
}

function extractCamelCaseAliasMap(rawSql) {
  const aliasMap = new Map();
  const pattern = /\bAS\s+(?:"([^"]+)"|([a-zA-Z_][a-zA-Z0-9_]*))/gi;
  let match = pattern.exec(rawSql);
  while (match) {
    const unquotedAlias = match[2];
    if (unquotedAlias && /[A-Z]/.test(unquotedAlias)) {
      aliasMap.set(unquotedAlias.toLowerCase(), unquotedAlias);
    }
    match = pattern.exec(rawSql);
  }
  return aliasMap;
}

function normalizeResponseRows(rows, aliasMap) {
  if (!Array.isArray(rows) || rows.length === 0 || aliasMap.size === 0) {
    return rows || [];
  }

  return rows.map((row) => {
    if (!row || typeof row !== 'object') {
      return row;
    }

    let patched = null;
    for (const [pgKey, wantedKey] of aliasMap.entries()) {
      if (!Object.prototype.hasOwnProperty.call(row, pgKey)) {
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(row, wantedKey)) {
        continue;
      }
      if (!patched) {
        patched = { ...row };
      }
      patched[wantedKey] = patched[pgKey];
      delete patched[pgKey];
    }

    return patched || row;
  });
}

function isTransientConnectionError(err) {
  const text = String(err?.message || '').toLowerCase();
  return (
    text.includes('connection terminated unexpectedly') ||
    text.includes('connection reset') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('socket hang up')
  );
}

class PostgresPreparedStatement {
  constructor(db, sourceSql) {
    this.db = db;
    this.sourceSql = sourceSql;
  }

  run(...params) {
    return this.db._execute(this.sourceSql, params, 'run');
  }

  get(...params) {
    return this.db._execute(this.sourceSql, params, 'get');
  }

  all(...params) {
    return this.db._execute(this.sourceSql, params, 'all');
  }
}

class PostgresCompatDb {
  constructor(databaseUrl) {
    this.databaseUrl = databaseUrl;
    this.statementTimeoutMs = positiveInteger(process.env.PG_QUERY_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS);
    this.connectTimeoutMs = positiveInteger(process.env.PG_CONNECT_TIMEOUT_MS, DEFAULT_CONNECT_TIMEOUT_MS);
    this.timeoutGraceMs = positiveInteger(process.env.PG_TIMEOUT_GRACE_MS, DEFAULT_TIMEOUT_GRACE_MS);
    // PostgreSQL cancels a statement at statementTimeoutMs. The main thread must
    // wait long enough to receive that definitive outcome; otherwise a write may
    // be reported as failed while it is still able to commit in the worker.
    this.dispatchTimeoutMs = this.connectTimeoutMs + this.statementTimeoutMs + this.timeoutGraceMs;
    this.transactionDepth = 0;
    this.savepointCounter = 0;
    this.worker = null;
    this.workerReady = false;

    this._spawnWorker();
  }

  _spawnWorker() {
    this.worker = new Worker(new URL('./postgresWorker.js', import.meta.url), {
      type: 'module',
      workerData: { databaseUrl: this.databaseUrl }
    });
    this.workerReady = true;

    this.worker.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('Postgres worker error:', err);
      this.workerReady = false;
    });

    this.worker.on('exit', (code) => {
      this.workerReady = false;
      this.worker = null;
      if (code !== 0) {
        // eslint-disable-next-line no-console
        console.error(`Postgres worker exited with code ${code}`);
      }
    });
  }

  _ensureWorker() {
    if (!this.worker || !this.workerReady) {
      this._spawnWorker();
    }
  }

  prepare(sql) {
    return new PostgresPreparedStatement(this, sql);
  }

  pragma() {
    // No-op for Postgres compatibility.
  }

  close() {
    if (!this.worker || !this.workerReady) return;
    try {
      this._dispatchOnce('', [], 'close');
    } finally {
      this.worker = null;
      this.workerReady = false;
      this.transactionDepth = 0;
    }
  }

  exec(sql) {
    const statements = splitStatements(sql);
    for (const statement of statements) {
      this._dispatch(statement, [], 'exec');
    }
  }

  transaction(callback) {
    if (typeof callback !== 'function') {
      throw new Error('transaction callback must be a function');
    }

    return (...args) => {
      const outermost = this.transactionDepth === 0;
      const savepointName = `sp_${++this.savepointCounter}`;

      if (outermost) {
        this.exec('BEGIN');
      } else {
        this.exec(`SAVEPOINT ${savepointName}`);
      }

      this.transactionDepth += 1;

      try {
        const result = callback(...args);

        if (outermost) {
          this.exec('COMMIT');
        } else {
          this.exec(`RELEASE SAVEPOINT ${savepointName}`);
        }

        return result;
      } catch (err) {
        try {
          if (outermost) {
            this.exec('ROLLBACK');
          } else {
            this.exec(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            this.exec(`RELEASE SAVEPOINT ${savepointName}`);
          }
        } catch (rollbackError) {
          // eslint-disable-next-line no-console
          console.error('Rollback failed:', rollbackError);
        }
        throw err;
      } finally {
        this.transactionDepth -= 1;
      }
    };
  }

  _execute(rawSql, params, mode) {
    const isInsert = /^\s*INSERT\b/i.test(rawSql);
    const hasReturning = /\bRETURNING\b/i.test(rawSql);

    let querySql = rawSql;
    if (mode === 'run' && isInsert && !hasReturning) {
      querySql = `${rawSql} RETURNING *`;
    }

    const response = this._dispatch(querySql, params, mode);
    const aliasMap = extractCamelCaseAliasMap(querySql);
    const normalizedResponse = {
      ...response,
      rows: normalizeResponseRows(response.rows, aliasMap)
    };

    if (mode === 'all') {
      return normalizedResponse.rows;
    }

    if (mode === 'get') {
      return normalizedResponse.rows[0];
    }

    if (mode === 'run') {
      const result = {
        changes: normalizedResponse.rowCount
      };
      const insertId = inferInsertId(normalizedResponse.rows);
      if (insertId !== undefined) {
        result.lastInsertRowid = insertId;
      }
      return result;
    }

    return normalizedResponse;
  }

  _dispatch(rawSql, params, mode) {
    try {
      return this._dispatchOnce(rawSql, params, mode);
    } catch (err) {
      if (!isTransientConnectionError(err) || this.transactionDepth > 0) {
        throw err;
      }

      // One automatic retry for transient network/connection errors.
      this.workerReady = false;
      this._ensureWorker();
      return this._dispatchOnce(rawSql, params, mode);
    }
  }

  _dispatchOnce(rawSql, params, mode) {
    this._ensureWorker();

    const { sql, placeholderCount } = normalizeSqlText(rawSql);
    const boundParams = Array.isArray(params) ? params : [];

    if (placeholderCount !== boundParams.length) {
      throw new Error(
        `SQL placeholder mismatch: expected ${placeholderCount}, received ${boundParams.length}. SQL: ${rawSql}`
      );
    }

    const sab = new SharedArrayBuffer(8 + RESPONSE_BUFFER_BYTES);
    const header = new Int32Array(sab, 0, 2);

    this.worker.postMessage({
      sql,
      params: boundParams,
      mode,
      sab
    });

    const waitResult = Atomics.wait(header, 0, 0, this.dispatchTimeoutMs);
    if (waitResult === 'timed-out') {
      this.workerReady = false;
      const abandonedWorker = this.worker;
      this.worker = null;
      if (abandonedWorker) {
        void abandonedWorker.terminate();
      }
      throw new Error(
        `Postgres worker did not confirm cancellation within ${this.dispatchTimeoutMs}ms; connection was terminated: ${sql}`
      );
    }

    const status = Atomics.load(header, 0);
    const length = Atomics.load(header, 1);
    const payloadBytes = new Uint8Array(sab, 8, Math.max(0, length));
    const payloadText = new TextDecoder().decode(payloadBytes);
    const payload = payloadText ? JSON.parse(payloadText) : { ok: false, error: { message: 'Empty response' } };

    if (status !== 1 || !payload.ok) {
      const errorMessage = payload?.error?.message || 'Unknown Postgres worker error';
      const workerError = new Error(errorMessage);
      for (const field of ['code', 'detail', 'constraint', 'table', 'column', 'schema']) {
        if (payload?.error?.[field]) workerError[field] = payload.error[field];
      }
      throw workerError;
    }

    return payload.result;
  }
}

export default function createPostgresCompatDb(databaseUrl) {
  return new PostgresCompatDb(databaseUrl);
}
