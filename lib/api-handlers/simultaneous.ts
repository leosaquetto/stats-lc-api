import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  getItems,
  mapWithConcurrency,
  readOptionalQueryString,
  readQueryString,
  sendJsonError,
  setCacheHeaders,
  setCorsHeaders,
} from "../api-helpers.js";
import { normalizeRecentItem } from "../normalize.js";
import { fetchUserStreams } from "../user-streams-service.js";
import { getUsersList, resolveUserId } from "../users.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_GAP_MINUTES = 10;
const DEFAULT_LIMIT = 12;
const DEFAULT_PER_USER_LIMIT = 1000;

function readNumber(value: unknown, fallback: number) {
  const raw = readOptionalQueryString(value);
  const parsed = raw == null ? fallback : Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function normalizeText(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function readUsers(value: unknown) {
  const requested = readQueryString(value)
    .split(",")
    .map((user) => user.trim())
    .filter(Boolean);
  const users = requested.length > 0 ? requested : getUsersList().map((user) => user.key);
  return [...new Set(users)].slice(0, 10);
}

function getExternalIds(value: any) {
  const externalIds = value?.externalIds ?? {};
  return [
    ...(Array.isArray(externalIds.spotify) ? externalIds.spotify : []),
    ...(Array.isArray(externalIds.appleMusic) ? externalIds.appleMusic : []),
  ].filter(Boolean).map(String);
}

function getArtist(track: any) {
  const first = Array.isArray(track?.artists) ? track.artists[0] : null;
  return track?.primaryArtist ?? track?.artist ?? first ?? null;
}

function getArtistName(track: any) {
  const artist = getArtist(track);
  return typeof artist === "string"
    ? artist
    : artist?.name ?? track?.primaryArtistName ?? track?.artistName ?? "";
}

function getTrackKeys(track: any) {
  const keys = new Set<string>();
  if (track?.id != null) keys.add(`id:${String(track.id)}`);
  for (const id of getExternalIds(track)) keys.add(`external:${id}`);

  const name = normalizeText(track?.name);
  const artist = normalizeText(getArtistName(track));
  if (name) keys.add(`name:${name}:${artist}`);
  return keys;
}

function getArtistKeys(track: any) {
  const keys = new Set<string>();
  const artist = getArtist(track);
  if (artist && typeof artist !== "string" && artist.id != null) keys.add(`id:${String(artist.id)}`);
  for (const id of getExternalIds(artist)) keys.add(`external:${id}`);

  const name = normalizeText(getArtistName(track));
  if (name) keys.add(`name:${name}`);
  return keys;
}

function sharedKey(left: Set<string>, right: Set<string>) {
  for (const key of left) {
    if (right.has(key)) return key;
  }
  return null;
}

function readTimestamp(item: any) {
  const raw = item?.playedAt ?? item?.endTime ?? item?.timestamp;
  const timestamp = raw ? new Date(raw).getTime() : 0;
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function compactTrack(track: any) {
  return {
    id: track?.id ?? null,
    name: track?.name ?? null,
    artistName: getArtistName(track) || null,
    image: track?.albumImage ?? track?.album?.image ?? track?.image ?? null,
    externalIds: track?.externalIds ?? { spotify: [], appleMusic: [] },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const users = readUsers(req.query.users);
  const before = readNumber(req.query.before, Date.now());
  const after = readNumber(req.query.after, before - 7 * DAY_MS);
  const gapMinutes = clamp(readNumber(req.query.gapMinutes, DEFAULT_GAP_MINUTES), 1, 30);
  const limit = clamp(readNumber(req.query.limit, DEFAULT_LIMIT), 1, 50);
  const perUserLimit = clamp(readNumber(req.query.perUserLimit, DEFAULT_PER_USER_LIMIT), 50, 2000);

  if (users.length < 2) {
    return sendJsonError(res, 400, "at_least_two_users_required");
  }
  if (after >= before) {
    return sendJsonError(res, 400, "invalid_range");
  }

  try {
    const pages = await mapWithConcurrency(users, 3, async (user) => {
      const userId = resolveUserId(user);
      const result = await fetchUserStreams(userId, {
        after,
        before,
        limit: perUserLimit,
        offset: 0,
      }, {
        force: false,
        cacheProfile: "heavy",
      });
      return { user, userId, result };
    });

    const failures: Array<{ user: string; status: number }> = [];
    const fetchedByUser: Record<string, number> = {};
    const events = pages.flatMap((page) => {
      if (page.status !== "fulfilled" || !page.value.result.ok) {
        const user = page.status === "fulfilled" ? page.value.user : "unknown";
        const status = page.status === "fulfilled" ? page.value.result.status : 503;
        failures.push({ user, status });
        return [];
      }

      const { user, userId, result } = page.value;
      const items = getItems(result.data).map(normalizeRecentItem);
      fetchedByUser[user] = items.length;
      return items.flatMap((item: any) => {
        const track = item?.track;
        const timestamp = readTimestamp(item);
        const trackKeys = getTrackKeys(track);
        const artistKeys = getArtistKeys(track);
        if (!track || !timestamp || trackKeys.size === 0) return [];
        return [{
          user,
          userId,
          playedAt: item.playedAt ?? item.endTime,
          timestamp,
          track,
          trackKeys,
          artistKeys,
        }];
      });
    }).sort((left, right) => left.timestamp - right.timestamp);

    const gapMs = gapMinutes * 60 * 1000;
    const emitted = new Set<string>();
    const matches: any[] = [];

    for (let leftIndex = 0; leftIndex < events.length; leftIndex += 1) {
      const left = events[leftIndex];
      for (let rightIndex = leftIndex + 1; rightIndex < events.length; rightIndex += 1) {
        const right = events[rightIndex];
        const differenceMs = right.timestamp - left.timestamp;
        if (differenceMs > gapMs) break;
        if (left.userId === right.userId) continue;

        const trackKey = sharedKey(left.trackKeys, right.trackKeys);
        const artistKey = trackKey ? null : sharedKey(left.artistKeys, right.artistKeys);
        if (!trackKey && !artistKey) continue;

        const matchType = trackKey ? "track" : "artist";
        const pairKey = [left.userId, right.userId].sort().join(":");
        const identity = trackKey ?? artistKey;
        const uniqueKey = `${pairKey}:${matchType}:${identity}`;
        if (emitted.has(uniqueKey)) continue;
        emitted.add(uniqueKey);

        matches.push({
          matchType,
          gapMinutes: Math.round(differenceMs / 60000),
          users: [
            { key: left.user, id: left.userId, playedAt: left.playedAt },
            { key: right.user, id: right.userId, playedAt: right.playedAt },
          ],
          track: matchType === "track" ? compactTrack(left.track) : null,
          artist: {
            name: getArtistName(left.track) || getArtistName(right.track) || null,
          },
          tracks: [compactTrack(left.track), compactTrack(right.track)],
        });
      }
    }

    matches.sort((left, right) => {
      const leftTime = Math.max(...left.users.map((user: any) => new Date(user.playedAt).getTime()));
      const rightTime = Math.max(...right.users.map((user: any) => new Date(user.playedAt).getTime()));
      return rightTime - leftTime || left.gapMinutes - right.gapMinutes;
    });

    setCorsHeaders(res);
    setCacheHeaders(res, 120, false, 900);
    return res.status(200).json({
      ok: true,
      after,
      before,
      gapMinutes,
      items: matches.slice(0, limit),
      coverage: {
        source: "user_streams",
        requestedUsers: users.length,
        successfulUsers: users.length - failures.length,
        fetchedByUser,
        perUserLimit,
        partial: failures.length > 0 || Object.values(fetchedByUser).some((count) => count >= perUserLimit),
        failures,
      },
    });
  } catch (error: any) {
    return sendJsonError(res, 503, "simultaneous_failed", {
      message: error?.message ?? String(error),
    });
  }
}
