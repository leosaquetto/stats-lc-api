import { createHistoryMonth, listHistoryMonths, parseHistoryMonth, type HistoryMonth } from "./history-backup.js";
import { historyStore, usingDurableHistoryStore, type HistoryStoredStream } from "./history-store.js";
import { TIMEZONE_SP } from "./time.js";

export type LocalHistoryRange = {
  afterMs: number;
  beforeMs: number;
  months: HistoryMonth[];
};

export type LocalHistoryStreamsResult = {
  ok: boolean;
  source: "history_store";
  complete: boolean;
  userKey: string;
  afterMs: number;
  beforeMs: number;
  limit: number;
  offset: number;
  total: number;
  items: any[];
  missingMonths: string[];
};

const MONTH_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE_SP,
  year: "numeric",
  month: "2-digit",
});

function monthLabel(month: Pick<HistoryMonth, "year" | "month">) {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

function monthFromTimestamp(timestamp: number) {
  return parseHistoryMonth(MONTH_FORMATTER.format(new Date(timestamp)));
}

export function resolveClosedMonthRange(afterMs: number, beforeMs: number): LocalHistoryRange | null {
  if (!Number.isFinite(afterMs) || !Number.isFinite(beforeMs) || beforeMs <= afterMs) return null;
  const from = monthFromTimestamp(afterMs);
  const beforePreviousMs = beforeMs - 1;
  if (beforePreviousMs < afterMs) return null;
  const to = monthFromTimestamp(beforePreviousMs);
  const months = listHistoryMonths(from, to);
  if (months.length === 0) return null;

  const first = months[0];
  const last = months[months.length - 1];
  if (afterMs !== first.afterMs || beforeMs !== last.beforeMs) return null;
  return { afterMs, beforeMs, months };
}

export async function getLocalHistoryCoverage(userKey: string, range: LocalHistoryRange) {
  if (!usingDurableHistoryStore()) return { complete: false, missingMonths: range.months.map(monthLabel), completeMonths: [] };
  const completeMonths = await historyStore.listCompleteMonths(userKey, range.afterMs, range.beforeMs);
  const completeMonthKeys = new Set(completeMonths.map(monthLabel));
  const missingMonths = range.months.map(monthLabel).filter((month) => !completeMonthKeys.has(month));
  return { complete: missingMonths.length === 0, missingMonths, completeMonths };
}

export function historyEventToStream(event: HistoryStoredStream) {
  return {
    ...event.raw,
    playedAt: event.playedAt,
    playedAtMs: event.playedAtMs,
    trackId: event.trackId ?? event.raw?.trackId,
    albumId: event.albumId ?? event.raw?.albumId,
    playedMs: event.playedMs,
    track: event.raw?.track
      ? {
          ...event.raw.track,
          id: event.raw.track.id ?? event.trackId,
        }
      : event.trackId
        ? { id: event.trackId }
        : event.raw?.track,
  };
}

export async function fetchLocalHistoryStreams(input: {
  userKey: string;
  afterMs: number;
  beforeMs: number;
  limit?: number;
  offset?: number;
  order?: "asc" | "desc";
}): Promise<LocalHistoryStreamsResult | null> {
  const range = resolveClosedMonthRange(input.afterMs, input.beforeMs);
  if (!range) return null;
  const coverage = await getLocalHistoryCoverage(input.userKey, range);
  const limit = Math.max(1, Math.min(10000, Number(input.limit || 100)));
  const offset = Math.max(0, Number(input.offset || 0));
  if (!coverage.complete) {
    return {
      ok: false,
      source: "history_store",
      complete: false,
      userKey: input.userKey,
      afterMs: input.afterMs,
      beforeMs: input.beforeMs,
      limit,
      offset,
      total: 0,
      items: [],
      missingMonths: coverage.missingMonths,
    };
  }

  const events = await historyStore.listEvents({
    userKey: input.userKey,
    afterMs: input.afterMs,
    beforeMs: input.beforeMs,
    limit,
    offset,
    order: input.order,
  });
  const total = coverage.completeMonths.reduce((sum, month) => sum + month.storedCount, 0);
  return {
    ok: true,
    source: "history_store",
    complete: true,
    userKey: input.userKey,
    afterMs: input.afterMs,
    beforeMs: input.beforeMs,
    limit,
    offset,
    total,
    items: events.map(historyEventToStream),
    missingMonths: [],
  };
}

export function createClosedMonthRange(from: string, to: string) {
  const start = parseHistoryMonth(from);
  const end = parseHistoryMonth(to);
  return {
    afterMs: createHistoryMonth(start.year, start.month).afterMs,
    beforeMs: createHistoryMonth(end.year, end.month).beforeMs,
  };
}
