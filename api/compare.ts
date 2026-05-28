import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildQuery, encodeSegment, getItem, getItems, readOptionalQueryString, readQueryString } from "../lib/api-helpers.js";
import {
  normalizeAlbum,
  normalizeArtist,
  normalizeRecentItem,
  normalizeTopItem,
  normalizeTrack,
  normalizeUserSummary,
} from "../lib/normalize.js";
import { enrichTrackItemsWithAlbumOwners } from "../lib/track-album-enrichment.js";
import {
  getCardinality,
  getCount,
  getDatesBreakdown,
  getDurationMs,
  statsfmFetch,
  type StatsfmResult,
} from "../lib/statsfm.js";
import {
  getStartOfMonthSPMs,
  getStartOfTodaySPMs,
  getStartOfWeekSPMs,
  TIMEZONE_SP,
} from "../lib/time.js";
import { resolveUserId } from "../lib/users.js";

type TopKind = "tracks" | "artists" | "albums";
type CommonKind = TopKind | "genres";

const DEFAULT_LIMIT = 250;
const MAX_LIMIT = 500;
const MAX_USERS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

function readNumber(value: unknown) {
  const raw = readOptionalQueryString(value);
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampLimit(value: unknown) {
  const parsed = readNumber(value) ?? DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(parsed)));
}

function addMonths(timestamp: number, delta: number) {
  const date = new Date(timestamp);
  date.setMonth(date.getMonth() + delta);
  return date.getTime();
}

function resolveRange(req: VercelRequest) {
  const now = Date.now();
  const before = readNumber(req.query.before) ?? now;
  const afterParam = readNumber(req.query.after);
  const period = readQueryString(req.query.period || "4w");

  if (afterParam != null) {
    return {
      period: "custom",
      after: afterParam,
      before,
      source: "explicit",
      timezone: TIMEZONE_SP,
    };
  }

  if (period === "all") {
    return {
      period,
      after: 0,
      before,
      source: "period",
      timezone: TIMEZONE_SP,
    };
  }

  if (period === "6m") {
    return {
      period,
      after: addMonths(before, -6),
      before,
      source: "period",
      timezone: TIMEZONE_SP,
    };
  }

  if (period === "month") {
    return {
      period,
      after: getStartOfMonthSPMs(),
      before,
      source: "period",
      timezone: TIMEZONE_SP,
    };
  }

  if (period === "week") {
    return {
      period,
      after: getStartOfWeekSPMs(),
      before,
      source: "period",
      timezone: TIMEZONE_SP,
    };
  }

  return {
    period: "4w",
    after: getStartOfTodaySPMs() - 28 * DAY_MS,
    before,
    source: "period",
    timezone: TIMEZONE_SP,
  };
}

function parseUsers(value: unknown) {
  const users = readQueryString(value)
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean);

  return [...new Set(users)];
}

function compactError(result: StatsfmResult) {
  return {
    ok: result.ok,
    status: result.status,
    endpoint: result.endpoint,
  };
}

function getExternalIdValues(item: any) {
  const externalIds = item?.externalIds ?? {};
  const spotify = Array.isArray(externalIds?.spotify) ? externalIds.spotify : [];
  const appleMusic = Array.isArray(externalIds?.appleMusic) ? externalIds.appleMusic : [];
  return [...spotify, ...appleMusic].filter(Boolean).map(String);
}

function getIdentityKeys(item: any, kind: CommonKind) {
  if (kind === "genres") {
    const name = String(item?.name ?? item?.tag ?? item?.genre ?? "").trim().toLowerCase();
    return name ? [`genre:${name}`] : [];
  }

  const keys: string[] = [];
  if (item?.id != null) keys.push(`${kind}:id:${String(item.id)}`);

  for (const externalId of getExternalIdValues(item)) {
    keys.push(`${kind}:external:${externalId}`);
  }

  return keys;
}

function normalizeGenreItem(item: any) {
  const name = item?.genre?.name ?? item?.genre?.tag ?? item?.name ?? item?.tag ?? item?.genre ?? null;

  return {
    id: item?.id ?? item?.genre?.id ?? name,
    name,
    tag: item?.tag ?? item?.genre?.tag ?? name,
    streams: item?.streams ?? item?.count ?? 0,
    playedMs: item?.playedMs ?? item?.durationMs ?? null,
    position: item?.position ?? null,
    indicator: item?.indicator ?? null,
    rawAvailableKeys: item && typeof item === "object" ? Object.keys(item) : [],
  };
}

