import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  encodeSegment,
  getItems,
  mapWithConcurrency,
  readOptionalQueryString,
  readQueryString,
  setCacheHeaders,
} from "../api-helpers.js";
import { normalizeRecentItem, normalizeTopItem } from "../normalize.js";
import { getCount, getDurationMs, statsfmFetch } from "../statsfm.js";
import { USERS, resolveUserId } from "../users.js";
import { fetchUserEntityStreams } from "../user-streams-service.js";
import { fetchUserTop } from "../user-tops-service.js";

const PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 10;
const DEADLINE_MS = 6800;
const DAY_MS = 24 * 60 * 60 * 1000;

const routeMap = {
  track: "tracks",
  album: "albums",
  artist: "artists",
} as const;

type EntityKind = keyof typeof routeMap;
type TrackStorySpecialCode = "shiny" | "hiddenGem" | "special" | "late" | "seasonal";
type TrackStorySpecialTone = "shine" | "hiddenGem" | "special" | "late" | "seasonal";

type CountRow = {
  key: string;
  id: string;
  count: number | null;
  durationMs: number | null;
  minutes: number | null;
  error?: unknown;
};

function splitCsv(value: string | null) {
  if (!value) return [];
  return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
}

function clampTimeout(deadline: number, min = 250, max = 1200) {
  return Math.max(min, Math.min(max, deadline - Date.now()));
}

function readTime(item: any) {
  const raw = item?.playedAt ?? item?.endTime ?? item?.timestamp ?? item?.date ?? item?.createdAt;
  const time = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : 0;
}

function parseDateMs(value: string | null) {
  if (!value) return 0;
  const trimmed = value.trim();
  if (!trimmed) return 0;
  const time = /^\d+$/.test(trimmed) ? Number(trimmed) : new Date(trimmed).getTime();
  return Number.isFinite(time) && time > 0 ? time : 0;
}

function saoPauloParts(value: number) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(new Date(value));
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year) || 0,
    month: Number(map.month) || 0,
    day: Number(map.day) || 0,
    hour: Number(map.hour) || 0,
    dayKey: `${map.year}-${map.month}-${map.day}`,
  };
}

function releaseDayKey(value: string | null) {
  if (!value) return "";
  const time = /^\d+$/.test(value.trim()) ? Number(value) : new Date(value).getTime();
  if (!Number.isFinite(time) || time <= 0) return "";
  const date = new Date(time);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function previousUtcDayKey(dayKey: string) {
  if (!dayKey) return "";
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function isReleaseWindow(playedAt: number, releaseKey: string) {
  if (!playedAt || !releaseKey) return false;
  const playedKey = saoPauloParts(playedAt).dayKey;
  return playedKey === releaseKey || playedKey === previousUtcDayKey(releaseKey);
}

async function getEntityStatsForUser(
  key: string,
  userId: string,
  type: EntityKind,
  id: string,
  deadline: number
): Promise<CountRow> {
  if (!id || Date.now() >= deadline) {
    return { key, id: userId, count: null, durationMs: null, minutes: null, error: "deadline" };
  }

  const result = await statsfmFetch(
    `/users/${encodeSegment(userId)}/streams/${routeMap[type]}/${encodeSegment(id)}/stats`,
    {
      force: false,
      requestTimeoutMs: clampTimeout(deadline),
      maxRetries: 0,
    }
  );

  if (!result.ok) {
    return {
      key,
      id: userId,
      count: null,
      durationMs: null,
      minutes: null,
      error: {
        ok: result.ok,
        status: result.status,
        endpoint: result.endpoint,
      },
    };
  }

  const durationMs = getDurationMs(result.data);
  return {
    key,
    id: userId,
    count: getCount(result.data),
    durationMs,
    minutes: Math.floor(durationMs / 60000),
  };
}

async function getEntityStatsForGroup(
  type: EntityKind,
  id: string,
  deadline: number,
  users = Object.entries(USERS) as Array<[string, { id: string }]>
) {
  const settled = await mapWithConcurrency(users, 2, ([key, user]) =>
    getEntityStatsForUser(key, user.id, type, id, deadline)
  );

  return settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const [key, user] = users[index];
    return {
      key,
      id: user.id,
      count: null,
      durationMs: null,
      minutes: null,
      error: String(result.reason),
    };
  });
}

