import type { VercelRequest, VercelResponse } from "@vercel/node";
import { USERS } from "../users.js";
import {
  getCount,
  getDurationMs,
  getStatsfmHealthSnapshot,
  statsfmFetch,
} from "../statsfm.js";
import { fetchUserStatsRange } from "../user-stats-service.js";
import { fetchUserRecentStreams } from "../user-streams-service.js";
import { fetchUserTop } from "../user-tops-service.js";
import {
  extractUserPlatform,
  normalizeRecentItem,
  normalizeTopItem,
} from "../normalize.js";
import {
  enrichAlbumItemsWithOwners,
  enrichTrackItemsWithAlbumOwners,
} from "../track-album-enrichment.js";
import {
  getStartOfMonthSPMs,
  getStartOfTodaySPMs,
  getStartOfWeekSPMs,
  TIMEZONE_SP,
} from "../time.js";
import { mapWithConcurrency, sendJsonError, setCacheHeaders } from "../api-helpers.js";




const SENSITIVE_KEY_PATTERN = /(token|authorization|cookie|secret|session)/i;

function sanitizeDebugValue(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeDebugValue);

  if (value && typeof value === "object") {
    return Object.entries(value).reduce((acc, [key, entry]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        acc[key] = "[REDACTED]";
        return acc;
      }

      acc[key] = sanitizeDebugValue(entry);
      return acc;
    }, {} as Record<string, any>);
  }

  return value;
}

function getDisplayName(profileData: any, fallback: string) {
  return (
    profileData?.item?.displayName ??
    profileData?.item?.username ??
    profileData?.item?.name ??
    fallback
  );
}

async function fetchSafe<T>(promise: Promise<T>) {
  try {
    return await promise;
  } catch (error: any) {
    return {
      ok: false,
      status: 503,
      endpoint: null,
      data: { error: error?.message ?? String(error) },
    };
  }
}

