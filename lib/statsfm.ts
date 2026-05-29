import { getMonthRangeSegments, TIMEZONE_SP } from "./time.js";

const API_BASE = "https://api.stats.fm/api/v1";
const DEFAULT_FRESH_TTL_MS = 60_000;
const STALE_TTL_MS = 10 * 60_000;
const FORCE_COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 300;
const MAX_RETRIES = 1;
const LIVE_FRESH_TTL_MS = 20_000;
const LIVE_STALE_TTL_MS = 45_000;
const REPLAY_FRESH_TTL_MS = 5 * 60_000;
const REPLAY_STALE_TTL_MS = 10 * 60_000;
const HEAVY_FRESH_TTL_MS = 15 * 60_000;
const HEAVY_STALE_TTL_MS = 24 * 60 * 60_000;
const CURRENT_MONTH_FRESH_TTL_MS = 5 * 60_000;
const PREVIOUS_MONTH_FRESH_TTL_MS = 12 * 60 * 60_000;
const HISTORICAL_MONTH_FRESH_TTL_MS = 7 * 24 * 60 * 60_000;

export type StatsfmResult = {
  ok: boolean;
  status: number;
  endpoint: string;
  data: unknown;
};

type AggregateMode = "auto" | "none";
type CacheProfile = "default" | "live" | "replay" | "heavy";

type StatsfmFetchOptions = {
  force?: boolean;
  aggregateMode?: AggregateMode;
  cacheProfile?: CacheProfile;
  requestTimeoutMs?: number;
  maxRetries?: number;
};

type CacheScope = "path" | "monthly_segment";
type SegmentKind = "stats" | "dates" | null;

type CacheEntry = {
  result: StatsfmResult;
  cachedAt: number;
  expiresAt: number;
  staleUntil: number;
  freshTtlMs: number;
  staleTtlMs: number;
  cacheProfile: CacheProfile;
  lastErrorAt: number | null;
  lastErrorStatus: number | null;
  lastErrorReason: string | null;
  lastServedAt: number;
  scope: CacheScope;
  segmentKind: SegmentKind;
};

type InternalFetchOutcome = {
  result: StatsfmResult;
  source: "upstream" | "cache";
};

type FetchCacheConfig = {
  freshTtlMs: number;
  staleTtlMs: number;
  cacheProfile: CacheProfile;
  scope: CacheScope;
  segmentKind: SegmentKind;
};

type TemporalAggregateKind = "stats" | "dates";

type TemporalAggregateDescriptor = {
  kind: TemporalAggregateKind;
  pathname: string;
  originalPath: string;
  after: number;
  before: number;
  baseParams: Array<[string, string]>;
};

