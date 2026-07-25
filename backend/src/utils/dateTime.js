const BEIJING_OFFSET_MINUTES = 8 * 60;

function hasExplicitTimezone(rawValue) {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(rawValue || '').trim());
}

function parseNaiveDateTime(rawValue, offsetMinutes = 0) {
  const text = String(rawValue || '').trim().replace(' ', 'T');
  const match = text.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/
  );
  if (!match) {
    return null;
  }

  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second = '0',
    millisecond = '0'
  ] = match;

  const utcMillis = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour),
    Number(minute) - offsetMinutes,
    Number(second),
    Number(millisecond.padEnd(3, '0'))
  );

  const date = new Date(utcMillis);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseTimestampValue(rawValue, { naiveTimezone = 'utc' } = {}) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    return null;
  }

  if (rawValue instanceof Date) {
    return Number.isNaN(rawValue.getTime()) ? null : rawValue;
  }

  if (typeof rawValue === 'number') {
    const numericDate = new Date(rawValue);
    return Number.isNaN(numericDate.getTime()) ? null : numericDate;
  }

  const text = String(rawValue).trim();
  if (!text) {
    return null;
  }

  if (hasExplicitTimezone(text)) {
    const explicitDate = new Date(text);
    return Number.isNaN(explicitDate.getTime()) ? null : explicitDate;
  }

  const naiveDate = parseNaiveDateTime(
    text,
    naiveTimezone === 'beijing' ? BEIJING_OFFSET_MINUTES : 0
  );
  if (naiveDate) {
    return naiveDate;
  }

  const fallbackDate = new Date(text);
  return Number.isNaN(fallbackDate.getTime()) ? null : fallbackDate;
}

function toUtcIsoString(rawValue, options = {}) {
  const date = parseTimestampValue(rawValue, options);
  return date ? date.toISOString() : null;
}

function currentUtcIsoString() {
  return new Date().toISOString();
}

function normalizePublishingEventTimeInput(rawValue) {
  if (rawValue === undefined) {
    return undefined;
  }
  if (rawValue === null || rawValue === '') {
    return null;
  }
  return toUtcIsoString(rawValue, { naiveTimezone: 'beijing' });
}

function serializePublishingTimestamps(item) {
  if (!item || typeof item !== 'object') {
    return item;
  }

  const serialized = { ...item };
  if (Object.prototype.hasOwnProperty.call(serialized, 'eventTime')) {
    serialized.eventTime = toUtcIsoString(serialized.eventTime, { naiveTimezone: 'beijing' });
  }
  if (Object.prototype.hasOwnProperty.call(serialized, 'applicationDeadline')) {
    serialized.applicationDeadline = toUtcIsoString(serialized.applicationDeadline, { naiveTimezone: 'beijing' });
  }
  for (const field of ['createdAt', 'updatedAt', 'publishedAt', 'uploadedAt']) {
    if (Object.prototype.hasOwnProperty.call(serialized, field)) {
      serialized[field] = toUtcIsoString(serialized[field], { naiveTimezone: 'utc' });
    }
  }
  return serialized;
}

export {
  currentUtcIsoString,
  normalizePublishingEventTimeInput,
  parseTimestampValue,
  serializePublishingTimestamps,
  toUtcIsoString
};
