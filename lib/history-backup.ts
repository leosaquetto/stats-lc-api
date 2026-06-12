import { createHash } from "node:crypto";
import { buildQuery, encodeSegment, getItems } from "./api-helpers.js";
import { getCount, statsfmFetch, type StatsfmResult } from "./statsfm.js";
import { TIMEZONE_SP } from "./time.js";
import {
  historyStore,
  type HistoryMonthStatus,
  type HistoryUserState,
  type StreamHistoryEvent,
  type StreamMonthBackup,
} from "./history-store.js";
import { getUsersList } from "./users.js";

export type HistoryUser = {
  key: string;
  id: string;
  platform?: string;
};

export type HistoryMonth = {
  year: number;
  month: number;
  afterMs: number;
  beforeMs: number;
};

export type HistoryEstimateRow = HistoryMonth & {
  userKey: string;
  userId: string;
  expectedCount: number;
  pages: number;
  ok: boolean;
  status: number;
};

export type HistoryBackupResult = HistoryMonth & {
  userKey: string;
  userId: string;
  expectedCount: number;
  fetchedCount: number;
  storedCount: number;
  skippedCount: number;
  status: HistoryMonthStatus;
  errors: string[];
};

export type HistoryFetchers = {
  fetchStats(userId: string, month: HistoryMonth): Promise<StatsfmResult>;
  fetchStreams(userId: string, month: HistoryMonth, limit: number, beforeMs: number): Promise<StatsfmResult>;
  fetchProfile?(userId: string): Promise<StatsfmResult>;
  fetchLatestStream?(userId: string): Promise<StatsfmResult>;
};

type HistoryStore = {
  upsertMonthStart(input: {
    userKey: string;
    userId: string;
    year: number;
    month: number;
    afterMs: number;
    beforeMs: number;
    expectedCount: number;
    error?: string | null;
  }): Promise<unknown>;
  upsertEvents(events: StreamHistoryEvent[]): Promise<number>;
  countEventsForMonth(userKey: string, afterMs: number, beforeMs: number): Promise<number>;
  finishMonth(input: {
    userKey: string;
    year: number;
    month: number;
    expectedCount: number;
    storedCount: number;
    status: HistoryMonthStatus;
    error?: string | null;
  }): Promise<unknown>;
  listMonths?(userKey?: string): Promise<StreamMonthBackup[]>;
  getLatestEventMs?(userKey: string): Promise<number | null>;
  getUserState?(userKey: string): Promise<HistoryUserState | null>;
  upsertUserState?(input: Omit<HistoryUserState, "createdAt" | "updatedAt">): Promise<HistoryUserState>;
};

export type HistoryBackupOptions = {
  pageSize?: number;
  fetchers?: HistoryFetchers;
  store?: HistoryStore;
  referenceMs?: number;
  statsResult?: StatsfmResult;
  coveragePolicy?: {
    latestUpstreamEventMs: number | null;
    hasImported: boolean | null;
  };
};

export type WeeklyHistoryMaintenanceResult = {
  userKey: string;
  userId: string;
  pendingFromMs: number;
  nextPendingFromMs: number;
  latestEventAtMs: number | null;
  latestAdvanced: boolean;
  fullBackfill: boolean;
  hasImported: boolean | null;
  syncEnabled: boolean | null;
  checkedMonths: number;
  reconciledMonths: string[];
  changedMonths: string[];
  results: HistoryBackupResult[];
};

export type WeeklyHistoryMaintenanceOptions = HistoryBackupOptions & {
  referenceMs?: number;
};

const DEFAULT_PAGE_SIZE = 10000;
const DEFAULT_HISTORY_START_MONTH = "2016-01";
const HISTORY_OVERLAP_MONTHS = 2;
const MONTH_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE_SP,
  year: "numeric",
  month: "2-digit",
});

function getMonthParts(timestamp: number) {
  const [year, month] = MONTH_FORMATTER.format(new Date(timestamp)).split("-").map(Number);
  return { year, month };
}

function zonedMonthStartMs(year: number, month: number) {
  const utcGuess = Date.UTC(year, month - 1, 1, 0, 0, 0, 0);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIMEZONE_SP,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcGuess));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second)
  );
  return utcGuess - (asUtc - utcGuess);
}

function nextMonth(year: number, month: number) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 };
}

function previousMonth(year: number, month: number) {
  return month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 };
}

function monthKey(month: Pick<HistoryMonth, "year" | "month">) {
  return `${month.year}-${String(month.month).padStart(2, "0")}`;
}

