import type { VercelRequest, VercelResponse } from "@vercel/node";
import { USERS } from "../users.js";
import { extractUserPlatform, normalizeRecentItem } from "../normalize.js";
import { statsfmFetch } from "../statsfm.js";
import { fetchUserRecentStreams } from "../user-streams-service.js";
import { enrichTrackItemsWithAlbumOwners } from "../track-album-enrichment.js";
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
    return error;
  }
}

async function getLiveUserBundle(
  key: string,
  user: { id: string; platform?: string },
  force: boolean,
  debug: boolean
) {
  const upstreamForce = false;

  const [profileResult, recentResult] = await Promise.all([
    fetchSafe(statsfmFetch(`/users/${user.id}`, { force: upstreamForce })),
    fetchSafe(fetchUserRecentStreams(user.id, { limit: 1 }, { force: upstreamForce, cacheProfile: "live" })),
  ]);

  const profile = profileResult && typeof profileResult === "object" && "ok" in profileResult
    ? profileResult
    : { ok: false, status: 503, endpoint: `/users/${user.id}`, data: { error: "profile_fetch_failed" } };

  const recent = recentResult && typeof recentResult === "object" && "ok" in recentResult
    ? recentResult
    : { ok: false, status: 503, endpoint: `/users/${user.id}/streams/recent`, data: { error: "recent_fetch_failed" } };

  const profileData: any = (profile as any).data;
  const profileRaw = profileData?.item ?? null;
  const recentData: any = (recent as any).data;
  const recentItems = Array.isArray(recentData?.items) ? recentData.items : [];

  // Enrich recent item with correct album using track stream evidence
  // Fallback to original items if enrichment fails (resilient)
  let enrichedItems = recentItems;
  let enrichmentWarning: string | null = null;

  if (recentItems.length > 0) {
    try {
      enrichedItems = await enrichTrackItemsWithAlbumOwners(recentItems, {
        force: upstreamForce,
        userId: user.id,
        useTrackStreamEvidence: true,
        trackStreamEvidenceStrategy: "latest",
        cacheProfile: "live",
        requestTimeoutMs: 2000, // 2s timeout for enrichment
      });
    } catch (error: any) {
      // Enrichment failed: use original items, add warning
      enrichedItems = recentItems;
      enrichmentWarning = "album_enrichment_failed";
      if (debug) {
        console.warn(`[group-live] enrichment failed for ${key}:`, error?.message ?? String(error));
      }
    }
  }

  const recentItemRaw = enrichedItems[0] ?? null;
  const nowPlayingRaw = recentItemRaw ? normalizeRecentItem(recentItemRaw) : null;
  const platformDecision = extractUserPlatform(profileRaw, key);

  const warnings = [
    ...(enrichmentWarning ? [enrichmentWarning] : []),
  ].filter(Boolean);

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
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(debug
      ? {
          debug: {
            profile: sanitizeDebugValue(profile),
            recent: sanitizeDebugValue(recent),
          },
        }
      : {}),
    errors: {
      profile: (profile as any).ok ? null : profile,
      recent: (recent as any).ok ? null : recent,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const force = req.query.force === "1";
  const debug = req.query.debug === "1";
  const users = Object.entries(USERS) as Array<[keyof typeof USERS, { id: string; platform?: string }]>;

  try {
    const settled = await mapWithConcurrency(users, 2, ([key, user]) =>
      getLiveUserBundle(String(key), user, force, debug)
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

    setCacheHeaders(res, 5, debug, 15);

    return res.status(200).json({
      ok: true,
      source: "stats.fm-api",
      generatedAt: new Date().toISOString(),
      members,
    });
  } catch (error: any) {
    return sendJsonError(res, 503, "group_live_failed", {
      message: error?.message ?? String(error),
    });
  }
}
