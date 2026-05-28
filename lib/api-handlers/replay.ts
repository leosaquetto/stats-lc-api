import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getItems, readQueryString } from "../api-helpers.js";
import {
  getStartOfMonthSPMs,
  getStartOfTodaySPMs,
  getStartOfWeekSPMs,
  getStartOfYearSPMs,
} from "../time.js";
import { resolveUserId } from "../users.js";
import { fetchUserStatsRange, normalizeStatsSummary } from "../user-stats-service.js";
import { fetchUserTop, normalizeTopItems } from "../user-tops-service.js";

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
  const after = getAfterFromPeriod(period);

  const [stats, topArtists, topTracks, topAlbums] = await Promise.all([
    fetchUserStatsRange(userId, after, null, {
      force,
      aggregateMode: "none",
      cacheProfile: "replay",
    }),
    fetchUserTop(userId, "artists", after, TOP_LIMITS.artists, { force, cacheProfile: "replay" }),
    fetchUserTop(userId, "tracks", after, TOP_LIMITS.tracks, { force, cacheProfile: "replay" }),
    fetchUserTop(userId, "albums", after, TOP_LIMITS.albums, { force, cacheProfile: "replay" }),
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
    ? await normalizeTopItems(topTracks.data, "tracks", {
        force,
        cacheProfile: "replay",
        albumItems: topAlbumsRaw,
        userId,
        after,
      })
    : [];
  const normalizedTopAlbums = topAlbums.ok
    ? await normalizeTopItems(topAlbums.data, "albums", { force, cacheProfile: "replay" })
    : [];
  const summary = normalizeStatsSummary(stats.data);

  res.status(200).json({
    ok: true,
    user: userInput,
    userId,
    period,
    after,
    totalSongs: summary.streams,
    totalDurationMs: summary.durationMs,
    durationMs: summary.durationMs,
    minutes: summary.minutes,
    hours: summary.hours,
    topArtists: normalizedTopArtists,
    topTracks: normalizedTopTracks,
    topAlbums: normalizedTopAlbums,
    ...(Object.keys(errors).length > 0 ? { errors } : {}),
  });
}
