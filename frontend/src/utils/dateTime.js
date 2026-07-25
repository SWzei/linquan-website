const BEIJING_TIMEZONE = 'Asia/Shanghai';

function parseUtcValue(value) {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getLocaleTag(locale) {
  return locale === 'zh' ? 'zh-CN' : 'en-US';
}

function formatDateTimeInBeijing(value, locale = 'zh') {
  const date = parseUtcValue(value);
  if (!date) {
    return '-';
  }
  return new Intl.DateTimeFormat(getLocaleTag(locale), {
    timeZone: BEIJING_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date);
}

function toDateTimeInputPart(value, locale = 'zh') {
  const date = parseUtcValue(value);
  if (!date) {
    return '';
  }

  const formatter = new Intl.DateTimeFormat(getLocaleTag(locale), {
    timeZone: BEIJING_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );

  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function utcIsoToBeijingInput(value) {
  return toDateTimeInputPart(value, 'zh');
}

function beijingInputToUtcIso(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const normalized = text.replace(' ', 'T');
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) {
    return '';
  }

  const [, year, month, day, hour, minute] = match;
  return new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day), Number(hour) - 8, Number(minute), 0, 0)
  ).toISOString();
}

function toUtcMillis(value) {
  const date = parseUtcValue(value);
  return date ? date.getTime() : 0;
}

export {
  beijingInputToUtcIso,
  formatDateTimeInBeijing,
  toUtcMillis,
  utcIsoToBeijingInput
};
