import type { VercelRequest, VercelResponse } from "@vercel/node";
import { USERS } from "../users.js";
import { extractUserPlatform, normalizeRecentItem } from "../normalize.js";
import { getCount, getDurationMs, statsfmFetch } from "../statsfm.js";
import { getStartOfTodaySPMs, TIMEZONE_SP } from "../time.js";
import { fetchUserRecentStreams } from "../user-streams-service.js";
import { fetchUserStatsRange } from "../user-stats-service.js";
import { enrichTrackItemsWithAlbumOwners } from "../track-album-enrichment.js";
import { sendJsonError, setCacheHeaders } from "../api-helpers.js";

const SENSITIVE_KEY_PATTERN = /(token|authorization|cookie|secret|session)/i;
const LIVE_ENDPOINT_DEADLINE_MS = 1900;
const LIVE_USER_REQUEST_TIMEOUT_MS = 950;
const LIVE_ENRICHMENT_BUDGET_MS = 450;
const LIVE_STATS_REQUEST_TIMEOUT_MS = 850;
const DAY_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: TIMEZONE_SP,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function getDayKey(date: Date) {
  const parts = Object.fromEntries(
    DAY_FORMATTER.formatToParts(date).map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

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

function getNowPlayingTimestamp(nowPlaying: any) {
  return nowPlaying?.timestamp ?? nowPlaying?.playedAt ?? nowPlaying?.endTime ?? null;
}

function isRecentNowPlaying(nowPlaying: any) {
  if (typeof nowPlaying?.isNow === "boolean") return nowPlaying.isNow;

  const timestamp = getNowPlayingTimestamp(nowPlaying);
  if (!timestamp) return false;

  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) return false;

  return Date.now() - time < 5 * 60 * 1000;
}

function getNowPlayingKey(nowPlaying: any) {
  return (
    nowPlaying?.playbackKey ??
    nowPlaying?.streamId ??
    nowPlaying?.stream?.id ??
    nowPlaying?.id ??
    nowPlaying?.playedAt ??
    nowPlaying?.endTime ??
    null
  );
}

async function fetchSafe<T>(promise: Promise<T>) {
  try {
    return await promise;
  } catch (error: any) {
    return error;
  }
}

async function withTimeoutValue<T>(promise: Promise<T>, timeoutMs: number, fallback: T) {
  if (timeoutMs <= 0) return fallback;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveStatsUser(value: unknown) {
  const requested = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
  if (!requested) return null;

  const entry = Object.entries(USERS).find(([key, user]) =>
    key === requested || user.id === requested
  );
  return entry ? { key: String(entry[0]), id: entry[1].id } : null;
}

async function getFeaturedStats(
  statsUser: { key: string; id: string } | null,
  generatedAt: string,
  deadline: number
) {
  if (!statsUser) return null;

  const after = getStartOfTodaySPMs();
  const requestTimeoutMs = Math.min(
    LIVE_STATS_REQUEST_TIMEOUT_MS,
    Math.max(250, deadline - Date.now())
  );
  if (requestTimeoutMs <= 250 && Date.now() >= deadline) return null;

  const result = await fetchSafe(fetchUserStatsRange(statsUser.id, after, null, {
    force: false,
    aggregateMode: "none",
    cacheProfile: "live",
    requestTimeoutMs,
    maxRetries: 0,
  }));

  if (!result || typeof result !== "object" || !("ok" in result) || !result.ok) {
    return null;
  }

  return {
    userId: statsUser.id,
    day: getDayKey(new Date(after)),
    streams: getCount(result.data),
    durationMs: getDurationMs(result.data),
    generatedAt,
  };
}

async function getLiveUserBundle(
  key: string,
  user: { id: string; platform?: string },
  force: boolean,
  debug: boolean,
  includeProfile: boolean,
  deadline: number
) {
  const upstreamForce = false;
  const requestTimeoutMs = Math.min(
    LIVE_USER_REQUEST_TIMEOUT_MS,
    Math.max(250, deadline - Date.now())
  );

  const [profileResult, recentResult] = await Promise.all([
    includeProfile
      ? fetchSafe(statsfmFetch(`/users/${user.id}`, {
          force: upstreamForce,
          cacheProfile: "live",
          requestTimeoutMs,
          maxRetries: 0,
        }))
      : Promise.resolve({ ok: true, status: 200, endpoint: null, data: { item: null } }),
    fetchSafe(fetchUserRecentStreams(user.id, { limit: 1 }, {
      force: upstreamForce,
      cacheProfile: "live",
      requestTimeoutMs,
      maxRetries: 0,
    })),
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
  const recentItems = Array.isArray(recentData?.items) ? recentData.items.slice(0, 1) : [];

  // Enrich recent item with correct album using track stream evidence
  // Fallback to original items if enrichment fails (resilient)
  let enrichedItems = recentItems;
  let enrichmentWarning: string | null = null;

  if (recentItems.length > 0) {
    const needsTrackStreamEvidence = recentItems.some((item: any) => item?.albumId == null);

    try {
      const enrichmentBudgetMs = Math.min(
        LIVE_ENRICHMENT_BUDGET_MS,
        Math.max(0, deadline - Date.now() - 100)
      );
      enrichedItems = await withTimeoutValue(
        enrichTrackItemsWithAlbumOwners(recentItems, {
          force: upstreamForce,
          userId: user.id,
          // Keep direct stream album evidence, but never let optional detail work block live.
          useTrackStreamEvidence: needsTrackStreamEvidence,
          trackStreamEvidenceStrategy: needsTrackStreamEvidence ? "latest" : undefined,
          cacheProfile: "live",
          requestTimeoutMs: enrichmentBudgetMs,
        }),
        enrichmentBudgetMs,
        recentItems
      );
      if (enrichmentBudgetMs === 0 || (needsTrackStreamEvidence && enrichedItems === recentItems)) {
        enrichmentWarning = "album_enrichment_deferred";
      }
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
          isNow: isRecentNowPlaying(nowPlayingRaw),
          timestamp: getNowPlayingTimestamp(nowPlayingRaw),
          playbackKey: getNowPlayingKey(nowPlayingRaw),
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
  const includeProfile = req.query.profile !== "0";
  const statsUser = resolveStatsUser(req.query.statsUser);
  const users = Object.entries(USERS) as Array<[keyof typeof USERS, { id: string; platform?: string }]>;
  const deadline = Date.now() + LIVE_ENDPOINT_DEADLINE_MS;
  const generatedAt = new Date().toISOString();

  try {
    const featuredStatsPromise = getFeaturedStats(statsUser, generatedAt, deadline);
    const settled = new Array<PromiseSettledResult<Awaited<ReturnType<typeof getLiveUserBundle>>> | undefined>(users.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < users.length && Date.now() < deadline) {
        const index = cursor++;
        const [key, user] = users[index];
        try {
          settled[index] = {
            status: "fulfilled",
            value: await getLiveUserBundle(String(key), user, force, debug, includeProfile, deadline),
          };
        } catch (reason) {
          settled[index] = { status: "rejected", reason };
        }
      }
    };
    const workers = Array.from({ length: Math.min(users.length, 5) }, worker);
    await withTimeoutValue(Promise.all(workers), Math.max(0, deadline - Date.now()), []);
    const featuredStats = await withTimeoutValue(
      featuredStatsPromise,
      Math.max(0, deadline - Date.now()),
      null
    );

    const members = users.map((_, index) => {
      const result = settled[index];
      if (result?.status === "fulfilled") return result.value;

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
        warnings: ["live_deadline_exceeded"],
        error: result?.status === "rejected" ? String(result.reason) : "deadline_exceeded",
      };
    });

    setCacheHeaders(res, 5, debug, 15);

    return res.status(200).json({
      ok: true,
      source: "stats.fm-api",
      generatedAt,
      members,
      ...(featuredStats ? { featuredStats } : {}),
    });
  } catch (error: any) {
    return sendJsonError(res, 503, "group_live_failed", {
      message: error?.message ?? String(error),
    });
  }
}
