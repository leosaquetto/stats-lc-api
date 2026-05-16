const API_BASE = "https://api.stats.fm/api/v1";
const FRESH_TTL_MS = 60_000;
const STALE_TTL_MS = 10 * 60_000;
const FORCE_COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;
const RETRY_DELAY_MS = 300;
const MAX_RETRIES = 1;

export type StatsfmResult = {
  ok: boolean;
  status: number;
  endpoint: string;
  data: unknown;
};

type StatsfmFetchOptions = {
  force?: boolean;
};

type CacheEntry = {
  result: StatsfmResult;
  cachedAt: number;
  expiresAt: number;
  staleUntil: number;
  lastErrorAt: number | null;
  lastErrorStatus: number | null;
  lastErrorReason: string | null;
  lastServedAt: number;
};

type InternalFetchOutcome = {
  result: StatsfmResult;
  source: "upstream" | "cache";
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
};
const startedAt = Date.now();

function now() {
  return Date.now();
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

function saveSuccess(path: string, result: StatsfmResult) {
  const timestamp = now();
  const key = normalizePath(path);

  cache.set(key, {
    result,
    cachedAt: timestamp,
    expiresAt: timestamp + FRESH_TTL_MS,
    staleUntil: timestamp + STALE_TTL_MS,
    lastErrorAt: null,
    lastErrorStatus: null,
    lastErrorReason: null,
    lastServedAt: timestamp,
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

async function fetchUpstream(path: string, force: boolean, attempt: number): Promise<StatsfmResult> {
  const endpoint = getEndpoint(path);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

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

    if (!result.ok && shouldRetryStatus(result.status) && attempt < MAX_RETRIES) {
      updateErrorState(path, { status: result.status, reason: `http_${result.status}` });
      metrics.retries += 1;
      await sleep(RETRY_DELAY_MS);
      return fetchUpstream(path, force, attempt + 1);
    }

    return result;
  } catch (error: any) {
    const aborted = error?.name === "AbortError";
    const reason = aborted ? "timeout" : "network_error";

    if (aborted) metrics.timeouts += 1;

    updateErrorState(path, { reason });

    if (attempt < MAX_RETRIES) {
      metrics.retries += 1;
      await sleep(RETRY_DELAY_MS);
      return fetchUpstream(path, force, attempt + 1);
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

async function executeFetch(path: string, options?: StatsfmFetchOptions): Promise<InternalFetchOutcome> {
  const key = normalizePath(path);
  const timestamp = now();
  const force = options?.force === true;
  const cached = getCacheEntry(key);
  const forceCooldownUntil = forceCooldowns.get(key) ?? 0;

  if (!force && isFresh(cached, timestamp)) {
    metrics.cacheHits += 1;
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
    const upstream = await fetchUpstream(key, force, 0);

    if (upstream.ok) {
      saveSuccess(key, upstream);
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

export async function statsfmFetch(path: string, options?: StatsfmFetchOptions) {
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

  return {
    uptimeMs: timestamp - startedAt,
    cacheSize: cache.size,
    inflightCount: inflight.size,
    staleEntries,
    expiredEntries,
    cooldownEntries,
    metrics: {
      ...metrics,
    },
    config: {
      freshTtlMs: FRESH_TTL_MS,
      staleTtlMs: STALE_TTL_MS,
      forceCooldownMs: FORCE_COOLDOWN_MS,
      timeoutMs: REQUEST_TIMEOUT_MS,
      retryDelayMs: RETRY_DELAY_MS,
      maxRetries: MAX_RETRIES,
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
}

export function getCount(data: any) {
  return data?.items?.count ?? data?.item?.count ?? data?.count ?? 0;
}

export function getDurationMs(data: any) {
  return data?.items?.durationMs ?? data?.item?.durationMs ?? data?.durationMs ?? 0;
}