async function fetchOwnTrackHistory(userId: string, trackId: string, totalCount: number, deadline: number) {
  const items: any[] = [];
  let fetchedPages = 0;
  let partial = false;

  for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
    if (Date.now() >= deadline) {
      partial = true;
      break;
    }

    const result = await fetchUserEntityStreams(
      userId,
      "tracks",
      trackId,
      { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
      {
        force: false,
        cacheProfile: "heavy",
        requestTimeoutMs: clampTimeout(deadline, 300, 1400),
        maxRetries: 0,
      }
    );

    if (!result.ok) {
      partial = true;
      break;
    }

    const pageItems = getItems(result.data).map(normalizeRecentItem).filter((item: any) => readTime(item) > 0);
    items.push(...pageItems);
    fetchedPages += 1;

    if (pageItems.length < PAGE_SIZE) break;
    if (totalCount > 0 && items.length >= totalCount) break;
  }

  if (totalCount > 0 && items.length < totalCount) partial = true;
  return { items, fetchedPages, partial };
}

async function getFirstPlayedForUser(key: string, userId: string, trackId: string, deadline: number) {
  if (Date.now() >= deadline) return { key, id: userId, playedAt: null as string | null, error: "deadline" };

  const result = await fetchUserEntityStreams(
    userId,
    "tracks",
    trackId,
    { limit: 1, order: "asc" },
    {
      force: false,
      cacheProfile: "default",
      requestTimeoutMs: clampTimeout(deadline, 250, 900),
      maxRetries: 0,
    }
  );

  if (!result.ok) return { key, id: userId, playedAt: null as string | null, error: result.status };
  const item = getItems(result.data)[0];
  return { key, id: userId, playedAt: item?.endTime ?? item?.playedAt ?? null };
}

async function getFirstListeners(trackId: string, counts: CountRow[], deadline: number) {
  const listenersToCheck = counts.filter((row) => typeof row.count === "number" && row.count > 0);
  const settled = await mapWithConcurrency(listenersToCheck, 3, (row) =>
    getFirstPlayedForUser(row.key, row.id, trackId, deadline)
  );
  const countById = new Map(counts.map((row) => [row.id, row.count]));
  let partial = false;
  const listeners = settled
    .map((result, index) => {
      if (result.status !== "fulfilled") {
        partial = true;
        const row = listenersToCheck[index];
        return { key: row.key, id: row.id, playedAt: 0, count: countById.get(row.id) || 0 };
      }
      if (result.value.error) partial = true;
      return {
        key: result.value.key,
        id: result.value.id,
        playedAt: result.value.playedAt ? new Date(result.value.playedAt).getTime() : 0,
        count: countById.get(result.value.id) || 0,
      };
    })
    .filter((item) => item.playedAt > 0)
    .sort((a, b) => a.playedAt - b.playedAt);

  return { listeners, partial };
}