async function getUserBundle(
  key: string,
  user: { id: string },
  force: boolean,
  afterToday: number,
  afterWeek: number,
  afterMonth: number,
  debug: boolean
) {
  const upstreamForce = false;
  const [
    profile,
    recent,
  ] = await Promise.all([
    fetchSafe(statsfmFetch(`/users/${user.id}`, { force: upstreamForce })),
    fetchSafe(fetchUserRecentStreams(user.id, { limit: 10 }, { force: upstreamForce })),
  ]);

  const [
    todayStats,
    weekStats,
    monthStats,
  ] = await Promise.all([
    fetchSafe(fetchUserStatsRange(user.id, afterToday, null, { force: upstreamForce })),
    fetchSafe(fetchUserStatsRange(user.id, afterWeek, null, { force: upstreamForce })),
    fetchSafe(fetchUserStatsRange(user.id, afterMonth, null, { force: upstreamForce })),
  ]);

  const [
    topArtists,
    topTracks,
    topAlbums,
  ] = await Promise.all([
    fetchSafe(fetchUserTop(user.id, "artists", afterWeek, 5, { force: upstreamForce })),
    fetchSafe(fetchUserTop(user.id, "tracks", afterWeek, 5, { force: upstreamForce })),
    fetchSafe(fetchUserTop(user.id, "albums", afterWeek, 5, { force: upstreamForce })),
  ]);

  const profileData: any = profile.data;
  const recentData: any = recent.data;
  const todayData: any = todayStats.data;
  const weekData: any = weekStats.data;
  const monthData: any = monthStats.data;
  const artistsData: any = topArtists.data;
  const tracksData: any = topTracks.data;
  const albumsData: any = topAlbums.data;

  const displayName = getDisplayName(profileData, key);
  const profileRaw = profileData?.item ?? null;
  const recentItems = Array.isArray(recentData?.items)
    ? await enrichTrackItemsWithAlbumOwners(recentData.items, { force: upstreamForce, userId: user.id })
    : [];
  const topTrackItems = Array.isArray(tracksData?.items)
    ? await enrichTrackItemsWithAlbumOwners(tracksData.items, {
        force: upstreamForce,
        albumItems: Array.isArray(albumsData?.items) ? albumsData.items : [],
        userId: user.id,
        after: afterWeek,
      })
    : [];
  const topAlbumItems = Array.isArray(albumsData?.items)
    ? await enrichAlbumItemsWithOwners(albumsData.items, { force: upstreamForce })
    : [];
  const recentItemRaw: any = recentItems[0] ?? null;

  const platformDecision = extractUserPlatform(profileRaw, key);
  const nowPlayingRaw =
    recentItems[0]
      ? normalizeRecentItem(recentItems[0])
      : null;

  const recentNormalized = recentItems.map(normalizeRecentItem);

  const catalogSummary = recentNormalized.reduce(
    (acc: any, item: any) => {
      if (item?.track?.catalogAvailability?.spotify) acc.recentSpotifyAvailableCount += 1;
      if (item?.track?.catalogAvailability?.appleMusic) acc.recentAppleMusicAvailableCount += 1;
      return acc;
    },
    { recentSpotifyAvailableCount: 0, recentAppleMusicAvailableCount: 0 }
  );

  const debugData = debug
    ? {
        rawKeys: {
          profile: Object.keys(profileData?.item ?? profileData ?? {}),
          recentItem: Object.keys(recentData?.items?.[0] ?? {}),
          recentTrack: Object.keys(recentData?.items?.[0]?.track ?? {}),
          recentAlbum: Object.keys(recentData?.items?.[0]?.track?.albums?.[0] ?? {}),
        },
        platformDecision: sanitizeDebugValue(platformDecision),
        durationDecision: {
          rawTrackDurationMs:
            recentItemRaw?.track?.durationMs ??
            recentItemRaw?.track?.duration_ms ??
            recentItemRaw?.track?.duration ??
            recentItemRaw?.track?.trackDurationMs ??
            null,
          normalizedDurationMs: nowPlayingRaw?.track?.durationMs ?? null,
          rawPlayedMs: recentItemRaw?.playedMs ?? recentItemRaw?.played_ms ?? null,
          normalizedPlayedMs: nowPlayingRaw?.playedMs ?? null,
        },
      }
    : null;

  return {
    key,
    id: user.id,

    profile: {
      displayName,
      username: profileData?.item?.username ?? null,
      image: profileData?.item?.image ?? null,
    },

    platform: platformDecision,

    catalogSummary,

    nowPlaying: nowPlayingRaw
      ? {
          ...nowPlayingRaw,
          playedMs: nowPlayingRaw.playedMs ?? null,
          durationMs: nowPlayingRaw?.track?.durationMs ?? null,
          track: nowPlayingRaw.track
            ? {
                ...nowPlayingRaw.track,
                durationMs: nowPlayingRaw.track.durationMs ?? null,
              }
            : null,
          platformCandidate: {
            primary: nowPlayingRaw.platform ?? "unknown",
            confidence: nowPlayingRaw.platformConfidence ?? "low",
            sourceKey: nowPlayingRaw.platformSourceKey ?? null,
            rawValue: nowPlayingRaw.serviceCandidate?.rawValue ?? null,
          },
        }
      : null,

    recent: recentNormalized,

    stats: {
      today: {
        streams: getCount(todayData),
        durationMs: getDurationMs(todayData),
        minutes: Math.floor(getDurationMs(todayData) / 60000),
      },
      week: {
        streams: getCount(weekData),
        durationMs: getDurationMs(weekData),
        minutes: Math.floor(getDurationMs(weekData) / 60000),
      },
      month: {
        streams: getCount(monthData),
        durationMs: getDurationMs(monthData),
        minutes: Math.floor(getDurationMs(monthData) / 60000),
      },
    },

    tops: {
      artists: Array.isArray(artistsData?.items)
        ? artistsData.items.map((item: any) => normalizeTopItem(item, "artists"))
        : [],
      tracks: topTrackItems.map((item: any) => normalizeTopItem(item, "tracks")),
      albums: topAlbumItems.map((item: any) => normalizeTopItem(item, "albums")),
    },

    ...(debugData ? { debug: debugData } : {}),

    errors: {
      profile: profile.ok ? null : profile,
      recent: recent.ok ? null : recent,
      todayStats: todayStats.ok ? null : todayStats,
      weekStats: weekStats.ok ? null : weekStats,
      monthStats: monthStats.ok ? null : monthStats,
      topArtists: topArtists.ok ? null : topArtists,
      topTracks: topTracks.ok ? null : topTracks,
      topAlbums: topAlbums.ok ? null : topAlbums,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const force = req.query.force === "1";
  const debug = req.query.debug === "1";
  const users = Object.entries(USERS) as Array<[keyof typeof USERS, { id: string }]>;

  const afterToday = getStartOfTodaySPMs();
  const afterWeek = getStartOfWeekSPMs();
  const afterMonth = getStartOfMonthSPMs();

  try {
    const settled = await mapWithConcurrency(
      users,
      1,
      ([key, user]) => getUserBundle(String(key), user, force, afterToday, afterWeek, afterMonth, debug)
    );

  const members = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;

    const [key, user] = users[index];

    return {
      key,
      id: user.id,
      profile: {
        displayName: String(key),
        username: null,
        image: null,
      },
      error: String(result.reason),
    };
  });

  const rankingWeek = [...members]
    .sort(
      (a: any, b: any) =>
        (b?.stats?.week?.streams ?? 0) - (a?.stats?.week?.streams ?? 0)
    )
    .map((member: any, index) => ({
      position: index + 1,
      key: member.key,
      id: member.id,
      displayName: member.profile?.displayName ?? member.key,
      image: member.profile?.image ?? null,
      streams: member.stats?.week?.streams ?? 0,
    }));

  const rankingMonth = [...members]
    .sort(
      (a: any, b: any) =>
        (b?.stats?.month?.streams ?? 0) - (a?.stats?.month?.streams ?? 0)
    )
    .map((member: any, index) => ({
      position: index + 1,
      key: member.key,
      id: member.id,
      displayName: member.profile?.displayName ?? member.key,
      image: member.profile?.image ?? null,
      streams: member.stats?.month?.streams ?? 0,
    }));

  const rankingToday = [...members]
    .sort(
      (a: any, b: any) =>
        (b?.stats?.today?.streams ?? 0) - (a?.stats?.today?.streams ?? 0)
    )
    .map((member: any, index) => ({
      position: index + 1,
      key: member.key,
      id: member.id,
      displayName: member.profile?.displayName ?? member.key,
      image: member.profile?.image ?? null,
      streams: member.stats?.today?.streams ?? 0,
    }));

  const generatedAt = new Date().toISOString();

  const debugPayload = debug
    ? {
        members: members.map((member: any) => ({
          key: member?.key,
          rawKeys: member?.debug?.rawKeys ?? null,
          platformDecision: member?.platform ?? null,
          durationDecision: member?.debug?.durationDecision ?? null,
        })),
      }
    : undefined;

    setCacheHeaders(res, 60, debug, 600);

    return res.status(200).json({
      ok: true,
      source: "stats.fm-api",
      generatedAt,
      members,
      rankings: {
        today: rankingToday,
        week: rankingWeek,
        month: rankingMonth,
      },
      ...(debug
        ? {
            debug: {
              timezone: TIMEZONE_SP,
              afterToday,
              afterWeek,
              afterMonth,
              generatedAt,
              members: debugPayload?.members ?? [],
              statsfm: getStatsfmHealthSnapshot(),
            },
          }
        : {}),
    });
  } catch (error: any) {
    return sendJsonError(res, 503, "group_failed", {
      message: error?.message ?? String(error),
    });
  }
}