export function parseHistoryMonth(value: string) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid month "${value}". Use YYYY-MM.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid month "${value}". Use YYYY-MM.`);
  return createHistoryMonth(year, month);
}

export function createHistoryMonth(year: number, month: number): HistoryMonth {
  const afterMs = zonedMonthStartMs(year, month);
  const next = nextMonth(year, month);
  const beforeMs = zonedMonthStartMs(next.year, next.month);
  return { year, month, afterMs, beforeMs };
}

export function currentHistoryMonth(referenceMs = Date.now()) {
  const current = getMonthParts(referenceMs);
  return createHistoryMonth(current.year, current.month);
}

export function previousClosedHistoryMonth(referenceMs = Date.now()) {
  const current = getMonthParts(referenceMs);
  const previous = previousMonth(current.year, current.month);
  return createHistoryMonth(previous.year, previous.month);
}

export function shiftHistoryMonth(month: HistoryMonth, offset: number) {
  const shifted = new Date(Date.UTC(month.year, month.month - 1 + offset, 1));
  return createHistoryMonth(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1);
}

export function historyMonthFromTimestamp(timestamp: number) {
  const parts = getMonthParts(timestamp);
  return createHistoryMonth(parts.year, parts.month);
}

export function listHistoryMonths(from: HistoryMonth, to: HistoryMonth) {
  const months: HistoryMonth[] = [];
  let cursor = { year: from.year, month: from.month };
  const end = monthKey(to);
  while (`${cursor.year}-${String(cursor.month).padStart(2, "0")}` <= end) {
    months.push(createHistoryMonth(cursor.year, cursor.month));
    cursor = nextMonth(cursor.year, cursor.month);
  }
  return months;
}

export function resolveHistoryUser(userKey: string): HistoryUser {
  const user = getUsersList().find((entry) => entry.key === userKey || entry.id === userKey);
  if (!user) throw new Error(`Unknown history user "${userKey}"`);
  return user;
}

export function resolveHistoryUsers(input: string): HistoryUser[] {
  const value = input.trim();
  if (!value || value === "all") return getUsersList();
  return value.split(",").map((entry) => resolveHistoryUser(entry.trim())).filter(Boolean);
}

function defaultFetchers(): HistoryFetchers {
  return {
    fetchStats(userId, month) {
      return statsfmFetch(
        `/users/${encodeSegment(userId)}/streams/stats${buildQuery({
          after: month.afterMs,
          before: month.beforeMs - 1,
        })}`,
        { force: false, cacheProfile: "heavy", requestTimeoutMs: 8000, maxRetries: 1 }
      );
    },
    fetchStreams(userId, month, limit, beforeMs) {
      return statsfmFetch(
        `/users/${encodeSegment(userId)}/streams${buildQuery({
          after: month.afterMs,
          before: beforeMs,
          limit,
        })}`,
        { force: false, cacheProfile: "heavy", requestTimeoutMs: 8000, maxRetries: 1 }
      );
    },
    fetchProfile(userId) {
      return statsfmFetch(`/users/${encodeSegment(userId)}`, {
        force: false,
        requestTimeoutMs: 8000,
        maxRetries: 1,
      });
    },
    fetchLatestStream(userId) {
      return statsfmFetch(`/users/${encodeSegment(userId)}/streams?limit=1`, {
        force: false,
        cacheProfile: "heavy",
        requestTimeoutMs: 8000,
        maxRetries: 1,
      });
    },
  };
}

function readTimestamp(stream: any) {
  const raw = stream?.playedAt ?? stream?.endTime ?? stream?.timestamp ?? stream?.date;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw < 2147483647 ? raw * 1000 : raw;
  if (typeof raw === "string" && raw.trim()) {
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readProfileSyncState(data: unknown) {
  const profile: any = (data as any)?.item ?? data ?? {};
  const auth = profile?.appleMusicAuth ?? profile?.spotifyAuth ?? {};
  return {
    hasImported:
      typeof profile?.hasImported === "boolean"
        ? profile.hasImported
        : typeof auth?.imported === "boolean"
          ? auth.imported
          : null,
    syncEnabled:
      typeof profile?.syncEnabled === "boolean"
        ? profile.syncEnabled
        : typeof auth?.sync === "boolean"
          ? auth.sync
          : null,
  };
}

function readId(value: unknown) {
  return value == null || value === "" ? null : String(value);
}

function readArtistId(track: any) {
  const firstArtist = Array.isArray(track?.artists) ? track.artists[0] : null;
  return readId(track?.primaryArtistId ?? track?.artistId ?? track?.primaryArtist?.id ?? track?.artist?.id ?? firstArtist?.id);
}

function readAlbumId(stream: any, track: any) {
  const firstAlbum = Array.isArray(track?.albums) ? track.albums[0] : null;
  return readId(stream?.albumId ?? track?.albumId ?? track?.album?.id ?? firstAlbum?.id);
}

function createSourceHash(input: {
  userId: string;
  playedAtMs: number;
  trackId?: string | null;
  albumId?: string | null;
  playedMs: number;
}) {
  return createHash("sha256")
    .update([
      input.userId,
      String(input.playedAtMs),
      input.trackId || "",
      input.albumId || "",
      String(input.playedMs),
    ].join("|"))
    .digest("hex");
}

export function normalizeHistoryEvent(stream: any, user: HistoryUser): StreamHistoryEvent | null {
  const playedAtMs = readTimestamp(stream);
  if (playedAtMs == null) return null;
  const track = stream?.track ?? {};
  const trackId = readId(stream?.trackId ?? track?.id);
  const albumId = readAlbumId(stream, track);
  const playedMs = Math.max(0, Number(stream?.playedMs ?? stream?.durationMs ?? track?.durationMs ?? 0) || 0);

  return {
    sourceHash: createSourceHash({
      userId: user.id,
      playedAtMs,
      trackId,
      albumId,
      playedMs,
    }),
    userKey: user.key,
    userId: user.id,
    platform: user.platform ?? null,
    playedAt: new Date(playedAtMs).toISOString(),
    playedAtMs,
    trackId,
    albumId,
    artistId: readArtistId(track),
    playedMs,
    raw: stream,
  };
}

export async function estimateHistoryMonths(
  user: HistoryUser,
  months: HistoryMonth[],
  options: Pick<HistoryBackupOptions, "fetchers" | "pageSize"> = {}
) {
  const fetchers = options.fetchers ?? defaultFetchers();
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const rows: HistoryEstimateRow[] = [];

  for (const month of months) {
    const stats = await fetchers.fetchStats(user.id, month);
    const expectedCount = stats.ok ? getCount(stats.data) : 0;
    rows.push({
      ...month,
      userKey: user.key,
      userId: user.id,
      expectedCount,
      pages: Math.ceil(expectedCount / pageSize),
      ok: stats.ok,
      status: stats.status,
    });
  }

  return rows;
}

function resolveBackupStatus(input: {
  month: HistoryMonth;
  referenceMs: number;
  expectedCount: number;
  storedCount: number;
  errors: string[];
  coveragePolicy?: HistoryBackupOptions["coveragePolicy"];
}): HistoryMonthStatus {
  if (input.errors.length > 0 || input.storedCount < input.expectedCount) return "partial";
  if (input.storedCount > input.expectedCount) return "needs_review";
  if (!input.coveragePolicy) return "complete";
  if (input.referenceMs >= input.month.afterMs && input.referenceMs < input.month.beforeMs) return "open";
  if (input.coveragePolicy.hasImported === false && input.expectedCount === 0) return "awaiting_sync";
  if (
    input.coveragePolicy.latestUpstreamEventMs == null
    || input.coveragePolicy.latestUpstreamEventMs < input.month.beforeMs
  ) {
    return "awaiting_sync";
  }
  return "complete";
}

export async function backupHistoryMonth(
  user: HistoryUser,
  month: HistoryMonth,
  options: HistoryBackupOptions = {}
): Promise<HistoryBackupResult> {
  const fetchers = options.fetchers ?? defaultFetchers();
  const store = options.store ?? historyStore;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const referenceMs = options.referenceMs ?? Date.now();
  const errors: string[] = [];
  const fetchBeforeMs = Math.min(month.beforeMs, referenceMs + 1);
  const fetchMonth = fetchBeforeMs === month.beforeMs
    ? month
    : { ...month, beforeMs: fetchBeforeMs };

  const stats = options.statsResult ?? await fetchers.fetchStats(user.id, fetchMonth);
  if (!stats.ok) {
    throw new Error(`Stats request failed for ${user.key} ${monthKey(month)} (${stats.status})`);
  }

  const expectedCount = getCount(stats.data);
  await store.upsertMonthStart({
    userKey: user.key,
    userId: user.id,
    year: month.year,
    month: month.month,
    afterMs: month.afterMs,
    beforeMs: month.beforeMs,
    expectedCount,
  });

  let fetchedCount = 0;
  let skippedCount = 0;
  let cursorBeforeMs = fetchBeforeMs - 1;
  const maxPages = Math.max(1, Math.ceil(expectedCount / pageSize) + 2);

  for (let page = 0; page < maxPages && cursorBeforeMs >= month.afterMs; page += 1) {
    const result = await fetchers.fetchStreams(user.id, fetchMonth, pageSize, cursorBeforeMs);
    if (!result.ok) {
      errors.push(`streams page before=${cursorBeforeMs} status=${result.status}`);
      break;
    }

    const streams = getItems(result.data);
    if (streams.length === 0) break;
    fetchedCount += streams.length;
    const events = streams
      .map((stream: any) => normalizeHistoryEvent(stream, user))
      .filter((event: StreamHistoryEvent | null): event is StreamHistoryEvent => {
        if (event && event.playedAtMs >= month.afterMs && event.playedAtMs < month.beforeMs) return true;
        skippedCount += 1;
        return false;
      });
    await store.upsertEvents(events);

    const oldestTimestamp = events.reduce(
      (minimum: number, event: StreamHistoryEvent) => Math.min(minimum, event.playedAtMs),
      Number.POSITIVE_INFINITY
    );
    if (!Number.isFinite(oldestTimestamp)) break;
    cursorBeforeMs = oldestTimestamp - 1;
    if (events.length < pageSize || fetchedCount >= expectedCount + skippedCount) break;
  }

  const storedCount = await store.countEventsForMonth(user.key, month.afterMs, month.beforeMs);
  const status = resolveBackupStatus({
    month,
    referenceMs,
    expectedCount,
    storedCount,
    errors,
    coveragePolicy: options.coveragePolicy,
  });

  await store.finishMonth({
    userKey: user.key,
    year: month.year,
    month: month.month,
    expectedCount,
    storedCount,
    status,
    error: errors.join("; ") || null,
  });

  return {
    ...month,
    userKey: user.key,
    userId: user.id,
    expectedCount,
    fetchedCount,
    storedCount,
    skippedCount,
    status,
    errors,
  };
}

export async function backupHistoryRange(
  user: HistoryUser,
  months: HistoryMonth[],
  options: HistoryBackupOptions = {}
) {
  const results: HistoryBackupResult[] = [];
  for (const month of months) {
    results.push(await backupHistoryMonth(user, month, options));
  }
  return results;
}

function requireMaintenanceStore(store: HistoryStore) {
  if (
    !store.listMonths
    || !store.getLatestEventMs
    || !store.getUserState
    || !store.upsertUserState
  ) {
    throw new Error("History store does not support weekly maintenance state");
  }
  return store as HistoryStore & Required<Pick<
    HistoryStore,
    "listMonths" | "getLatestEventMs" | "getUserState" | "upsertUserState"
  >>;
}

function clampPendingMonth(month: HistoryMonth, current: HistoryMonth) {
  return month.afterMs > current.afterMs ? current : month;
}

export async function maintainWeeklyHistoryUser(
  user: HistoryUser,
  options: WeeklyHistoryMaintenanceOptions = {}
): Promise<WeeklyHistoryMaintenanceResult> {
  const defaults = defaultFetchers();
  const fetchers: HistoryFetchers = {
    ...defaults,
    ...(options.fetchers ?? {}),
  };
  const store = requireMaintenanceStore(options.store ?? historyStore);
  const referenceMs = options.referenceMs ?? Date.now();
  const currentMonth = currentHistoryMonth(referenceMs);
  const checkedAt = new Date(referenceMs).toISOString();

  const [existingMonths, storedLatestEventMs, previousState, profileResult, latestResult] = await Promise.all([
    store.listMonths(user.key),
    store.getLatestEventMs(user.key),
    store.getUserState(user.key),
    fetchers.fetchProfile!(user.id),
    fetchers.fetchLatestStream!(user.id),
  ]);

  const profileState = profileResult.ok
    ? readProfileSyncState(profileResult.data)
    : {
        hasImported: previousState?.hasImported ?? null,
        syncEnabled: previousState?.syncEnabled ?? null,
      };
  const latestStream = latestResult.ok ? getItems(latestResult.data)[0] ?? null : null;
  const upstreamLatestEventMs = readTimestamp(latestStream);
  const previousLatestEventMs = previousState?.lastEventAtMs ?? storedLatestEventMs ?? null;
  const latestEventAtMs = Math.max(
    previousLatestEventMs ?? 0,
    upstreamLatestEventMs ?? 0
  ) || null;
  const latestAdvanced =
    upstreamLatestEventMs != null
    && upstreamLatestEventMs > (previousLatestEventMs ?? 0) + 1500;
  const importedTransition =
    previousState?.hasImported === false
    && profileState.hasImported === true;
  const fullBackfill =
    importedTransition
    || (
      previousState == null
      && storedLatestEventMs == null
      && profileState.hasImported === true
    );

  const basePendingMonth = fullBackfill
    ? parseHistoryMonth(DEFAULT_HISTORY_START_MONTH)
    : previousState?.pendingFromMs
      ? historyMonthFromTimestamp(previousState.pendingFromMs)
      : storedLatestEventMs != null || latestEventAtMs != null
        ? historyMonthFromTimestamp(storedLatestEventMs ?? latestEventAtMs!)
        : shiftHistoryMonth(currentMonth, -HISTORY_OVERLAP_MONTHS);
  const pendingMonth = clampPendingMonth(basePendingMonth, currentMonth);
  const months = listHistoryMonths(pendingMonth, currentMonth);
  const existingByMonth = new Map(existingMonths.map((month) => [monthKey(month), month]));
  const reconciledMonths: string[] = [];
  const changedMonths: string[] = [];
  const results: HistoryBackupResult[] = [];

  for (const month of months) {
    const key = monthKey(month);
    const existing = existingByMonth.get(key);
    const statsMonth = referenceMs < month.beforeMs
      ? { ...month, beforeMs: referenceMs + 1 }
      : month;
    const statsResult = await fetchers.fetchStats(user.id, statsMonth);

    if (!statsResult.ok) {
      const expectedCount = existing?.expectedCount ?? 0;
      const storedCount = await store.countEventsForMonth(user.key, month.afterMs, month.beforeMs);
      const errors = [`stats status=${statsResult.status}`];
      await store.upsertMonthStart({
        userKey: user.key,
        userId: user.id,
        year: month.year,
        month: month.month,
        afterMs: month.afterMs,
        beforeMs: month.beforeMs,
        expectedCount,
        error: errors[0],
      });
      await store.finishMonth({
        userKey: user.key,
        year: month.year,
        month: month.month,
        expectedCount,
        storedCount,
        status: "failed",
        error: errors[0],
      });
      results.push({
        ...month,
        userKey: user.key,
        userId: user.id,
        expectedCount,
        fetchedCount: 0,
        storedCount,
        skippedCount: 0,
        status: "failed",
        errors,
      });
      continue;
    }

    const expectedCount = getCount(statsResult.data);
    const countChanged = existing != null && existing.expectedCount !== expectedCount;
    if (countChanged) changedMonths.push(key);

    const isCurrentMonth = month.afterMs === currentMonth.afterMs;
    const isFalseCompleteEmptyMonth =
      existing?.status === "complete"
      && expectedCount === 0
      && (
        latestEventAtMs == null
        || latestEventAtMs < month.beforeMs
      );
    const shouldReconcile =
      isCurrentMonth
      || fullBackfill
      || latestAdvanced
      || countChanged
      || existing == null
      || isFalseCompleteEmptyMonth
      || ["open", "partial", "failed", "needs_review", "running", "pending"].includes(existing.status);

    if (!shouldReconcile) continue;

    const result = await backupHistoryMonth(user, month, {
      ...options,
      fetchers,
      store,
      referenceMs,
      statsResult,
      coveragePolicy: {
        latestUpstreamEventMs: upstreamLatestEventMs ?? previousLatestEventMs,
        hasImported: profileState.hasImported,
      },
    });
    reconciledMonths.push(key);
    results.push(result);
  }

  const reconciliationSucceeded = results.every((result) =>
    !["partial", "failed", "needs_review"].includes(result.status)
  );
  const canAdvanceWindow =
    reconciliationSucceeded
    && latestEventAtMs != null
    && (latestAdvanced || fullBackfill);
  const nextPendingMonth = canAdvanceWindow
    ? shiftHistoryMonth(historyMonthFromTimestamp(latestEventAtMs), -HISTORY_OVERLAP_MONTHS)
    : pendingMonth;
  const nextPendingFromMs = clampPendingMonth(nextPendingMonth, currentMonth).afterMs;
  const previousCountChangedAt = previousState?.lastCountChangedAt ?? null;

  await store.upsertUserState({
    userKey: user.key,
    userId: user.id,
    pendingFromMs: nextPendingFromMs,
    lastEventAtMs: latestEventAtMs,
    lastCheckedAt: checkedAt,
    lastCountChangedAt: changedMonths.length > 0 ? checkedAt : previousCountChangedAt,
    hasImported: profileState.hasImported,
    syncEnabled: profileState.syncEnabled,
  });

  return {
    userKey: user.key,
    userId: user.id,
    pendingFromMs: pendingMonth.afterMs,
    nextPendingFromMs,
    latestEventAtMs,
    latestAdvanced,
    fullBackfill,
    hasImported: profileState.hasImported,
    syncEnabled: profileState.syncEnabled,
    checkedMonths: months.length,
    reconciledMonths,
    changedMonths,
    results,
  };
}
