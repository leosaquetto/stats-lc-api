import type { VercelRequest, VercelResponse } from "@vercel/node";
import { USERS } from "../users.js";
import {
  extractUserPlatform,
  normalizeRecentItem,
} from "../normalize.js";
import { statsfmFetch } from "../statsfm.js";
import { enrichTrackItemsWithAlbumOwners } from "../track-album-enrichment.js";

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

async function getLiveUserBundle(
  key: string,
  user: { id: string; platform?: string },
  force: boolean,
  debug: boolean
) {
  const [profile, recent] = await Promise.all([
    statsfmFetch(`/users/${user.id}`, { force }),
    statsfmFetch(`/users/${user.id}/streams/recent?limit=1`, {
      force,
      cacheProfile: "live",
    }),
  ]);

  const profileData: any = profile.data;
  const profileRaw = profileData?.item ?? null;
  const recentData: any = recent.data;
  const recentItems = Array.isArray(recentData?.items)
    ? await enrichTrackItemsWithAlbumOwners(recentData.items, { force, cacheProfile: "live" })
    : [];
  const recentItemRaw = recentItems[0] ?? null;
  const nowPlayingRaw = recentItemRaw ? normalizeRecentItem(recentItemRaw) : null;
  const platformDecision = extractUserPlatform(profileRaw, key);

  return {
    key,
    id: user.id,
    profile: {
      displayName: getDisplayName(profileData, key),
      image: profileRaw?.image ?? null,
    },
    platform: platformDecision,
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
    ...(debug
      ? {
          debug: {
            profile: sanitizeDebugValue(profile),
            recent: sanitizeDebugValue(recent),
          },
        }
      : {}),
    errors: {
      profile: profile.ok ? null : profile,
      recent: recent.ok ? null : recent,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const force = req.query.force === "1";
  const debug = req.query.debug === "1";
  const users = Object.entries(USERS) as Array<[keyof typeof USERS, { id: string; platform?: string }]>;

  const settled = await Promise.allSettled(
    users.map(([key, user]) => getLiveUserBundle(String(key), user, force, debug))
  );

  const members = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;

    const [key, user] = users[index];

    return {
      key,
      id: user.id,
      profile: {
        displayName: String(key),
        image: null,
      },
      platform: {
        primary: user.platform ?? "unknown",
        confidence: "manual",
        source: "manual",
        sourceKey: key,
        rawValue: user.platform ?? null,
      },
      nowPlaying: null,
      error: String(result.reason),
    };
  });

  res.status(200).json({
    ok: true,
    source: "stats.fm-api",
    generatedAt: new Date().toISOString(),
    members,
  });
}
