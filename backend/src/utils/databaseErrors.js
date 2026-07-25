function normalizedErrorText(err) {
  return [
    err?.message,
    err?.detail,
    err?.constraint,
    err?.table,
    err?.column
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

export function isUniqueConstraintError(
  err,
  {
    table = '',
    column = '',
    constraints = []
  } = {}
) {
  const code = String(err?.code || '');
  const text = normalizedErrorText(err);
  const unique =
    code === '23505'
    || code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'SQLITE_CONSTRAINT_PRIMARYKEY'
    || /sqlite_constraint_unique|unique constraint failed|duplicate key value violates unique constraint/i.test(text);

  if (!unique) return false;

  const expected = [
    ...constraints,
    table && column ? `${table}.${column}` : '',
    table,
    column
  ]
    .map((value) => String(value || '').trim().toLowerCase())
    .filter(Boolean);

  return expected.length === 0 || expected.some((value) => text.includes(value));
}
