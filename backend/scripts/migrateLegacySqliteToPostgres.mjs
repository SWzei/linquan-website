import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import pg from 'pg';

const { Client } = pg;
export const MIGRATION_CONFIRMATION = 'MIGRATE_REVIEWED_SQLITE_TO_DISPOSABLE_POSTGRES';
export const HIGH_RISK_CONFIRMATION = 'MIGRATE_REVIEWED_SQLITE_TO_HIGH_RISK_POSTGRES';
export const PRODUCTION_CONFIRMATION = 'MIGRATE_REVIEWED_SQLITE_TO_PRODUCTION';
export const INSECURE_TLS_CONFIRMATION = 'ALLOW_INSECURE_TLS_FOR_LOCAL_DISPOSABLE_POSTGRES';

const quoteIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;
const normalizedBoolean = (value) => value === true || value === 1 || value === '1';

function assertSourcePath(env) {
  if (!env.LEGACY_SQLITE_PATH || !path.isAbsolute(env.LEGACY_SQLITE_PATH)) {
    throw new Error('LEGACY_SQLITE_PATH must be an explicit absolute path');
  }
  const sourcePath = path.resolve(env.LEGACY_SQLITE_PATH);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error('LEGACY_SQLITE_PATH does not identify an existing file');
  }
  if (!/\.(?:db|sqlite|sqlite3)$/i.test(sourcePath)) {
    throw new Error('LEGACY_SQLITE_PATH must use a recognized SQLite extension');
  }
  return sourcePath;
}

function isLocalPostgresHost(hostname) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(hostname).toLowerCase());
}

function hasDisposableDatabaseName(databaseName) {
  return /(?:test|disposable|validation|sandbox|scratch)/i.test(databaseName);
}

export function validateLegacyMigrationEnvironment(env = process.env) {
  const sourcePath = assertSourcePath(env);
  if (!env.DATABASE_URL) {
    throw new Error('DATABASE_URL must explicitly identify the target PostgreSQL database');
  }
  let target;
  try {
    target = new URL(env.DATABASE_URL);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL');
  }
  if (!['postgres:', 'postgresql:'].includes(target.protocol)) {
    throw new Error('DATABASE_URL must use PostgreSQL');
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\/+/, ''));
  if (!databaseName) {
    throw new Error('DATABASE_URL must include an explicit database name');
  }

  const isProduction = String(env.NODE_ENV || '').toLowerCase() === 'production';
  const isDisposableLocal = isLocalPostgresHost(target.hostname) && hasDisposableDatabaseName(databaseName);
  const highRiskAllowed = env.ALLOW_HIGH_RISK_LEGACY_MIGRATION === 'true'
    && env.LEGACY_MIGRATION_HIGH_RISK_CONFIRM === HIGH_RISK_CONFIRMATION;

  if (isProduction && env.LEGACY_MIGRATION_PRODUCTION_CONFIRM !== PRODUCTION_CONFIRMATION) {
    throw new Error(`Production additionally requires LEGACY_MIGRATION_PRODUCTION_CONFIRM=${PRODUCTION_CONFIRMATION}`);
  }
  if (isDisposableLocal) {
    if (env.ALLOW_DISPOSABLE_DATABASE_TESTS !== 'true') {
      throw new Error('ALLOW_DISPOSABLE_DATABASE_TESTS=true is required for a disposable target');
    }
    if (env.LEGACY_MIGRATION_CONFIRM !== MIGRATION_CONFIRMATION) {
      throw new Error(`LEGACY_MIGRATION_CONFIRM=${MIGRATION_CONFIRMATION} is required`);
    }
  } else if (!highRiskAllowed) {
    throw new Error('Target is not demonstrably local/disposable; the independent high-risk confirmation is required');
  }

  const dryRun = String(env.LEGACY_MIGRATION_DRY_RUN || '').toLowerCase() === 'true';
  return { sourcePath, target, databaseName, isDisposableLocal, isProduction, dryRun };
}

