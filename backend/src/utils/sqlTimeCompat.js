import { DATABASE_URL } from '../config/env.js';

const isPostgres = Boolean(DATABASE_URL);

function normalizeTimestampExpression(column) {
  if (!isPostgres) {
    return column;
  }

  if (/\bpublished_at\b/i.test(column)) {
    return `(${column} AT TIME ZONE 'UTC')`;
  }

  return `NULLIF(BTRIM(CAST(${column} AS TEXT)), '')::timestamptz`;
}

function coalescedTimestampOrder(...columns) {
  const normalized = columns.filter(Boolean).map((column) => normalizeTimestampExpression(column));
  if (!normalized.length) {
    throw new Error('coalescedTimestampOrder requires at least one column');
  }
  return `COALESCE(${normalized.join(', ')})`;
}

export {
  coalescedTimestampOrder
};
