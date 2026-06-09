import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readQueryString, setCacheHeaders } from "../api-helpers.js";
import { normalizeRecentItem } from "../normalize.js";
import { fetchUserEntityStreams, fetchUserRecentStreams } from "../user-streams-service.js";
import { resolveUserId } from "../users.js";

const PAGE_SIZE = 30;
const MAX_PAGES = 4;
const CONCURRENCY = 3;
const DEADLINE_MS = 5200;

function readTimestamp(item: any) {
  const raw = item?.playedAt ?? item?.endTime ?? item?.timestamp;
  const timestamp = raw ? new Date(raw).getTime() : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}

function getTrackId(item: any) {
  const value = item?.track?.id ?? item?.trackId;
  return value == null || value === "" ? null : String(value);
}

async function getFirstPlayedAt(
  userId: string,
  trackId: string,
  deadline: number
) {
  if (Date.now() >= deadline) return { complete: false, firstPlayedAt: null as string | null };

  const result = await fetchUserEntityStreams(
    userId,
    "tracks",
    trackId,
    { limit: 1, order: "asc" },
    {
      force: false,
      cacheProfile: "default",
      requestTimeoutMs: Math.max(250, Math.min(900, deadline - Date.now())),
      maxRetries: 0,
    }
  );

  if (!result.ok) return { complete: false, firstPlayedAt: null as string | null };
  const rawItem = Array.isArray((result.data as any)?.items) ? (result.data as any).items[0] : null;
  const firstPlayedAt = rawItem?.endTime ?? rawItem?.playedAt ?? null;
  return { complete: true, firstPlayedAt };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = readQueryString(req.query.user);
  if (!user) {
    return res.status(400).json({ ok: false, error: "missing_user" });
  }

  const userId = resolveUserId(user);
  const deadline = Date.now() + DEADLINE_MS;
  const seenTrackIds = new Set<string>();
  let best: { item: any; firstPlayedAt: string; timestamp: number } | null = null;
  let checkedTracks = 0;
  let fetchedPages = 0;
  let complete = false;
  let hasFailures = false;

  for (let page = 0; page < MAX_PAGES && Date.now() < deadline; page += 1) {
    const recentResult = await fetchUserRecentStreams(
      userId,
      { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
      {
        force: false,
        cacheProfile: "default",
        requestTimeoutMs: Math.max(300, Math.min(1100, deadline - Date.now())),
        maxRetries: 0,
      }
    );

    if (!recentResult.ok) break;
    fetchedPages += 1;

    const recentItems = Array.isArray((recentResult.data as any)?.items)
      ? (recentResult.data as any).items.map(normalizeRecentItem)
      : [];
    const candidates = recentItems
      .map((item: any) => ({ item, trackId: getTrackId(item), timestamp: readTimestamp(item) }))
      .filter((candidate: any) => candidate.trackId && candidate.timestamp != null)
      .filter((candidate: any) => {
        if (seenTrackIds.has(candidate.trackId)) return false;
        seenTrackIds.add(candidate.trackId);
        return true;
      })
      .sort((a: any, b: any) => b.timestamp - a.timestamp);

    for (let index = 0; index < candidates.length && Date.now() < deadline; index += CONCURRENCY) {
      const batch = candidates.slice(index, index + CONCURRENCY);
      const results = await Promise.all(
        batch.map(async (candidate: any) => ({
          candidate,
          result: await getFirstPlayedAt(userId, candidate.trackId, deadline),
        }))
      );

      for (const { candidate, result } of results) {
        if (!result.complete) {
          hasFailures = true;
          continue;
        }
        checkedTracks += 1;
        const firstTimestamp = result.firstPlayedAt
          ? new Date(result.firstPlayedAt).getTime()
          : Number.NaN;
        if (!Number.isFinite(firstTimestamp)) continue;
        if (!best || firstTimestamp > best.timestamp) {
          best = {
            item: candidate.item,
            firstPlayedAt: result.firstPlayedAt!,
            timestamp: firstTimestamp,
          };
        }
      }

      const nextCandidateTimestamp = candidates[index + CONCURRENCY]?.timestamp;
      if (
        !hasFailures &&
        best &&
        (nextCandidateTimestamp == null || best.timestamp >= nextCandidateTimestamp)
      ) {
        complete = true;
        break;
      }
    }

    if (complete) break;
    if (!hasFailures && recentItems.length < PAGE_SIZE) {
      complete = true;
      break;
    }
  }

  setCacheHeaders(res, 180, false, 1800);
  return res.status(200).json({
    ok: true,
    user,
    userId,
    item: complete && best ? best.item : null,
    firstPlayedAt: complete && best ? best.firstPlayedAt : null,
    coverage: {
      complete,
      fetchedPages,
      checkedTracks,
      maxPages: MAX_PAGES,
    },
  });
}
