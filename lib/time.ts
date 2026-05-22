const SP_TIMEZONE = "America/Sao_Paulo";
const DAY_MS = 24 * 60 * 60 * 1000;

function getDatePartsInTimeZone(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );

  return asUtc - date.getTime();
}

function zonedMidnightToUtcMs(year: number, month: number, day: number, timeZone: string) {
  const utcGuess = Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  const offset = getTimeZoneOffsetMs(new Date(utcGuess), timeZone);
  return utcGuess - offset;
}

function getMonthStartMsInTimeZone(timestamp: number, timeZone: string) {
  const { year, month } = getDatePartsInTimeZone(new Date(timestamp), timeZone);
  return zonedMidnightToUtcMs(year, month, 1, timeZone);
}

function addMonth(year: number, month: number) {
  if (month === 12) {
    return {
      year: year + 1,
      month: 1,
    };
  }

  return {
    year,
    month: month + 1,
  };
}

export function getStartOfTodaySPMs() {
  const { year, month, day } = getDatePartsInTimeZone(new Date(), SP_TIMEZONE);
  return zonedMidnightToUtcMs(year, month, day, SP_TIMEZONE);
}

export function getStartOfWeekSPMs() {
  return getStartOfTodaySPMs() - 7 * DAY_MS;
}

export function getStartOfMonthSPMs() {
  const { year, month } = getDatePartsInTimeZone(new Date(), SP_TIMEZONE);
  return zonedMidnightToUtcMs(year, month, 1, SP_TIMEZONE);
}

export function getMonthRangeSegments(
  startMs: number,
  endMs: number,
  timeZone: string = SP_TIMEZONE,
  referenceDate: Date = new Date()
) {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }

  const current = getDatePartsInTimeZone(referenceDate, timeZone);
  const previous = current.month === 1
    ? { year: current.year - 1, month: 12 }
    : { year: current.year, month: current.month - 1 };

  const segments: Array<{
    after: number;
    before: number;
    year: number;
    month: number;
    monthStartMs: number;
    nextMonthStartMs: number;
    recency: "current" | "previous" | "historical";
  }> = [];

  let cursor = startMs;

  while (cursor < endMs) {
    const { year, month } = getDatePartsInTimeZone(new Date(cursor), timeZone);
    const monthStartMs = getMonthStartMsInTimeZone(cursor, timeZone);
    const next = addMonth(year, month);
    const nextMonthStartMs = zonedMidnightToUtcMs(next.year, next.month, 1, timeZone);
    const before = Math.min(endMs, nextMonthStartMs);

    let recency: "current" | "previous" | "historical" = "historical";
    if (year === current.year && month === current.month) {
      recency = "current";
    } else if (year === previous.year && month === previous.month) {
      recency = "previous";
    }

    segments.push({
      after: cursor,
      before,
      year,
      month,
      monthStartMs,
      nextMonthStartMs,
      recency,
    });

    cursor = before;
  }

  return segments;
}

export const TIMEZONE_SP = SP_TIMEZONE;