function getWrappedPeriods(
  years: Map<number, number>,
  months: Map<string, number>,
  releaseKey: string,
) {
  const now = new Date();
  const currentYear = now.getFullYear();
  const releaseYear = releaseKey ? Number(releaseKey.slice(0, 4)) : 0;
  const useMonths = releaseYear === currentYear;

  if (useMonths) {
    const currentMonthStart = new Date(currentYear, now.getMonth(), 1);
    const recentKeys = Array.from({ length: 3 }, (_, index) => {
      const date = new Date(currentMonthStart);
      date.setMonth(currentMonthStart.getMonth() - (2 - index));
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    });
    const recentSet = new Set(recentKeys);
    const bestEntry = [...months.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0];
    const displayKeys = bestEntry && !recentSet.has(bestEntry[0])
      ? [bestEntry[0], recentKeys[1], recentKeys[2]]
      : recentKeys;
    const bestCount = Math.max(...displayKeys.map((key) => months.get(key) || 0), 0);

    return {
      mode: "month" as const,
      periods: displayKeys.map((key) => {
        const [year, month] = key.split("-").map(Number);
        return {
          key,
          year,
          month,
          label: new Intl.DateTimeFormat("pt-BR", {
            timeZone: "UTC",
            month: "short",
            year: "2-digit",
          }).format(new Date(Date.UTC(year || currentYear, (month || 1) - 1, 1))).replace(".", ""),
          count: months.get(key) || 0,
          highlight: bestCount > 0 && (months.get(key) || 0) === bestCount,
        };
      }),
    };
  }

  const recentYears = [currentYear - 2, currentYear - 1, currentYear];
  const recentSet = new Set(recentYears);
  const bestEntry = [...years.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  const displayYears = bestEntry && !recentSet.has(bestEntry[0])
    ? [bestEntry[0], currentYear - 1, currentYear]
    : recentYears;
  const bestCount = Math.max(...displayYears.map((year) => years.get(year) || 0), 0);

  return {
    mode: "year" as const,
    periods: displayYears.map((year) => ({
      key: String(year),
      year,
      label: String(year),
      count: years.get(year) || 0,
      highlight: bestCount > 0 && (years.get(year) || 0) === bestCount,
    })),
  };
}

function summarizeHistory(items: any[], totalCount: number, complete: boolean, releaseKey: string, currentPlayedAt = 0) {
  const times = items
    .map(readTime)
    .filter((time) => time > 0)
    .sort((a, b) => a - b);
  const years = new Map<number, number>();
  const months = new Map<string, number>();
  const days = new Map<string, number>();
  const hours = new Map<number, number>();

  for (const time of times) {
    const parts = saoPauloParts(time);
    years.set(parts.year, (years.get(parts.year) || 0) + 1);
    const monthKey = `${parts.year}-${String(parts.month).padStart(2, "0")}`;
    months.set(monthKey, (months.get(monthKey) || 0) + 1);
    days.set(parts.dayKey, (days.get(parts.dayKey) || 0) + 1);
    hours.set(parts.hour, (hours.get(parts.hour) || 0) + 1);
  }

  const bestYearEntry = [...years.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  const bestYear = bestYearEntry
    ? {
        year: bestYearEntry[0],
        count: bestYearEntry[1],
        previousYearCount: years.get(bestYearEntry[0] - 1) || 0,
        nextYearCount: years.get(bestYearEntry[0] + 1) || 0,
      }
    : null;

  const loopEntry = [...days.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const dayKeys = [...days.keys()].sort();
  let streak = { days: 0, start: null as string | null, end: null as string | null };
  let current = { days: 0, start: null as string | null, end: null as string | null };

  for (const dayKey of dayKeys) {
    if (!current.end) {
      current = { days: 1, start: dayKey, end: dayKey };
    } else {
      const previous = new Date(`${current.end}T00:00:00.000Z`);
      previous.setUTCDate(previous.getUTCDate() + 1);
      const expected = previous.toISOString().slice(0, 10);
      current = expected === dayKey
        ? { ...current, days: current.days + 1, end: dayKey }
        : { days: 1, start: dayKey, end: dayKey };
    }
    if (current.days > streak.days) streak = { ...current };
  }

  const dayparts = [
    { key: "dawn", label: "madrugada", hours: [0, 1, 2, 3, 4, 5] },
    { key: "morning", label: "manhã", hours: [6, 7, 8, 9, 10, 11] },
    { key: "afternoon", label: "tarde", hours: [12, 13, 14, 15, 16, 17] },
    { key: "night", label: "noite", hours: [18, 19, 20, 21, 22, 23] },
  ].map((part) => ({
    key: part.key,
    label: part.label,
    count: part.hours.reduce((sum, hour) => sum + (hours.get(hour) || 0), 0),
  }));
  const bestDaypart = dayparts.sort((a, b) => b.count - a.count)[0] || null;
  const firstPlayedAt = times[0] || 0;
  const lastPlayedAt = times[times.length - 1] || 0;
  const previousPlayedAt = currentPlayedAt > 0
    ? [...times].reverse().find((time) => time < currentPlayedAt - 90_000) || 0
    : times.length > 1
      ? times[times.length - 2]
      : 0;
  let maxGapDays = 0;
  let maxGapStart: number | null = null;
  let maxGapEnd: number | null = null;

  for (let index = 1; index < times.length; index += 1) {
    const gap = Math.floor((times[index] - times[index - 1]) / DAY_MS);
    if (gap > maxGapDays) {
      maxGapDays = gap;
      maxGapStart = times[index - 1];
      maxGapEnd = times[index];
    }
  }

  const playedCount = totalCount || times.length;
  const monthKeys = [...months.keys()].filter(Boolean);
  const monthNumbers = new Set(monthKeys.map((key) => Number(key.slice(5, 7))).filter((month) => month > 0));
  const playedYears = new Set([...years.keys()].filter((year) => year > 0));
  const recurringSeasonalMonth = monthNumbers.size === 1 ? [...monthNumbers][0] : null;
  const hasRecurringSeasonalMonth = playedCount >= 3 && recurringSeasonalMonth != null && playedYears.size >= 2;

  return {
    count: playedCount,
    firstPlayedAt: firstPlayedAt ? new Date(firstPlayedAt).toISOString() : null,
    lastPlayedAt: lastPlayedAt ? new Date(lastPlayedAt).toISOString() : null,
    previousPlayedAt: previousPlayedAt ? new Date(previousPlayedAt).toISOString() : null,
    bestYear,
    wrapped: getWrappedPeriods(years, months, releaseKey),
    advanced: complete && playedCount > 10
      ? {
          streak,
          loopFactor: loopEntry ? { day: loopEntry[0], count: loopEntry[1] } : null,
          daypart: bestDaypart
            ? {
                key: bestDaypart.key,
                label: bestDaypart.label,
                count: bestDaypart.count,
                percent: playedCount > 0 ? Math.round((bestDaypart.count / playedCount) * 100) : 0,
              }
            : null,
          daysSinceFirst: firstPlayedAt ? Math.max(0, Math.floor((Date.now() - firstPlayedAt) / DAY_MS)) : null,
          top1kPosition: null as number | null,
          topYearPosition: null as number | null,
        }
      : null,
    specialSignals: {
      seasonalMonth: hasRecurringSeasonalMonth ? recurringSeasonalMonth : null,
      maxGapDays,
      maxGapStart: maxGapStart ? new Date(maxGapStart).toISOString() : null,
      maxGapEnd: maxGapEnd ? new Date(maxGapEnd).toISOString() : null,
    },
  };
}

async function getTopTrackPosition(userId: string, trackId: string, after: number, limit: number, deadline: number) {
  if (Date.now() >= deadline) return { position: null as number | null, partial: true };
  const result = await fetchUserTop(userId, "tracks", after, limit, {
    force: false,
    cacheProfile: "heavy",
    requestTimeoutMs: clampTimeout(deadline, 500, 1600),
    maxRetries: 0,
  });
  if (!result.ok) return { position: null as number | null, partial: true };
  const items = getItems(result.data).map((item: any) => normalizeTopItem(item, "tracks")).filter(Boolean);
  const match = items.find((item: any) => {
    const id = item?.id == null ? "" : String(item.id);
    return id === trackId || String(item?.trackId || "") === trackId;
  }) as any;
  return { position: match ? Number(match.position || items.indexOf(match) + 1) : null, partial: false };
}

async function getTop1kPosition(userId: string, trackId: string, deadline: number) {
  return getTopTrackPosition(userId, trackId, 0, 1000, deadline);
}

async function getTopYearPosition(userId: string, trackId: string, deadline: number) {
  const now = new Date();
  const currentYearStart = new Date(now.getFullYear(), 0, 1).getTime();
  return getTopTrackPosition(userId, trackId, currentYearStart, 100, deadline);
}

function makeSpecialCard(code: TrackStorySpecialCode, label: string, tone: TrackStorySpecialTone, detail: string, value?: unknown) {
  return { code, label, tone, detail, value: value ?? null };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = readQueryString(req.query.user);
  const trackId = readQueryString(req.query.track);
  const albumId = readOptionalQueryString(req.query.album);
  const artistIds = splitCsv(readOptionalQueryString(req.query.artists)).slice(0, 5);
  const releaseKey = releaseDayKey(readOptionalQueryString(req.query.releaseDate));
  const currentPlayedAt = parseDateMs(readOptionalQueryString(req.query.currentPlayedAt));

  if (!user || !trackId) {
    return res.status(400).json({ ok: false, error: "missing_user_or_track" });
  }

  const userId = resolveUserId(user);
  const deadline = Date.now() + DEADLINE_MS;
  const configuredUsers = Object.entries(USERS) as Array<[string, { id: string }]>;
  const ownKey = configuredUsers.find(([, configuredUser]) => configuredUser.id === userId)?.[0] || user;
  const friendUsers = configuredUsers.filter(([, configuredUser]) => configuredUser.id !== userId);

  // Own count/history are the modal's primary proof. Start the remaining work in
  // parallel, but never let optional social fanout erase completed own results.
  const ownTrackCountPromise = getEntityStatsForUser(ownKey, userId, "track", trackId, deadline);
  const ownHistoryPromise = fetchOwnTrackHistory(userId, trackId, 0, deadline);
  const albumCountPromise = albumId
    ? getEntityStatsForUser(ownKey, userId, "album", albumId, deadline)
    : Promise.resolve(null);
  const artistCountsPromise = Promise.all(
    artistIds.map((artistId) => getEntityStatsForUser(ownKey, userId, "artist", artistId, deadline))
  );
  const friendTrackCountsPromise = getEntityStatsForGroup("track", trackId, deadline, friendUsers);
  const top1kPromise = getTop1kPosition(userId, trackId, deadline);
  const topYearPromise = getTopYearPosition(userId, trackId, deadline);

  const [ownTrackStats, ownHistory] = await Promise.all([ownTrackCountPromise, ownHistoryPromise]);
  const historyComplete = !ownHistory.partial;
  const ownTrackCount = typeof ownTrackStats.count === "number"
    ? ownTrackStats.count
    : historyComplete
      ? ownHistory.items.length
      : null;
  const ownTrackRow: CountRow = {
    ...ownTrackStats,
    count: ownTrackCount,
  };
  const history = summarizeHistory(ownHistory.items, ownTrackCount ?? ownHistory.items.length, historyComplete, releaseKey, currentPlayedAt);

  const [albumCount, artistCounts, friendTrackCounts] = await Promise.all([
    albumCountPromise,
    artistCountsPromise,
    friendTrackCountsPromise,
  ]);
  const trackCounts = [ownTrackRow, ...friendTrackCounts];
  const trackCountsComplete = trackCounts.every((row) => typeof row.count === "number");
  const firstListenersResult = await getFirstListeners(trackId, trackCounts, deadline);
  const ranking = trackCounts
    .filter((row): row is CountRow & { count: number } => typeof row.count === "number" && row.count > 0)
    .sort((a, b) => b.count - a.count)
    .map((row, index) => ({
      key: row.key,
      id: row.id,
      count: row.count,
      durationMs: row.durationMs ?? 0,
      minutes: row.minutes ?? 0,
      position: index + 1,
    }));

  let topPartial = false;
  if (history.advanced) {
    const [top1k, topYear] = await Promise.all([top1kPromise, topYearPromise]);
    history.advanced.top1kPosition = top1k.position;
    history.advanced.topYearPosition = topYear.position;
    topPartial = top1k.partial || topYear.partial;
  }

  const releaseListeners = releaseKey
    ? firstListenersResult.listeners.filter((listener) => isReleaseWindow(listener.playedAt, releaseKey))
    : [];
  const ownFirst = firstListenersResult.listeners.find((listener) => listener.id === userId);
  const ownFirstPlayedAt = ownFirst?.playedAt || (history.firstPlayedAt ? new Date(history.firstPlayedAt).getTime() : 0);
  const heardOnRelease = historyComplete && isReleaseWindow(ownFirstPlayedAt, releaseKey);
  const firstPlayedAt = firstListenersResult.listeners[0]?.playedAt || 0;
  const socialPartial = !trackCountsComplete || firstListenersResult.partial;
  const heardFirst = !socialPartial && !!ownFirstPlayedAt && !!firstPlayedAt && ownFirstPlayedAt === firstPlayedAt;
  const totalCirclePlays = ranking.reduce((sum, row) => sum + row.count, 0);
  const friendsWithAnyPlay = ranking.filter((row) => row.id !== userId && row.count > 0);
  const overTenListeners = ranking.filter((row) => row.count > 10);
  const ownRanking = ranking.find((row) => row.id === userId);
  const specialCards: Array<ReturnType<typeof makeSpecialCard>> = [];

  if (historyComplete && heardOnRelease) {
    specialCards.push(makeSpecialCard("shiny", "SHINY SONG", "shine", "Ouvida no lançamento ou na véspera.", history.firstPlayedAt));
  }
  if (trackCountsComplete && ownTrackCount != null && ownTrackCount > 10 && friendsWithAnyPlay.length === 0) {
    specialCards.push(makeSpecialCard("hiddenGem", "HIDDEN GEM", "hiddenGem", "Mais de 10 plays só seus no círculo.", ownTrackCount));
  }
  if (historyComplete && history.specialSignals.seasonalMonth) {
    specialCards.push(makeSpecialCard("seasonal", "SAZONAL SONG", "seasonal", "Esse mês voltou em anos diferentes.", history.specialSignals.seasonalMonth));
  }
  if (trackCountsComplete && ownTrackCount != null && ownTrackCount > 10 && overTenListeners.length === 2 && overTenListeners.some((row) => row.id === userId)) {
    const friendOverTen = overTenListeners.find((row) => row.id !== userId);
    specialCards.push(makeSpecialCard("special", "SPECIAL SONG", "special", "Só você e mais um amigo passaram de 10 plays.", friendOverTen?.count));
  }
  if (historyComplete && history.specialSignals.maxGapDays > 365) {
    specialCards.push(makeSpecialCard("late", "THE LATE SONG", "late", "Voltou depois de mais de 1 ano sem tocar.", {
      previousPlayedAt: history.specialSignals.maxGapStart,
      returnedAt: history.specialSignals.maxGapEnd,
      gapDays: history.specialSignals.maxGapDays,
    }));
  }

  const specialPriority = new Map<TrackStorySpecialCode, number>([
    ["shiny", 0],
    ["hiddenGem", 1],
    ["special", 2],
    ["late", 3],
    ["seasonal", 4],
  ]);
  specialCards.sort((left, right) => (
    (specialPriority.get(left.code) ?? 99) - (specialPriority.get(right.code) ?? 99)
  ));

  const trackCountProven = typeof ownTrackCount === "number";
  const albumCountProven = !albumId || typeof albumCount?.count === "number";
  const artistCoverage = Object.fromEntries(
    artistIds.map((artistId, index) => [artistId, typeof artistCounts[index]?.count === "number"])
  );
  const artistCountsProven = Object.values(artistCoverage).every(Boolean);
  const countsPartial = !trackCountProven || !albumCountProven || !artistCountsProven;
  const partial =
    countsPartial ||
    !historyComplete ||
    socialPartial ||
    topPartial ||
    Date.now() >= deadline;

  setCacheHeaders(res, partial ? 0 : 300, partial, 1800);
  return res.status(200).json({
    ok: true,
    user,
    userId,
    trackId,
    albumId,
    artistIds,
    generatedAt: new Date().toISOString(),
    counts: {
      track: ownTrackCount,
      album: albumId && typeof albumCount?.count === "number" ? albumCount.count : null,
      artists: artistIds.map((artistId, index) => ({
        id: artistId,
        count: typeof artistCounts[index]?.count === "number" ? artistCounts[index].count : null,
        durationMs: artistCounts[index]?.durationMs ?? null,
      })),
    },
    history: {
      count: ownTrackCount ?? history.count,
      firstPlayedAt: historyComplete ? history.firstPlayedAt : null,
      lastPlayedAt: historyComplete ? history.lastPlayedAt : null,
      previousPlayedAt: historyComplete ? history.previousPlayedAt : null,
      bestYear: historyComplete ? history.bestYear : null,
      wrapped: historyComplete ? history.wrapped : null,
    },
    advanced: historyComplete ? history.advanced : null,
    social: {
      firstListeners: firstListenersResult.listeners,
      releaseListeners,
      ranking,
      ownPosition: ownRanking?.position || null,
      cakePiecePercent: trackCountsComplete && ownTrackCount != null && totalCirclePlays > 0
        ? Math.round((ownTrackCount / totalCirclePlays) * 100)
        : null,
      heardOnRelease,
      heardFirst,
    },
    specialCards,
    coverage: {
      partial,
      counts: {
        track: trackCountProven,
        album: albumCountProven,
        artists: artistCoverage,
      },
      historyPartial: !historyComplete,
      socialPartial,
      topPartial,
      fetchedHistoryPages: ownHistory.fetchedPages,
      maxHistoryPages: MAX_HISTORY_PAGES,
      historyItems: ownHistory.items.length,
      deadlineMs: DEADLINE_MS,
      deadlineHit: Date.now() >= deadline,
    },
  });
}
