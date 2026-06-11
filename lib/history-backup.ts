import { createHash } from "node:crypto";
import { buildQuery, encodeSegment, getItems } from "./api-helpers.js";
import { getCount, statsfmFetch, type StatsfmResult } from "./statsfm.js";
import { TIMEZONE_SP } from "./time.js";
import { historyStore, type HistoryMonthStatus, type StreamHistoryEvent } from "./history-store.js";
import { getUsersList } from "./users.js";

type HistoryUser = {
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

type HistoryFetchers = {
  fetchStats(userId: string, month: HistoryMonth): Promise<StatsfmResult>;
  fetchStreams(userId: string, month: HistoryMonth, limit: number, offset: number): Promise<StatsfmResult>;
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
};

export type HistoryBackupOptions = {
  pageSize?: number;
  fetchers?: HistoryFetchers;
  store?: HistoryStore;
};

const DEFAULT_PAGE_SIZE = 1000;
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

export function previousClosedHistoryMonth(referenceMs = Date.now()) {
  const current = getMonthParts(referenceMs);
  const previous = previousMonth(current.year, current.month);
  return createHistoryMonth(previous.year, previous.month);
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

function defaultFetchers(): HistoryFetchers {
  return {
    fetchStats(userId, month) {
      return statsfmFetch(
        `/users/${encodeSegment(userId)}/streams/stats${buildQuery({
          after: month.afterMs,
          before: month.beforeMs,
        })}`,
        { force: false, cacheProfile: "heavy", requestTimeoutMs: 8000, maxRetries: 1 }
      );
    },
    fetchStreams(userId, month, limit, offset) {
      return statsfmFetch(
        `/users/${encodeSegment(userId)}/streams${buildQuery({
          after: month.afterMs,
          before: month.beforeMs,
          limit,
          offset,
        })}`,
        { force: false, cacheProfile: "heavy", requestTimeoutMs: 8000, maxRetries: 1 }
      );
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

export async function backupHistoryMonth(
  user: HistoryUser,
  month: HistoryMonth,
  options: HistoryBackupOptions = {}
): Promise<HistoryBackupResult> {
  const fetchers = options.fetchers ?? defaultFetchers();
  const store = options.store ?? historyStore;
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const errors: string[] = [];

  const stats = await fetchers.fetchStats(user.id, month);
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
  const pages = Math.ceil(expectedCount / pageSize);

  for (let page = 0; page < pages; page += 1) {
    const offset = page * pageSize;
    const limit = Math.min(pageSize, expectedCount - offset);
    const result = await fetchers.fetchStreams(user.id, month, limit, offset);
    if (!result.ok) {
      errors.push(`streams page offset=${offset} status=${result.status}`);
      break;
    }

    const streams = getItems(result.data);
    fetchedCount += streams.length;
    const events = streams
      .map((stream: any) => normalizeHistoryEvent(stream, user))
      .filter((event: StreamHistoryEvent | null): event is StreamHistoryEvent => {
        if (event) return true;
        skippedCount += 1;
        return false;
      });
    await store.upsertEvents(events);

    if (streams.length < limit) break;
  }

  const storedCount = await store.countEventsForMonth(user.key, month.afterMs, month.beforeMs);
  const status: HistoryMonthStatus = errors.length > 0 || storedCount < expectedCount
    ? expectedCount === 0 || storedCount === expectedCount
      ? "complete"
      : "partial"
    : "complete";

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
