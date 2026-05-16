import type { VercelRequest, VercelResponse } from "@vercel/node";
import { USERS } from "../lib/users.js";
import {
  getCount,
  getDurationMs,
  getStatsfmHealthSnapshot,
  statsfmFetch,
} from "../lib/statsfm.js";
import {
  extractUserPlatform,
  normalizeRecentItem,
  normalizeTopItem,
} from "../lib/normalize.js";
import {
  getStartOfMonthSPMs,
  getStartOfTodaySPMs,
  getStartOfWeekSPMs,
  TIMEZONE_SP,
} from "../lib/time.js";




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

async function getUserBundle(
  key: string,
  user: { id: string },
  force: boolean,
  afterToday: number,
  afterWeek: number,
  afterMonth: number,
  debug: boolean
) {
  const [
    profile,
    recent,
    todayStats,
    weekStats,
    monthStats,
    topArtists,
    topTracks,
    topAlbums,
  ] = await Promise.all([
    statsfmFetch(`/users/${user.id}`, { force }),
    statsfmFetch(`/users/${user.id}/streams/recent?limit=10`, { force }),
    statsfmFetch(`/users/${user.id}/streams/stats?after=${afterToday}`, { force }),
    statsfmFetch(`/users/${user.id}/streams/stats?after=${afterWeek}`, { force }),
    statsfmFetch(`/users/${user.id}/streams/stats?after=${afterMonth}`, { force }),
    statsfmFetch(`/users/${user.id}/top/artists?after=${afterWeek}&limit=5`, { force }),
    statsfmFetch(`/users/${user.id}/top/tracks?after=${afterWeek}&limit=5`, { force }),
    statsfmFetch(`/users/${user.id}/top/albums?after=${afterWeek}&limit=5`, { force }),
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
  const recentItemRaw = recentData?.items?.[0] ?? null;

  const platformDecision = extractUserPlatform(profileRaw, key);
  const nowPlayingRaw =
    Array.isArray(recentData?.items) && recentData.items[0]
      ? normalizeRecentItem(recentData.items[0])
      : null;

  const recentNormalized = Array.isArray(recentData?.items)
    ? recentData.items.map(normalizeRecentItem)
    : [];

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
      tracks: Array.isArray(tracksData?.items)
        ? tracksData.items.map((item: any) => normalizeTopItem(item, "tracks"))
        : [],
      albums: Array.isArray(albumsData?.items)
        ? albumsData.items.map((item: any) => normalizeTopItem(item, "albums"))
        : [],
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

  const settled = await Promise.allSettled(
    users.map(([key, user]) =>
      getUserBundle(String(key), user, force, afterToday, afterWeek, afterMonth, debug)
    )
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

  res.status(200).json({
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
}
