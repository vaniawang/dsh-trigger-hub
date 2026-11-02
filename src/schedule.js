/**
 * Schedule parsing for the trigger hub: interval expressions (`90s`, `5m`,
 * `6h`, `2d`) and five-field cron expressions (`m h dom mon dow`).
 * Pure functions, no I/O, no dependencies.
 */

const UNIT_MS = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const DURATION = /^(\d+)\s*(s|m|h|d)$/;

/** Parses `30s`, `5m`, `6h`, `2d` into milliseconds. Throws on bad input. */
export function parseDuration(text) {
  const match = DURATION.exec(String(text ?? '').trim().toLowerCase());
  if (!match) throw new Error(`invalid duration: ${JSON.stringify(text)} (use 30s, 5m, 6h or 2d)`);
  const value = Number(match[1]) * UNIT_MS[match[2]];
  if (!Number.isFinite(value) || value < 1000) throw new Error('duration must be at least 1s');
  return value;
}

const FIELD = /^(\*|\d+|\d+-\d+|\*\/\d+|\d+(,\d+)*|\d+-\d+\/\d+)$/;

function parseField(text, min, max, label) {
  const values = new Set();
  for (const part of String(text).split(',')) {
    if (part === '*') {
      for (let value = min; value <= max; value += 1) values.add(value);
      continue;
    }
    const step = /^\*\/(\d+)$/.exec(part);
    if (step) {
      const size = Number(step[1]);
      if (size < 1) throw new Error(`${label}: step must be positive`);
      for (let value = min; value <= max; value += size) values.add(value);
      continue;
    }
    const range = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(part);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      const size = range[3] === undefined ? 1 : Number(range[3]);
      if (from < min || to > max || from > to || size < 1) throw new Error(`${label}: invalid range ${part}`);
      for (let value = from; value <= to; value += size) values.add(value);
      continue;
    }
    if (/^\d+$/.test(part)) {
      const value = Number(part);
      if (value < min || value > max) throw new Error(`${label}: ${value} is outside ${min}-${max}`);
      values.add(value);
      continue;
    }
    throw new Error(`${label}: invalid part ${JSON.stringify(part)}`);
  }
  return values;
}

/**
 * Parses a five-field cron expression. Day-of-week accepts 0-7 (0 and 7 are
 * Sunday). Returns the five value sets; use nextCronTime for the next fire.
 */
export function parseCron(expression) {
  const fields = String(expression ?? '').trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron must have five fields: minute hour day-of-month month day-of-week');
  for (const field of fields) if (!FIELD.test(field)) throw new Error(`invalid cron field: ${field}`);
  return {
    minutes: parseField(fields[0], 0, 59, 'minute'),
    hours: parseField(fields[1], 0, 23, 'hour'),
    daysOfMonth: parseField(fields[2], 1, 31, 'day-of-month'),
    months: parseField(fields[3], 1, 12, 'month'),
    daysOfWeek: parseField(fields[4], 0, 7, 'day-of-week'),
  };
}

const dayMatches = (cron, date) => {
  const dom = cron.daysOfMonth.has(date.getDate());
  const rawDow = date.getDay();
  const dow = cron.daysOfWeek.has(rawDow) || (rawDow === 0 && cron.daysOfWeek.has(7));
  // Standard cron: when both day fields are restricted, either may match.
  const domRestricted = cron.daysOfMonth.size < 31;
  const dowRestricted = cron.daysOfWeek.size < 8;
  if (domRestricted && dowRestricted) return dom || dow;
  return dom && dow;
};

/** Returns the next Date strictly after `from` that matches the cron, or null. */
export function nextCronTime(expression, from = new Date()) {
  const cron = parseCron(expression);
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let step = 0; step < limit; step += 1) {
    if (cron.months.has(cursor.getMonth() + 1)
      && dayMatches(cron, cursor)
      && cron.hours.has(cursor.getHours())
      && cron.minutes.has(cursor.getMinutes())) {
      return new Date(cursor.getTime());
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
    if (cursor.getSeconds() !== 0) cursor.setSeconds(0, 0);
  }
  return null;
}

/**
 * Normalizes one schedule source into `{ kind: 'cron'|'interval', ms?, expression? }`.
 * Exactly one of `cron` / `every` is required.
 */
export function scheduleOf(source) {
  if (source.cron !== undefined && source.every !== undefined) {
    throw new Error(`source ${source.id}: use either cron or every, not both`);
  }
  if (source.cron !== undefined) {
    parseCron(source.cron);
    return { kind: 'cron', expression: String(source.cron) };
  }
  if (source.every !== undefined) {
    return { kind: 'interval', ms: parseDuration(source.every) };
  }
  throw new Error(`source ${source.id}: a schedule source needs cron or every`);
}

/** Milliseconds until the next fire, or null when the cron never matches. */
export function delayUntilNext(source, now = new Date()) {
  const schedule = scheduleOf(source);
  if (schedule.kind === 'interval') return schedule.ms;
  const next = nextCronTime(schedule.expression, now);
  return next === null ? null : Math.max(1000, next.getTime() - now.getTime());
}
