import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildQuery, encodeSegment, getItems, readQueryString } from "../lib/api-helpers.js";
import { normalizeTopItem } from "../lib/normalize.js";
import { getCount, statsfmFetch } from "../lib/statsfm.js";
import { enrichTrackItemsWithAlbumOwners } from "../lib/track-album-enrichment.js";
import {
  getStartOfMonthSPMs,
  getStartOfTodaySPMs,
  getStartOfWeekSPMs,
  getStartOfYearSPMs,
} from "../lib/time.js";
import { resolveUserId } from "../lib/users.js";

const VALID_PERIODS = ["today", "week", "month", "year", "all"] as const;
type ReplayPeriod = typeof VALID_PERIODS[number];
type ReplayTopType = "artists" | "tracks" | "albums";

const TOP_LIMITS: Record<ReplayTopType, number> = {
  artists: 20,
  tracks: 30,
  albums: 15,
};

function isReplayPeriod(value: string): value is ReplayPeriod {
  return VALID_PERIODS.includes(value as ReplayPeriod);
}

function getAfterFromPeriod(period: ReplayPeriod) {
  if (period === "today") return getStartOfTodaySPMs();
  if (period === "week") return getStartOfWeekSPMs();
  if (period === "month") return getStartOfMonthSPMs();
  if (period === "year") return getStartOfYearSPMs();
  return 0;
}

async function normalizeTopItems(data: unknown, type: ReplayTopType, options: {
  force?: boolean;
  albumItems?: any[];
} = {}) {
  const items = getItems(data);
  const enrichedItems = type === "tracks"
    ? await enrichTrackItemsWithAlbumOwners(items, {
        force: options.force,
        cacheProfile: "replay",
        albumItems: options.albumItems,
      })
    : items;

  return enrichedItems.map((item: any) => normalizeTopItem(item, type));
}

function compactError(result: any) {
  return {
    status: result?.status ?? 500,
    endpoint: result?.endpoint ?? null,
    error:
      typeof result?.data?.error === "string"
        ? result.data.error
        : result?.data?.message ?? `http_${result?.status ?? 500}`,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const requestedPeriod = readQueryString(req.query.period || "today");
  const userInput = readQueryString(req.query.userId || req.query.user);
  const force = req.query.force === "1";

  if (!userInput) {
    return res.status(400).json({ ok: false, error: "missing_user" });
  }

  if (!isReplayPeriod(requestedPeriod)) {
    return res.status(400).json({ ok: false, error: "invalid_period" });
  }

  const period = requestedPeriod;
  const userId = resolveUserId(userInput);
  const encodedUserId = encodeSegment(userId);
  const after = getAfterFromPeriod(period);
  const rangeQuery = buildQuery({ after });

  const [stats, topArtists, topTracks, topAlbums] = await Promise.all([
    statsfmFetch(`/users/${encodedUserId}/streams/stats${rangeQuery}`, {
      force,
      aggregateMode: "none",
      cacheProfile: "replay",
    }),
    statsfmFetch(
      `/users/${encodedUserId}/top/artists${buildQuery({ after, limit: TOP_LIMITS.artists })}`,
      { force, cacheProfile: "replay" }
    ),
    statsfmFetch(
      `/users/${encodedUserId}/top/tracks${buildQuery({ after, limit: TOP_LIMITS.tracks })}`,
      { force, cacheProfile: "replay" }
    ),
    statsfmFetch(
      `/users/${encodedUserId}/top/albums${buildQuery({ after, limit: TOP_LIMITS.albums })}`,
      { force, cacheProfile: "replay" }
    ),
  ]);

  if (!stats.ok) {
    return res.status(stats.status).json(stats);
  }

  const errors: Record<string, unknown> = {};
  if (!topArtists.ok) errors.topArtists = compactError(topArtists);
  if (!topTracks.ok) errors.topTracks = compactError(topTracks);
  if (!topAlbums.ok) errors.topAlbums = compactError(topAlbums);

  const topAlbumsRaw = topAlbums.ok ? getItems(topAlbums.data) : [];
  const normalizedTopArtists = topArtists.ok ? await normalizeTopItems(topArtists.data, "artists") : [];
  const normalizedTopTracks = topTracks.ok
    ? await normalizeTopItems(topTracks.data, "tracks", { force, albumItems: topAlbumsRaw })
    : [];
  const normalizedTopAlbums = topAlbums.ok ? await normalizeTopItems(topAlbums.data, "albums") : [];

  res.status(200).json({
    ok: true,
    user: userInput,
    userId,
    period,
    after,
    totalSongs: getCount(stats.data),
    topArtists: normalizedTopArtists,
    topTracks: normalizedTopTracks,
    topAlbums: normalizedTopAlbums,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  });
}
