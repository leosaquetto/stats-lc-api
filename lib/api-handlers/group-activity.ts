import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  encodeSegment,
  getItem,
  getItems,
  setCacheHeaders,
} from "../api-helpers.js";
import { normalizeRecentItem } from "../normalize.js";
import { statsfmFetch } from "../statsfm.js";
import { enrichTrackItemsWithAlbumOwners } from "../track-album-enrichment.js";
import { fetchUserStreams } from "../user-streams-service.js";
import { USERS } from "../users.js";

const GROUP_ACTIVITY_DEADLINE_MS = 6800;
const GROUP_ACTIVITY_REQUEST_TIMEOUT_MS = 2200;
const GROUP_ACTIVITY_CONCURRENCY = 3;

type GroupUser = {
  id: string;
  platform?: string;
};

function remainingRequestTimeout(deadline: number) {
  return Math.min(
    GROUP_ACTIVITY_REQUEST_TIMEOUT_MS,
    Math.max(250, deadline - Date.now())
  );
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

function hasUsableTrack(item: any) {
  return Boolean(item?.track && (item.track.id || item.track.name));
}

function mergeHydratedTrack(stream: any, track: any) {
  if (!track) return stream;

  const trackAlbums = Array.isArray(track.albums) ? track.albums : [];
  const streamAlbumId = stream?.albumId == null ? null : String(stream.albumId);
  const matchedAlbum = streamAlbumId
    ? trackAlbums.find((album: any) => String(album?.id ?? "") === streamAlbumId)
    : null;

  return {
    ...stream,
    track: {
      ...track,
      id: track.id ?? stream?.trackId ?? null,
      name: track.name ?? stream?.trackName ?? null,
      ...(matchedAlbum
        ? {
            album: matchedAlbum,
            albums: [matchedAlbum, ...trackAlbums.filter((album: any) => album !== matchedAlbum)],
          }
        : {}),
    },
  };
}

async function hydrateStreamTrack(stream: any, deadline: number) {
  if (!stream || hasUsableTrack(stream)) return stream;

  const trackId = stream?.trackId == null ? "" : String(stream.trackId);
  if (!trackId || Date.now() >= deadline) return stream;

  const result = await statsfmFetch(`/tracks/${encodeSegment(trackId)}`, {
    force: false,
    requestTimeoutMs: remainingRequestTimeout(deadline),
    maxRetries: 0,
  });

  if (!result.ok) return stream;
  return mergeHydratedTrack(stream, getItem(result.data) ?? result.data);
}

async function getMemberActivity(
  key: string,
  user: GroupUser,
  generatedAt: string,
  deadline: number
) {
  const warnings: string[] = [];
  if (Date.now() >= deadline) {
    return {
      key,
      userId: user.id,
      activity: null,
      generatedAt,
      warnings: ["group_activity_deadline_exceeded"],
    };
  }

  const streamsResult = await fetchUserStreams(user.id, { limit: 1 }, {
    force: false,
    requestTimeoutMs: remainingRequestTimeout(deadline),
    maxRetries: 0,
  });

  if (!streamsResult.ok) {
    return {
      key,
      userId: user.id,
      activity: null,
      generatedAt,
      warnings: ["streams_unavailable"],
    };
  }

  const rawStream = getItems(streamsResult.data)[0] ?? null;
  if (!rawStream) {
    return {
      key,
      userId: user.id,
      activity: null,
      generatedAt,
      warnings: ["no_streams"],
    };
  }

  let hydratedStream = rawStream;
  try {
    hydratedStream = await hydrateStreamTrack(rawStream, deadline);
    if (!hasUsableTrack(hydratedStream)) warnings.push("track_hydration_unavailable");
  } catch {
    warnings.push("track_hydration_failed");
  }

  let enrichedStream = hydratedStream;
  if (hasUsableTrack(hydratedStream) && Date.now() < deadline) {
    try {
      const enriched = await enrichTrackItemsWithAlbumOwners([hydratedStream], {
        force: false,
        userId: user.id,
        useTrackStreamEvidence: false,
        requestTimeoutMs: remainingRequestTimeout(deadline),
      });
      enrichedStream = enriched[0] ?? hydratedStream;
    } catch {
      warnings.push("album_enrichment_failed");
    }
  }

  const activity = normalizeRecentItem(enrichedStream);
  const normalizedActivity = activity?.track?.name
    ? {
        ...activity,
        isNow: false,
        timestamp: activity.playedAt ?? activity.endTime ?? null,
      }
    : null;

  if (!normalizedActivity && !warnings.includes("track_hydration_unavailable")) {
    warnings.push("activity_unavailable");
  }

  return {
    key,
    userId: user.id,
    activity: normalizedActivity,
    generatedAt,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

export default async function handler(_req: VercelRequest, res: VercelResponse) {
  const generatedAt = new Date().toISOString();
  const deadline = Date.now() + GROUP_ACTIVITY_DEADLINE_MS;
  const users = Object.entries(USERS) as Array<[string, GroupUser]>;
  const settled = new Array<PromiseSettledResult<Awaited<ReturnType<typeof getMemberActivity>>> | undefined>(users.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < users.length && Date.now() < deadline) {
      const index = cursor++;
      const [key, user] = users[index];
      try {
        settled[index] = {
          status: "fulfilled",
          value: await getMemberActivity(key, user, generatedAt, deadline),
        };
      } catch (reason) {
        settled[index] = { status: "rejected", reason };
      }
    }
  };

  const workers = Array.from(
    { length: Math.min(GROUP_ACTIVITY_CONCURRENCY, users.length) },
    worker
  );
  await withTimeoutValue(
    Promise.all(workers),
    Math.max(0, deadline - Date.now()),
    []
  );

  const members = users.map((_, index) => {
    const result = settled[index];
    if (result?.status === "fulfilled") return result.value;

    const [key, user] = users[index];
    return {
      key,
      userId: user.id,
      activity: null,
      generatedAt,
      warnings: [
        Date.now() >= deadline
          ? "group_activity_deadline_exceeded"
          : "group_activity_member_failed",
      ],
    };
  });

  setCacheHeaders(res, 180, false, 900);

  return res.status(200).json({
    ok: true,
    source: "stats.fm-api",
    generatedAt,
    members,
    partial: members.some((member) =>
      Array.isArray(member.warnings)
      && member.warnings.some((warning) => warning !== "no_streams")
    ),
  });
}