function normalizeStreamItemForKind(item: any, kind: TopKind) {
  if (kind === "tracks") return normalizeTopItem(item, "tracks");
  if (kind === "artists") return normalizeTopItem(item, "artists");
  return normalizeTopItem(item, "albums");
}

function scoreCommon(perUserEntries: any[]) {
  const streams = perUserEntries.map((entry) => Number(entry.streams ?? 0));
  const ranks = perUserEntries
    .map((entry) => Number(entry.rank ?? 0))
    .filter((rank) => Number.isFinite(rank) && rank > 0);

  const minStreams = streams.length ? Math.min(...streams) : 0;
  const maxStreams = streams.length ? Math.max(...streams) : 0;
  const totalStreams = streams.reduce((sum, value) => sum + value, 0);
  const balance = maxStreams > 0 ? minStreams / maxStreams : 0;
  const rankStrength = ranks.reduce((sum, rank) => sum + 1 / rank, 0);

  return totalStreams + minStreams * 3 + balance * 100 + rankStrength * 1000;
}

function buildCommonRows(kind: CommonKind, userIds: string[], perUserItems: Record<string, any[]>) {
  const rowsByKey = new Map<string, any>();
  const aliasByKey = new Map<string, string>();

  for (const userId of userIds) {
    const items = perUserItems[userId] ?? [];

    items.forEach((item, index) => {
      const keys = getIdentityKeys(item, kind);
      if (keys.length === 0) return;

      const canonicalKey = keys.find((key) => aliasByKey.has(key)) ?? keys[0];
      const resolvedKey = aliasByKey.get(canonicalKey) ?? canonicalKey;

      for (const key of keys) {
        aliasByKey.set(key, resolvedKey);
      }

      const current = rowsByKey.get(resolvedKey) ?? {
        key: resolvedKey,
        type: kind,
        item,
        sharedByCount: 0,
        byUser: {},
      };

      const rank = item?.position ?? index + 1;
      current.byUser[userId] = {
        rank,
        streams: item?.streams ?? 0,
        playedMs: item?.playedMs ?? null,
        minutes: item?.playedMs != null ? Math.floor(Number(item.playedMs) / 60000) : null,
        item,
      };
      current.sharedByCount = Object.keys(current.byUser).length;
      rowsByKey.set(resolvedKey, current);
    });
  }

  return [...rowsByKey.values()]
    .filter((row) => row.sharedByCount >= 2)
    .map((row) => {
      const entries = Object.values(row.byUser) as any[];
      return {
        ...row,
        score: scoreCommon(entries),
      };
    })
    .sort((a, b) => b.score - a.score || b.sharedByCount - a.sharedByCount);
}

