import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readQueryString, sendJsonError } from "../api-helpers.js";
import { normalizeRecentItem } from "../normalize.js";
import { fetchUserRecentStreams } from "../user-streams-service.js";
import { USERS } from "../users.js";

const PROBE_REQUEST_TIMEOUT_MS = 2500;

function resolveProbeUser(value: unknown) {
  const requested = readQueryString(value).trim();
  if (!requested) return null;

  const entry = Object.entries(USERS).find(([key, user]) =>
    key === requested || user.id === requested
  );
  return entry ? { key: entry[0], id: entry[1].id } : null;
}

function getProbeSignature(item: any) {
  if (!item) return null;
  const timestamp = item.playedAt ?? item.endTime ?? item.timestamp ?? "unknown-time";
  const trackId = item.track?.id ?? item.trackId ?? "unknown-track";
  const albumId = item.track?.albumId ?? item.track?.album?.id ?? "unknown-album";
  return `${timestamp}:${trackId}:${albumId}`;
}

function compactArtist(artist: any) {
  if (!artist) return null;
  return {
    id: artist.id ?? null,
    name: artist.name ?? null,
    image: artist.image ?? null,
  };
}

function toProbeItem(item: any) {
  const track = item?.track;
  if (!item || !track) return null;

  const artists = Array.isArray(track.artists)
    ? track.artists.map(compactArtist).filter(Boolean)
    : [];
  const primaryArtist = compactArtist(track.primaryArtist ?? artists[0]);
  const album = track.album
    ? {
        id: track.album.id ?? null,
        name: track.album.name ?? null,
        image: track.album.image ?? track.albumImage ?? track.image ?? null,
      }
    : null;

  return {
    id: item.id ?? null,
    playedAt: item.playedAt ?? item.endTime ?? null,
    endTime: item.endTime ?? item.playedAt ?? null,
    playedMs: item.playedMs ?? null,
    durationMs: item.durationMs ?? track.durationMs ?? null,
    trackId: item.trackId ?? track.id ?? null,
    trackName: item.trackName ?? track.name ?? null,
    platform: item.platform ?? "unknown",
    track: {
      id: track.id ?? null,
      name: track.name ?? null,
      durationMs: track.durationMs ?? item.durationMs ?? null,
      image: track.albumImage ?? track.image ?? album?.image ?? null,
      artists,
      primaryArtist,
      primaryArtistId: primaryArtist?.id ?? track.primaryArtistId ?? null,
      primaryArtistName: primaryArtist?.name ?? track.primaryArtistName ?? null,
      album,
      albumId: track.albumId ?? album?.id ?? null,
      albumName: track.albumName ?? album?.name ?? null,
      albumImage: track.albumImage ?? album?.image ?? track.image ?? null,
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    return sendJsonError(res, 405, "method_not_allowed");
  }

  const user = resolveProbeUser(req.query.user);
  if (!user) {
    return sendJsonError(res, 400, "invalid_user");
  }

  const result = await fetchUserRecentStreams(user.id, { limit: 1 }, {
    force: false,
    aggregateMode: "none",
    cacheProfile: "pulse",
    requestTimeoutMs: PROBE_REQUEST_TIMEOUT_MS,
    maxRetries: 0,
  });

  if (!result.ok) {
    return sendJsonError(res, result.status || 503, "live_probe_upstream_failed");
  }

  const data = result.data as any;
  const rawItem = Array.isArray(data?.items) ? data.items[0] : null;
  const normalizedItem = rawItem ? normalizeRecentItem(rawItem) : null;
  const item = toProbeItem(normalizedItem);

  res.setHeader("Cache-Control", "public, s-maxage=3, stale-if-error=45");
  return res.status(200).json({
    ok: true,
    user: user.key,
    userId: user.id,
    generatedAt: new Date().toISOString(),
    signature: getProbeSignature(item),
    item,
  });
}