type DateBucket = {
  count: number;
  durationMs: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<StatsfmResult>>();
const forceCooldowns = new Map<string, number>();
const metrics = {
  upstreamRequests: 0,
  retries: 0,
  timeouts: 0,
  staleServed: 0,
  cacheHits: 0,
  dedupedRequests: 0,
  cooldownHits: 0,
  aggregateSegmentReuses: 0,
};
const startedAt = Date.now();
let nowOverride: number | null = null;

function now() {
  return nowOverride ?? Date.now();
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizePath(path: string) {
  if (!path) return "/";
  return path.startsWith("/") ? path : `/${path}`;
}

function getEndpoint(path: string) {
  return `${API_BASE}${normalizePath(path)}`;
}

function getCacheEntry(path: string) {
  return cache.get(normalizePath(path)) ?? null;
}

function isFresh(entry: CacheEntry | null, timestamp: number) {
  return Boolean(entry && entry.expiresAt > timestamp);
}

function isStaleUsable(entry: CacheEntry | null, timestamp: number) {
  return Boolean(entry && entry.staleUntil > timestamp && entry.result.ok);
}

function updateErrorState(path: string, error: { status?: number; reason?: string }) {
  const key = normalizePath(path);
  const existing = cache.get(key);

  if (!existing) return;

  cache.set(key, {
    ...existing,
    lastErrorAt: now(),
    lastErrorStatus: error.status ?? null,
    lastErrorReason: error.reason ?? null,
  });
}

function saveSuccess(path: string, result: StatsfmResult, config: FetchCacheConfig) {
  const timestamp = now();
  const key = normalizePath(path);

  cache.set(key, {
    result,
    cachedAt: timestamp,
    expiresAt: timestamp + config.freshTtlMs,
    staleUntil: timestamp + config.freshTtlMs + config.staleTtlMs,
    freshTtlMs: config.freshTtlMs,
    staleTtlMs: config.staleTtlMs,
    cacheProfile: config.cacheProfile,
    lastErrorAt: null,
    lastErrorStatus: null,
    lastErrorReason: null,
    lastServedAt: timestamp,
    scope: config.scope,
    segmentKind: config.segmentKind,
  });
}

function markServed(path: string) {
  const key = normalizePath(path);
  const existing = cache.get(key);

  if (!existing) return;

  cache.set(key, {
    ...existing,
    lastServedAt: now(),
  });
}

function shouldRetryStatus(status: number) {
  return [500, 502, 503, 504].includes(status);
}

function getDefaultCacheConfig(): FetchCacheConfig {
  return {
    freshTtlMs: DEFAULT_FRESH_TTL_MS,
    staleTtlMs: STALE_TTL_MS,
    cacheProfile: "default",
    scope: "path",
    segmentKind: null,
  };
}

function getCacheConfigForOptions(options?: StatsfmFetchOptions): FetchCacheConfig {
  if (options?.cacheProfile === "live") {
    return {
      freshTtlMs: LIVE_FRESH_TTL_MS,
      staleTtlMs: LIVE_STALE_TTL_MS,
      cacheProfile: "live",
      scope: "path",
      segmentKind: null,
    };
  }

  if (options?.cacheProfile === "replay") {
    return {
      freshTtlMs: REPLAY_FRESH_TTL_MS,
      staleTtlMs: REPLAY_STALE_TTL_MS,
      cacheProfile: "replay",
      scope: "path",
      segmentKind: null,
    };
  }

  if (options?.cacheProfile === "heavy") {
    return {
      freshTtlMs: HEAVY_FRESH_TTL_MS,
      staleTtlMs: HEAVY_STALE_TTL_MS,
      cacheProfile: "heavy",
      scope: "path",
      segmentKind: null,
    };
  }

  return getDefaultCacheConfig();
}

function getMonthlyCacheConfig(kind: TemporalAggregateKind, recency: "current" | "previous" | "historical"): FetchCacheConfig {
  const freshTtlMs = recency === "current"
    ? CURRENT_MONTH_FRESH_TTL_MS
    : recency === "previous"
      ? PREVIOUS_MONTH_FRESH_TTL_MS
      : HISTORICAL_MONTH_FRESH_TTL_MS;

  return {
    freshTtlMs,
    staleTtlMs: STALE_TTL_MS,
    cacheProfile: "default",
    scope: "monthly_segment",
    segmentKind: kind,
  };
}

async function parseResponse(response: Response) {
  const text = await response.text();

  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  return data;
}

async function fetchUpstream(
  path: string,
  force: boolean,
  attempt: number,
  options?: Pick<StatsfmFetchOptions, "requestTimeoutMs" | "maxRetries">
): Promise<StatsfmResult> {
  const endpoint = getEndpoint(path);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), options?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
  const maxRetries = options?.maxRetries ?? MAX_RETRIES;

  metrics.upstreamRequests += 1;

  try {
    const response = await fetch(endpoint, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
      },
      cache: force ? "no-store" : "default",
      signal: controller.signal,
    });

    const data = await parseResponse(response);
    const result: StatsfmResult = {
      ok: response.ok,
      status: response.status,
      endpoint,
      data,
    };

    if (!result.ok && shouldRetryStatus(result.status) && attempt < maxRetries) {
      updateErrorState(path, { status: result.status, reason: `http_${result.status}` });
      metrics.retries += 1;
      await sleep(RETRY_DELAY_MS);
      return fetchUpstream(path, force, attempt + 1, options);
    }

    return result;
  } catch (error: any) {
    const aborted = error?.name === "AbortError";
    const reason = aborted ? "timeout" : "network_error";

    if (aborted) metrics.timeouts += 1;

    updateErrorState(path, { reason });

    if (attempt < maxRetries) {
      metrics.retries += 1;
      await sleep(RETRY_DELAY_MS);
      return fetchUpstream(path, force, attempt + 1, options);
    }

    return {
      ok: false,
      status: 504,
      endpoint,
      data: {
        error: reason,
      },
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function executeFetch(
  path: string,
  options?: StatsfmFetchOptions,
  cacheConfig?: FetchCacheConfig
): Promise<InternalFetchOutcome> {
  const resolvedCacheConfig = cacheConfig ?? getCacheConfigForOptions(options);
  const key = normalizePath(path);
  const timestamp = now();
  const force = options?.force === true;
  const cached = getCacheEntry(key);
  const forceCooldownUntil = forceCooldowns.get(key) ?? 0;

  if (!force && isFresh(cached, timestamp)) {
    metrics.cacheHits += 1;
    if (cached?.scope === "monthly_segment") metrics.aggregateSegmentReuses += 1;
    markServed(key);
    return {
      result: cached!.result,
      source: "cache",
    };
  }

  if (
    force &&
    forceCooldownUntil > timestamp &&
    (isFresh(cached, timestamp) || isStaleUsable(cached, timestamp))
  ) {
    metrics.cooldownHits += 1;
    if (cached?.scope === "monthly_segment") metrics.aggregateSegmentReuses += 1;
    markServed(key);
    return {
      result: cached!.result,
      source: "cache",
    };
  }

  const running = inflight.get(key);
  if (running) {
    metrics.dedupedRequests += 1;
    return {
      result: await running,
      source: "upstream",
    };
  }

  const request = (async () => {
    const upstream = await fetchUpstream(key, force, 0, {
      requestTimeoutMs: options?.requestTimeoutMs,
      maxRetries: options?.maxRetries,
    });

    if (upstream.ok) {
      saveSuccess(key, upstream, resolvedCacheConfig);
      if (force) {
        forceCooldowns.set(key, now() + FORCE_COOLDOWN_MS);
      }
      return upstream;
    }

    updateErrorState(key, {
      status: upstream.status,
      reason:
        typeof (upstream.data as any)?.error === "string"
          ? (upstream.data as any).error
          : `http_${upstream.status}`,
    });

    const fallback = getCacheEntry(key);
    if (isStaleUsable(fallback, now())) {
      metrics.staleServed += 1;
      if (fallback?.scope === "monthly_segment") metrics.aggregateSegmentReuses += 1;
      markServed(key);
      return fallback!.result;
    }

    return upstream;
  })();

  inflight.set(key, request);

  try {
    const result = await request;
    return {
      result,
      source: "upstream",
    };
  } finally {
    inflight.delete(key);
  }
}

function readNumber(value: unknown) {
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : 0;
}

function isTemporalAggregateKind(value: string): value is TemporalAggregateKind {
  return value === "stats" || value === "dates";
}

function parseTemporalAggregatePath(path: string): TemporalAggregateDescriptor | null {
  const normalized = normalizePath(path);
  const url = new URL(normalized, "https://stats.local");
  const segments = url.pathname.split("/").filter(Boolean);

  if (segments.length !== 4 || segments[0] !== "users" || segments[2] !== "streams") {
    return null;
  }

  const kind = segments[3];
  if (!isTemporalAggregateKind(kind)) {
    return null;
  }

  const afterRaw = url.searchParams.get("after");
  if (!afterRaw) return null;

  const after = Number(afterRaw);
  if (!Number.isFinite(after)) return null;

  const beforeRaw = url.searchParams.get("before");
  const before = beforeRaw ? Number(beforeRaw) : now();
  if (!Number.isFinite(before) || before <= after) return null;

  const baseParams = [...url.searchParams.entries()].filter(
    ([key]) => key !== "after" && key !== "before"
  );

  return {
    kind,
    pathname: url.pathname,
    originalPath: normalized,
    after,
    before,
    baseParams,
  };
}

function buildSegmentPath(descriptor: TemporalAggregateDescriptor, after: number, before: number) {
  const params = new URLSearchParams(descriptor.baseParams);
  params.set("after", String(after));
  params.set("before", String(before));
  return `${descriptor.pathname}?${params.toString()}`;
}

function createDateBucketMap(start: number, end: number) {
  return Array.from({ length: end - start + 1 }).reduce<Record<string, DateBucket>>((acc, _, offset) => {
    acc[String(start + offset)] = {
      count: 0,
      durationMs: 0,
    };
    return acc;
  }, {} as Record<string, DateBucket>);
}

function createMonthDayBucketMap() {
  return createDateBucketMap(1, 31);
}

function readBucketEntry(source: any, index: number, keyCandidates: string[]) {
  if (!source) return null;

  if (Array.isArray(source)) {
    const match = source.find((entry: any) =>
      keyCandidates.some((key) => entry?.[key] != null && readNumber(entry[key]) === index)
    );

    if (match) return match;

    const direct = source[index];
    if (
      direct &&
      typeof direct === "object" &&
      keyCandidates.every((key) => direct[key] == null) &&
      ("count" in direct || "durationMs" in direct || "durationMS" in direct)
    ) {
      return direct;
    }

    return null;
  }

  if (typeof source === "object") {
    return source[String(index)] ?? source[index] ?? null;
  }

  return null;
}

function normalizeBucketCollection(
  source: any,
  start: number,
  end: number,
  keyCandidates: string[]
): Record<string, DateBucket> {
  const normalized = createDateBucketMap(start, end);

  for (let index = start; index <= end; index += 1) {
    const entry = readBucketEntry(source, index, keyCandidates);
    normalized[String(index)] = {
      count: readNumber(entry?.count),
      durationMs: readNumber(entry?.durationMs ?? entry?.durationMS),
    };
  }

  return normalized;
}

function mergeStatsAggregate(parts: StatsfmResult[]) {
  return {
    items: {
      count: parts.reduce((sum, part) => sum + getCount(part.data), 0),
      durationMs: parts.reduce((sum, part) => sum + getDurationMs(part.data), 0),
    },
  };
}

function mergeDatesAggregate(parts: StatsfmResult[]) {
  const hours = createDateBucketMap(0, 23);
  const months = createDateBucketMap(1, 12);
  const weekDays = createDateBucketMap(1, 7);
  const monthDays = createMonthDayBucketMap();

  for (const part of parts) {
    const data: any = part.data;
    const normalizedHours = normalizeBucketCollection(data?.items?.hours, 0, 23, ["hour", "index", "id"]);
    const normalizedMonths = normalizeBucketCollection(data?.items?.months, 1, 12, ["month", "index", "id"]);
    const normalizedMonthDays = normalizeBucketCollection(
      data?.items?.monthDays ?? data?.items?.days,
      1,
      31,
      ["monthDay", "dayOfMonth", "day", "index", "id"]
    );
    const normalizedWeekDays = normalizeBucketCollection(
      data?.items?.weekDays,
      1,
      7,
      ["weekDay", "weekday", "day", "dayOfWeek", "index", "id"]
    );

    for (const [bucket, value] of Object.entries(normalizedHours)) {
      hours[bucket].count += value.count;
      hours[bucket].durationMs += value.durationMs;
    }

    for (const [bucket, value] of Object.entries(normalizedMonths)) {
      months[bucket].count += value.count;
      months[bucket].durationMs += value.durationMs;
    }

    for (const [bucket, value] of Object.entries(normalizedWeekDays)) {
      weekDays[bucket].count += value.count;
      weekDays[bucket].durationMs += value.durationMs;
    }

    for (const [bucket, value] of Object.entries(normalizedMonthDays)) {
      monthDays[bucket].count += value.count;
      monthDays[bucket].durationMs += value.durationMs;
    }
  }

  return {
    items: {
      hours,
      months,
      weekDays,
      monthDays,
    },
  };
}

async function executeTemporalAggregate(
  descriptor: TemporalAggregateDescriptor,
  options?: StatsfmFetchOptions
): Promise<InternalFetchOutcome> {
  const segments = getMonthRangeSegments(
    descriptor.after,
    descriptor.before,
    TIMEZONE_SP,
    new Date(now())
  );

  if (segments.length === 0) {
    return executeFetch(descriptor.originalPath, options);
  }

  const parts = await Promise.all(
    segments.map((segment) =>
      executeFetch(
        buildSegmentPath(descriptor, segment.after, segment.before),
        options,
        getMonthlyCacheConfig(descriptor.kind, segment.recency)
      )
    )
  );

  const failed = parts.find((part) => !part.result.ok);
  if (failed) {
    return {
      result: {
        ...failed.result,
        endpoint: getEndpoint(descriptor.originalPath),
      },
      source: failed.source,
    };
  }

  const data = descriptor.kind === "stats"
    ? mergeStatsAggregate(parts.map((part) => part.result))
    : mergeDatesAggregate(parts.map((part) => part.result));

  return {
    result: {
      ok: true,
      status: 200,
      endpoint: getEndpoint(descriptor.originalPath),
      data,
    },
    source: parts.some((part) => part.source === "upstream") ? "upstream" : "cache",
  };
}

export async function statsfmFetch(path: string, options?: StatsfmFetchOptions) {
  const aggregateMode = options?.aggregateMode ?? "auto";
  const aggregate = aggregateMode === "auto" ? parseTemporalAggregatePath(path) : null;

  if (aggregate) {
    const outcome = await executeTemporalAggregate(aggregate, options);
    return outcome.result;
  }

  const outcome = await executeFetch(path, options);
  return outcome.result;
}

export function getStatsfmHealthSnapshot() {
  const timestamp = now();
  const staleEntries = [...cache.values()].filter(
    (entry) => entry.expiresAt <= timestamp && entry.staleUntil > timestamp
  ).length;
  const expiredEntries = [...cache.values()].filter((entry) => entry.staleUntil <= timestamp).length;
  const cooldownEntries = [...forceCooldowns.entries()]
    .filter(([, until]) => until > timestamp)
    .map(([path, until]) => ({
      path,
      nextAllowedForceAt: new Date(until).toISOString(),
      remainingMs: Math.max(0, until - timestamp),
    }));
  const monthlySegmentEntries = [...cache.entries()].filter(([, entry]) => entry.scope === "monthly_segment");
  const liveEntries = [...cache.entries()].filter(([, entry]) => entry.cacheProfile === "live");
  const replayEntries = [...cache.entries()].filter(([, entry]) => entry.cacheProfile === "replay");
  const heavyEntries = [...cache.entries()].filter(([, entry]) => entry.cacheProfile === "heavy");
  const defaultEntries = [...cache.entries()].filter(([, entry]) => entry.cacheProfile === "default");
  const monthlyFreshEntries = monthlySegmentEntries.filter(([, entry]) => entry.expiresAt > timestamp).length;
  const monthlyStaleEntries = monthlySegmentEntries.filter(
    ([, entry]) => entry.expiresAt <= timestamp && entry.staleUntil > timestamp
  ).length;

  return {
    uptimeMs: timestamp - startedAt,
    cacheSize: cache.size,
    inflightCount: inflight.size,
    staleEntries,
    expiredEntries,
    cooldownEntries,
    cacheProfiles: {
      default: {
        total: defaultEntries.length,
        fresh: defaultEntries.filter(([, entry]) => entry.expiresAt > timestamp).length,
        stale: defaultEntries.filter(([, entry]) => entry.expiresAt <= timestamp && entry.staleUntil > timestamp).length,
      },
      live: {
        total: liveEntries.length,
        fresh: liveEntries.filter(([, entry]) => entry.expiresAt > timestamp).length,
        stale: liveEntries.filter(([, entry]) => entry.expiresAt <= timestamp && entry.staleUntil > timestamp).length,
      },
      replay: {
        total: replayEntries.length,
        fresh: replayEntries.filter(([, entry]) => entry.expiresAt > timestamp).length,
        stale: replayEntries.filter(([, entry]) => entry.expiresAt <= timestamp && entry.staleUntil > timestamp).length,
      },
      heavy: {
        total: heavyEntries.length,
        fresh: heavyEntries.filter(([, entry]) => entry.expiresAt > timestamp).length,
        stale: heavyEntries.filter(([, entry]) => entry.expiresAt <= timestamp && entry.staleUntil > timestamp).length,
      },
    },
    monthlySegments: {
      total: monthlySegmentEntries.length,
      fresh: monthlyFreshEntries,
      stale: monthlyStaleEntries,
      stats: monthlySegmentEntries.filter(([, entry]) => entry.segmentKind === "stats").length,
      dates: monthlySegmentEntries.filter(([, entry]) => entry.segmentKind === "dates").length,
    },
    metrics: {
      ...metrics,
    },
    config: {
      defaultFreshTtlMs: DEFAULT_FRESH_TTL_MS,
      staleTtlMs: STALE_TTL_MS,
      forceCooldownMs: FORCE_COOLDOWN_MS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retryDelayMs: RETRY_DELAY_MS,
      maxRetries: MAX_RETRIES,
      liveFreshTtlMs: LIVE_FRESH_TTL_MS,
      liveStaleTtlMs: LIVE_STALE_TTL_MS,
      replayFreshTtlMs: REPLAY_FRESH_TTL_MS,
      replayStaleTtlMs: REPLAY_STALE_TTL_MS,
      heavyFreshTtlMs: HEAVY_FRESH_TTL_MS,
      heavyStaleTtlMs: HEAVY_STALE_TTL_MS,
      monthlyFreshTtls: {
        currentMonthMs: CURRENT_MONTH_FRESH_TTL_MS,
        previousMonthMs: PREVIOUS_MONTH_FRESH_TTL_MS,
        historicalMonthMs: HISTORICAL_MONTH_FRESH_TTL_MS,
      },
    },
  };
}

export function __resetStatsfmStateForTests() {
  cache.clear();
  inflight.clear();
  forceCooldowns.clear();
  metrics.upstreamRequests = 0;
  metrics.retries = 0;
  metrics.timeouts = 0;
  metrics.staleServed = 0;
  metrics.cacheHits = 0;
  metrics.dedupedRequests = 0;
  metrics.cooldownHits = 0;
  metrics.aggregateSegmentReuses = 0;
  nowOverride = null;
}

export function __setStatsfmNowForTests(timestamp: number | null) {
  nowOverride = timestamp;
}

export function getCount(data: any) {
  return data?.items?.count ?? data?.item?.count ?? data?.count ?? 0;
}

export function getDurationMs(data: any) {
  return data?.items?.durationMs ?? data?.item?.durationMs ?? data?.durationMs ?? 0;
}

export function getCardinality(data: any) {
  return {
    artists: readNumber(data?.items?.cardinality?.artists ?? data?.item?.cardinality?.artists),
    tracks: readNumber(data?.items?.cardinality?.tracks ?? data?.item?.cardinality?.tracks),
    albums: readNumber(data?.items?.cardinality?.albums ?? data?.item?.cardinality?.albums),
  };
}

export function getDatesBreakdown(data: any) {
  return {
    hours: normalizeBucketCollection(data?.items?.hours, 0, 23, ["hour", "index", "id"]),
    months: normalizeBucketCollection(data?.items?.months, 1, 12, ["month", "index", "id"]),
    monthDays: normalizeBucketCollection(
      data?.items?.monthDays ?? data?.items?.days,
      1,
      31,
      ["monthDay", "dayOfMonth", "day", "index", "id"]
    ),
    weekDays: normalizeBucketCollection(
      data?.items?.weekDays,
      1,
      7,
      ["weekDay", "weekday", "day", "dayOfWeek", "index", "id"]
    ),
  };
}