async function fetchUserComparisonData(
  user: string,
  range: ReturnType<typeof resolveRange>,
  limit: number,
  force: boolean
) {
  const userId = resolveUserId(user);
  const rangeQuery = {
    after: range.after,
    before: range.before,
  };
  const topQuery = buildQuery({
    ...rangeQuery,
    limit,
  });
  const [
    profile,
    stats,
    dates,
    topTracks,
    topArtists,
    topAlbums,
    topGenres,
    firstStreams,
    lastStreams,
  ] = await Promise.all([
    statsfmFetch(`/users/${encodeSegment(userId)}`, { force }),
    statsfmFetch(`/users/${encodeSegment(userId)}/streams/stats${buildQuery(rangeQuery)}`, {
      force,
      aggregateMode: "none",
    }),
    statsfmFetch(`/users/${encodeSegment(userId)}/streams/dates${buildQuery(rangeQuery)}`, {
      force,
      aggregateMode: "none",
    }),
    statsfmFetch(`/users/${encodeSegment(userId)}/top/tracks${topQuery}`, { force }),
    statsfmFetch(`/users/${encodeSegment(userId)}/top/artists${topQuery}`, { force }),
    statsfmFetch(`/users/${encodeSegment(userId)}/top/albums${topQuery}`, { force }),
    statsfmFetch(`/users/${encodeSegment(userId)}/top/genres${topQuery}`, { force }),
    statsfmFetch(`/users/${encodeSegment(userId)}/streams${buildQuery({ ...rangeQuery, limit: 5, order: "asc" })}`, { force }),
    statsfmFetch(`/users/${encodeSegment(userId)}/streams${buildQuery({ ...rangeQuery, limit: 5, order: "desc" })}`, { force }),
  ]);

  const errors: Record<string, any> = {};
  for (const [key, result] of Object.entries({
    profile,
    stats,
    cardinality: stats,
    dates,
    topTracks,
    topArtists,
    topAlbums,
    topGenres,
    firstStreams,
    lastStreams,
  })) {
    if (!result.ok) errors[key] = compactError(result);
  }

  const statsData: any = stats.ok ? stats.data : null;
  const durationMs = getDurationMs(statsData);
  const topTrackItems: any[] = topTracks.ok
    ? await enrichTrackItemsWithAlbumOwners(getItems(topTracks.data), {
        force,
        albumItems: topAlbums.ok ? getItems(topAlbums.data) : [],
      })
    : [];
  const firstStreamItems: any[] = firstStreams.ok
    ? await enrichTrackItemsWithAlbumOwners(getItems(firstStreams.data), { force })
    : [];
  const lastStreamItems: any[] = lastStreams.ok
    ? await enrichTrackItemsWithAlbumOwners(getItems(lastStreams.data), { force })
    : [];

  return {
    input: user,
    userId,
    profile: profile.ok ? normalizeUserSummary(getItem(profile.data)) : normalizeUserSummary({ id: userId }),
    summary: {
      streams: getCount(statsData),
      durationMs,
      minutes: Math.floor(durationMs / 60000),
      hours: Math.floor(durationMs / 3600000),
      cardinality: getCardinality(statsData),
    },
    tops: {
      tracks: topTrackItems.map((item) => normalizeStreamItemForKind(item, "tracks")),
      artists: topArtists.ok ? getItems(topArtists.data).map((item: any) => normalizeStreamItemForKind(item, "artists")) : [],
      albums: topAlbums.ok ? getItems(topAlbums.data).map((item: any) => normalizeStreamItemForKind(item, "albums")) : [],
      genres: topGenres.ok ? getItems(topGenres.data).map(normalizeGenreItem) : [],
    },
    time: dates.ok ? getDatesBreakdown(dates.data) : null,
    firstStreams: firstStreamItems.map(normalizeRecentItem),
    lastStreams: lastStreamItems.map(normalizeRecentItem),
    errors,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const users = parseUsers(req.query.users);
  const limit = clampLimit(req.query.limit);
  const force = req.query.force === "1";
  const range = resolveRange(req);

  if (users.length < 2) {
    return res.status(400).json({ ok: false, error: "missing_users" });
  }

  if (users.length > MAX_USERS) {
    return res.status(400).json({ ok: false, error: "too_many_users", maxUsers: MAX_USERS });
  }

  if (range.before <= range.after) {
    return res.status(400).json({ ok: false, error: "invalid_range" });
  }

  const settled = await Promise.allSettled(
    users.map((user) => fetchUserComparisonData(user, range, limit, force))
  );

  const userData = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;

    const input = users[index];
    const userId = resolveUserId(input);
    return {
      input,
      userId,
      profile: normalizeUserSummary({ id: userId }),
      summary: {
        streams: 0,
        durationMs: 0,
        minutes: 0,
        hours: 0,
        cardinality: { artists: null, tracks: null, albums: null },
      },
      tops: {
        tracks: [],
        artists: [],
        albums: [],
        genres: [],
      },
      time: null,
      firstStreams: [],
      lastStreams: [],
      errors: {
        user: String(result.reason),
      },
    };
  });

  const userIds = userData.map((user) => user.userId);

  res.status(200).json({
    ok: true,
    generatedAt: new Date().toISOString(),
    range,
    limit,
    users: userData.map(({ input, userId, profile }) => ({ input, userId, profile })),
    summaryByUser: Object.fromEntries(userData.map((user) => [user.userId, user.summary])),
    common: {
      tracks: buildCommonRows("tracks", userIds, Object.fromEntries(userData.map((user) => [user.userId, user.tops.tracks]))),
      artists: buildCommonRows("artists", userIds, Object.fromEntries(userData.map((user) => [user.userId, user.tops.artists]))),
      albums: buildCommonRows("albums", userIds, Object.fromEntries(userData.map((user) => [user.userId, user.tops.albums]))),
      genres: buildCommonRows("genres", userIds, Object.fromEntries(userData.map((user) => [user.userId, user.tops.genres]))),
    },
    timeByUser: Object.fromEntries(userData.map((user) => [user.userId, user.time])),
    firstStreamsByUser: Object.fromEntries(userData.map((user) => [user.userId, user.firstStreams])),
    lastStreamsByUser: Object.fromEntries(userData.map((user) => [user.userId, user.lastStreams])),
    errors: Object.fromEntries(userData.map((user) => [user.userId, user.errors])),
  });
}
