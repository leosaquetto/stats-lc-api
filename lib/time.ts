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

export const TIMEZONE_SP = SP_TIMEZONE;
