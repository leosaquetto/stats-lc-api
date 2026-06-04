import { buildQuery, encodeSegment, getItems, mapWithConcurrency } from "./api-helpers.js";
import {
  getCardinality,
  getCount,
  getDatesBreakdown,
  getDurationMs,
  statsfmFetch,
} from "./statsfm.js";
import { TIMEZONE_SP } from "./time.js";

type FetchOptions = NonNullable<Parameters<typeof statsfmFetch>[1]>;
type DateBucket = { count: number; durationMs: number };

const DATE_FALLBACK_PAGE_SIZE = 1000;
const DATE_FALLBACK_MAX_STREAMS = 12000;
const DATE_PARTS_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: TIMEZONE_SP,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  weekday: "short",
  hour: "numeric",
  hourCycle: "h23",
});

export function buildUserRangeQuery(after: string | number, before?: string | number | null) {
  return buildQuery({ after, before });
}

export async function fetchUserStatsRange(
  userId: string,
  after: string | number,
  before?: string | number | null,
  options: FetchOptions = {}
) {
  return statsfmFetch(
    `/users/${encodeSegment(userId)}/streams/stats${buildUserRangeQuery(after, before)}`,
    options
  );
}

export async function fetchUserDatesRange(
  userId: string,
  after: string | number,
  before?: string | number | null,
  options: FetchOptions = {}
) {
  return statsfmFetch(
    `/users/${encodeSegment(userId)}/streams/dates${buildUserRangeQuery(after, before)}`,
    options
  );
}

function createDateBucketMap(start: number, end: number) {
  return Array.from({ length: end - start + 1 }).reduce<Record<string, DateBucket>>((acc, _, offset) => {
    acc[String(start + offset)] = { count: 0, durationMs: 0 };
    return acc;
  }, {});
}

function readStreamTimestamp(stream: any) {
  const raw = stream?.playedAt ?? stream?.endTime ?? stream?.timestamp ?? stream?.date ?? stream?.t;
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return raw < 2147483647 ? raw * 1000 : raw;
  }
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readStreamDurationMs(stream: any) {
  const value = stream?.playedMs ?? stream?.durationMs ?? stream?.track?.durationMs ?? 0;
  return Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;
}

function getDateParts(timestamp: number) {
  const values = Object.fromEntries(
    DATE_PARTS_FORMATTER.formatToParts(new Date(timestamp)).map((part) => [part.type, part.value])
  );
  const weekDay = new Date(Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day)
  )).getUTCDay() + 1;
  return {
    hour: Number(values.hour) % 24,
    month: Number(values.month),
    monthDay: Number(values.day),
    weekDay,
  };
}

function aggregateDateBuckets(streams: any[]) {
  const hours = createDateBucketMap(0, 23);
  const months = createDateBucketMap(1, 12);
  const weekDays = createDateBucketMap(1, 7);
  const monthDays = createDateBucketMap(1, 31);
  let aggregatedCount = 0;

  for (const stream of streams) {
    const timestamp = readStreamTimestamp(stream);
    if (timestamp == null) continue;
    const durationMs = readStreamDurationMs(stream);
    const parts = getDateParts(timestamp);
    const buckets = [
      hours[String(parts.hour)],
      months[String(parts.month)],
      weekDays[String(parts.weekDay)],
      monthDays[String(parts.monthDay)],
    ];
    if (buckets.some((bucket) => !bucket)) continue;

    for (const bucket of buckets) {
      bucket.count += 1;
      bucket.durationMs += durationMs;
    }
    aggregatedCount += 1;
  }

  return {
    items: { hours, months, weekDays, monthDays },
    aggregatedCount,
  };
}

export async function fetchUserDatesFallbackFromStreams(
  userId: string,
  after: string | number,
  before?: string | number | null,
  options: FetchOptions = {}
) {
  const statsResult = await fetchUserStatsRange(userId, after, before, {
    ...options,
    force: false,
    cacheProfile: "heavy",
  });
  if (!statsResult.ok) {
    return {
      ok: false as const,
      status: statsResult.status,
      endpoint: statsResult.endpoint,
    };
  }

  const totalCount = getCount(statsResult.data);
  const requestedCount = Math.min(totalCount, DATE_FALLBACK_MAX_STREAMS);
  const offsets = Array.from(
    { length: Math.ceil(requestedCount / DATE_FALLBACK_PAGE_SIZE) },
    (_, index) => index * DATE_FALLBACK_PAGE_SIZE
  );

  const pages = await mapWithConcurrency(offsets, 3, (offset) =>
    statsfmFetch(
      `/users/${encodeSegment(userId)}/streams${buildQuery({
        after,
        before,
        limit: Math.min(DATE_FALLBACK_PAGE_SIZE, requestedCount - offset),
        offset,
      })}`,
      { ...options, force: false, cacheProfile: "heavy" }
    )
  );
  const successfulPages = pages
    .filter((page): page is PromiseFulfilledResult<Awaited<ReturnType<typeof statsfmFetch>>> =>
      page.status === "fulfilled" && page.value.ok
    )
    .map((page) => page.value);

  if (totalCount > 0 && successfulPages.length === 0) {
    return {
      ok: false as const,
      status: 502,
      endpoint: `/users/${encodeSegment(userId)}/streams`,
    };
  }

  const streams = successfulPages.flatMap((page) => getItems(page.data)).slice(0, requestedCount);
  const aggregate = aggregateDateBuckets(streams);
  return {
    ok: true as const,
    ...aggregate,
    coverage: {
      source: "streams_fallback",
      totalCount,
      requestedCount,
      aggregatedCount: aggregate.aggregatedCount,
      partial: totalCount > aggregate.aggregatedCount,
      maxStreams: DATE_FALLBACK_MAX_STREAMS,
    },
  };
}

export function normalizeStatsSummary(data: unknown) {
  const durationMs = getDurationMs(data);
  return {
    streams: getCount(data),
    durationMs,
    minutes: Math.floor(durationMs / 60000),
    hours: Math.floor(durationMs / 3600000),
  };
}

export function normalizeStatsCardinality(data: unknown) {
  return {
    ...normalizeStatsSummary(data),
    cardinality: getCardinality(data),
  };
}

export function normalizeDatesSummary(data: unknown) {
  return getDatesBreakdown(data);
}