export function buildPostgresTlsOptions(target, env = process.env, isDisposableLocal = false) {
  const sslMode = String(target.searchParams.get('sslmode') || '').toLowerCase();
  if (sslMode === 'disable') {
    if (!isDisposableLocal) {
      throw new Error('sslmode=disable is allowed only for a local disposable PostgreSQL target');
    }
    return false;
  }
  if (String(env.PG_TLS_REJECT_UNAUTHORIZED || '').toLowerCase() === 'false') {
    if (!isDisposableLocal || env.INSECURE_PG_TLS_CONFIRM !== INSECURE_TLS_CONFIRMATION) {
      throw new Error('Disabling PostgreSQL certificate verification requires the local-only TLS confirmation');
    }
    console.warn('WARNING: PostgreSQL TLS certificate verification is disabled for this local disposable run.');
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true };
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function inspectSqlite(sourcePath) {
  const sqlite = new Database(sourcePath, { readonly: true, fileMustExist: true });
  const integrity = sqlite.pragma('integrity_check');
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    sqlite.close();
    throw new Error('Source SQLite integrity_check did not return ok');
  }
  const foreignKeyViolations = sqlite.pragma('foreign_key_check');
  if (foreignKeyViolations.length) {
    sqlite.close();
    throw new Error(`Source SQLite has ${foreignKeyViolations.length} foreign-key violation(s)`);
  }
  const tables = sqlite.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all().map((row) => row.name);
  if (!tables.includes('users') || !tables.includes('profiles')) {
    sqlite.close();
    throw new Error('Source is not a recognizable Linquan SQLite database');
  }
  const tableInfo = new Map();
  const foreignKeys = [];
  for (const table of tables) {
    const columns = sqlite.pragma(`table_info(${quoteIdentifier(table)})`);
    tableInfo.set(table, {
      columns,
      primaryKey: columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name),
      count: Number(sqlite.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(table)}`).get().count)
    });
    for (const key of sqlite.pragma(`foreign_key_list(${quoteIdentifier(table)})`)) {
      foreignKeys.push({ table, column: key.from, referencedTable: key.table, referencedColumn: key.to });
    }
  }
  return { sqlite, tables, tableInfo, foreignKeys };
}

async function inspectPostgres(client) {
  const columnsResult = await client.query(
    `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default, is_identity
       FROM information_schema.columns
      WHERE table_schema = 'public'
      ORDER BY table_name, ordinal_position`
  );
  const primaryKeysResult = await client.query(
    `SELECT tc.table_name, kcu.column_name, kcu.ordinal_position
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY tc.table_name, kcu.ordinal_position`
  );
  const foreignKeysResult = await client.query(
    `SELECT tc.table_name, kcu.column_name, ccu.table_name AS referenced_table,
            ccu.column_name AS referenced_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.constraint_schema = tc.constraint_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
        AND ccu.constraint_schema = tc.constraint_schema
      WHERE tc.constraint_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'`
  );
  const tables = new Map();
  for (const column of columnsResult.rows) {
    if (!tables.has(column.table_name)) {
      tables.set(column.table_name, { columns: [], primaryKey: [] });
    }
    tables.get(column.table_name).columns.push(column);
  }
  for (const primaryKey of primaryKeysResult.rows) {
    tables.get(primaryKey.table_name)?.primaryKey.push(primaryKey.column_name);
  }
  return { tables, foreignKeys: foreignKeysResult.rows };
}

function validateSchemaCompatibility(source, target) {
  const errors = [];
  for (const table of source.tables) {
    const sourceInfo = source.tableInfo.get(table);
    const targetInfo = target.tables.get(table);
    if (!targetInfo) {
      errors.push(`target table missing: ${table}`);
      continue;
    }
    const targetColumns = new Map(targetInfo.columns.map((column) => [column.column_name, column]));
    for (const sourceColumn of sourceInfo.columns) {
      if (!targetColumns.has(sourceColumn.name)) {
        errors.push(`target column missing: ${table}.${sourceColumn.name}`);
      }
    }
    const sourceColumnNames = new Set(sourceInfo.columns.map((column) => column.name));
    for (const targetColumn of targetInfo.columns) {
      const generated = targetColumn.is_identity === 'YES' || targetColumn.column_default;
      if (!sourceColumnNames.has(targetColumn.column_name) && targetColumn.is_nullable === 'NO' && !generated) {
        errors.push(`source cannot satisfy required target column: ${table}.${targetColumn.column_name}`);
      }
    }
    if (sourceInfo.primaryKey.join('|') !== targetInfo.primaryKey.join('|')) {
      errors.push(`primary-key mismatch: ${table}`);
    }
  }
  const targetForeignKeySet = new Set(
    target.foreignKeys.map((key) => `${key.table_name}.${key.column_name}->${key.referenced_table}.${key.referenced_column}`)
  );
  for (const key of source.foreignKeys) {
    const signature = `${key.table}.${key.column}->${key.referencedTable}.${key.referencedColumn}`;
    if (!targetForeignKeySet.has(signature)) {
      errors.push(`foreign-key mismatch: ${signature}`);
    }
  }
  if (errors.length) {
    throw new Error(`Schema compatibility check failed:\n- ${errors.join('\n- ')}`);
  }
}

function dependencyOrder(tables, foreignKeys) {
  const tableSet = new Set(tables);
  const dependencies = new Map(tables.map((table) => [table, new Set()]));
  for (const key of foreignKeys) {
    if (key.table !== key.referencedTable && tableSet.has(key.referencedTable)) {
      dependencies.get(key.table).add(key.referencedTable);
    }
  }
  const ordered = [];
  const remaining = new Set(tables);
  while (remaining.size) {
    const ready = [...remaining].filter((table) =>
      [...dependencies.get(table)].every((dependency) => !remaining.has(dependency))
    );
    if (!ready.length) {
      throw new Error(`Foreign-key dependency cycle requires manual migration: ${[...remaining].join(', ')}`);
    }
    ready.sort();
    for (const table of ready) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

function convertValue(value, column) {
  if (value === null || value === undefined) return null;
  if (column.data_type === 'boolean') return normalizedBoolean(value);
  if (['smallint', 'integer', 'bigint', 'numeric', 'real', 'double precision'].includes(column.data_type)) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`Invalid numeric value for ${column.column_name}`);
    return number;
  }
  if (['json', 'jsonb'].includes(column.data_type)) {
    if (typeof value === 'string') JSON.parse(value);
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  if (column.data_type.includes('timestamp') || column.data_type === 'date' || column.data_type === 'time without time zone') {
    return String(value);
  }
  if (column.data_type === 'bytea') {
    return Buffer.isBuffer(value) ? value : Buffer.from(value);
  }
  return value;
}

async function assertEmptyTarget(client, tables) {
  const conflicts = [];
  for (const table of tables) {
    const result = await client.query(`SELECT COUNT(*)::bigint AS count FROM public.${quoteIdentifier(table)}`);
    const count = Number(result.rows[0].count);
    if (count !== 0) conflicts.push(`${table}=${count}`);
  }
  if (conflicts.length) {
    throw new Error(`Target contains data; migration refuses conflicts: ${conflicts.join(', ')}`);
  }
  const metadataExists = await client.query("SELECT to_regclass('public.legacy_sqlite_migrations') AS name");
  if (metadataExists.rows[0].name) {
    const count = Number((await client.query('SELECT COUNT(*)::bigint AS count FROM public.legacy_sqlite_migrations')).rows[0].count);
    if (count) throw new Error('Target already records a legacy SQLite migration');
  }
}

async function migrateRows(client, source, target, order) {
  for (const table of order) {
    const sourceInfo = source.tableInfo.get(table);
    const targetColumns = new Map(target.tables.get(table).columns.map((column) => [column.column_name, column]));
    const columns = sourceInfo.columns.map((column) => column.name);
    const rows = source.sqlite.prepare(`SELECT * FROM ${quoteIdentifier(table)}`).all();
    if (rows.length) {
      const columnSql = columns.map(quoteIdentifier).join(', ');
      const placeholders = columns.map((_, index) => `$${index + 1}`).join(', ');
      const statement = `INSERT INTO public.${quoteIdentifier(table)} (${columnSql}) VALUES (${placeholders})`;
      for (const row of rows) {
        const values = columns.map((column) => convertValue(row[column], targetColumns.get(column)));
        await client.query(statement, values);
      }
    }
    for (const primaryKey of sourceInfo.primaryKey) {
      const sequence = await client.query('SELECT pg_get_serial_sequence($1, $2) AS name', [`public.${table}`, primaryKey]);
      if (sequence.rows[0].name) {
        await client.query(
          `SELECT setval($1, COALESCE((SELECT MAX(${quoteIdentifier(primaryKey)}) FROM public.${quoteIdentifier(table)}), 1), $2)`,
          [sequence.rows[0].name, sourceInfo.count > 0]
        );
      }
    }
  }
}

async function validateMigratedRows(client, source) {
  for (const table of source.tables) {
    const count = Number(
      (await client.query(`SELECT COUNT(*)::bigint AS count FROM public.${quoteIdentifier(table)}`)).rows[0].count
    );
    if (count !== source.tableInfo.get(table).count) {
      throw new Error(`Post-migration row-count mismatch for ${table}`);
    }
  }
  for (const key of source.foreignKeys) {
    const result = await client.query(
      `SELECT COUNT(*)::bigint AS count
         FROM public.${quoteIdentifier(key.table)} child
         LEFT JOIN public.${quoteIdentifier(key.referencedTable)} parent
           ON child.${quoteIdentifier(key.column)} = parent.${quoteIdentifier(key.referencedColumn)}
        WHERE child.${quoteIdentifier(key.column)} IS NOT NULL
          AND parent.${quoteIdentifier(key.referencedColumn)} IS NULL`
    );
    if (Number(result.rows[0].count) !== 0) {
      throw new Error(`Post-migration relationship validation failed for ${key.table}.${key.column}`);
    }
  }
}

export async function runLegacyMigration(env = process.env) {
  const guard = validateLegacyMigrationEnvironment(env);
  const source = inspectSqlite(guard.sourcePath);
  const sourceChecksum = sha256File(guard.sourcePath);
  const targetUrl = new URL(env.DATABASE_URL);
  const tls = buildPostgresTlsOptions(targetUrl, env, guard.isDisposableLocal);
  const client = new Client({ connectionString: env.DATABASE_URL, ssl: tls });
  const summary = Object.fromEntries(source.tables.map((table) => [table, source.tableInfo.get(table).count]));
  console.log(`Legacy SQLite preflight: tables=${source.tables.length}, rows=${Object.values(summary).reduce((a, b) => a + b, 0)}`);
  console.log(`Target PostgreSQL: host=${targetUrl.hostname}, database=${guard.databaseName}, dryRun=${guard.dryRun}`);

  try {
    await client.connect();
    const identity = await client.query(
      'SELECT current_database() AS database, inet_server_addr()::text AS address, current_user AS username'
    );
    if (identity.rows[0].database !== guard.databaseName) {
      throw new Error('Connected PostgreSQL database does not match DATABASE_URL');
    }
    if (guard.isDisposableLocal && !isLocalPostgresHost(targetUrl.hostname)) {
      throw new Error('Connected target is not the expected local disposable PostgreSQL');
    }
    const target = await inspectPostgres(client);
    validateSchemaCompatibility(source, target);
    await assertEmptyTarget(client, source.tables);
    const order = dependencyOrder(source.tables, source.foreignKeys);
    console.log(`Validated migration order: ${order.join(', ')}`);
    if (guard.dryRun) {
      console.log('Dry-run complete; no PostgreSQL changes were made.');
      return { dryRun: true, tables: source.tables.length, rows: summary };
    }

    await client.query('BEGIN');
    try {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('linquan-legacy-sqlite-migration'))");
      await assertEmptyTarget(client, source.tables);
      await client.query('SET CONSTRAINTS ALL DEFERRED');
      await migrateRows(client, source, target, order);
      await validateMigratedRows(client, source);
      await client.query(
        `CREATE TABLE IF NOT EXISTS public.legacy_sqlite_migrations (
           id BIGSERIAL PRIMARY KEY,
           source_sha256 TEXT NOT NULL UNIQUE,
           source_table_count INTEGER NOT NULL,
           source_row_count BIGINT NOT NULL,
           migrated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
         )`
      );
      await client.query(
        `INSERT INTO public.legacy_sqlite_migrations
           (source_sha256, source_table_count, source_row_count)
         VALUES ($1, $2, $3)`,
        [sourceChecksum, source.tables.length, Object.values(summary).reduce((a, b) => a + b, 0)]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
    console.log(`Legacy migration complete: tables=${source.tables.length}`);
    return { dryRun: false, tables: source.tables.length, rows: summary };
  } finally {
    source.sqlite.close();
    await client.end().catch(() => {});
  }
}

const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  runLegacyMigration().catch((err) => {
    console.error(`Legacy migration refused or failed: ${err.message}`);
    process.exitCode = 1;
  });
}
