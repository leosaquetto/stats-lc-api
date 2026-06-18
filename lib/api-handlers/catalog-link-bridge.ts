import type { VercelRequest, VercelResponse } from "@vercel/node";
import { timingSafeEqual } from "node:crypto";
import {
  buildQuery,
  encodeSegment,
  getItem,
  getItems,
  readOptionalQueryString,
  readQueryString,
  setCacheHeaders,
} from "../api-helpers.js";
import { normalizeTrack } from "../normalize.js";
import { statsfmFetch } from "../statsfm.js";
import { enrichTrackItemsWithAlbumOwners } from "../track-album-enrichment.js";

const MIN_ACCEPTED_SCORE = 68;
const MAX_SEARCH_RESULTS = 8;

type BridgeTarget = {
  statsfmTrackId: string;
  spotifyId: string;
  appleMusicId: string;
  isrc: string;
  title: string;
  artist: string;
  durationMs: number;
  query: string;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "GET") {
    setCacheHeaders(res, 0, true);
    return res.status(405).json({ ok: false, error: "method_not_allowed" });
  }

  if (!hasBridgeAccess(req)) {
    setCacheHeaders(res, 0, true);
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const target = readBridgeTarget(req);
  if (!target.statsfmTrackId && !target.spotifyId && !target.appleMusicId && !target.query) {
    setCacheHeaders(res, 0, true);
    return res.status(400).json({ ok: false, error: "missing_lookup_context" });
  }

  const force = req.query.force === "1";
  const candidates = await findBridgeCandidates(target, force);
  const scored = candidates
    .map((track, index) => ({
      track,
      index,
      score: scoreBridgeCandidate(target, track, index),
    }))
    .sort((left, right) => right.score - left.score);

  const best = scored[0];
  const bestLinks = best?.track ? buildBridgeLinks(best.track) : [];
  const accepted = Boolean(best && best.score >= MIN_ACCEPTED_SCORE && bestLinks.length);
  const track = accepted ? best.track : null;
  const links = accepted ? bestLinks : [];

  setCacheHeaders(res, accepted ? 900 : 120, force);
  return res.status(200).json({
    ok: true,
    matched: accepted,
    source: "statslc_bridge",
    score: best?.score ?? 0,
    links,
    track: track
      ? {
          id: track.id,
          title: track.name,
          artist: track.primaryArtistName,
          durationMs: track.durationMs,
          spotifyId: track.spotifyId,
          appleMusicId: track.appleMusicId,
          externalIds: track.externalIds,
        }
      : null,
  });
}

function readBridgeTarget(req: VercelRequest): BridgeTarget {
  const title = readQueryString(req.query.title).trim();
  const artist = readQueryString(req.query.artist).trim();
  const query = readQueryString(req.query.q || req.query.query).trim() ||
    [artist, title].filter(Boolean).join(" ").trim();

  return {
    statsfmTrackId: readQueryString(req.query.statsfmTrackId || req.query.trackId).trim(),
    spotifyId: normalizeSpotifyId(readQueryString(req.query.spotifyId).trim()),
    appleMusicId: normalizeNumericId(readQueryString(req.query.appleMusicId).trim()),
    isrc: normalizeIsrc(readQueryString(req.query.isrc).trim()),
    title,
    artist,
    durationMs: Number(readOptionalQueryString(req.query.durationMs)) || 0,
    query,
  };
}

async function findBridgeCandidates(target: BridgeTarget, force: boolean) {
  const candidates: any[] = [];

  if (target.statsfmTrackId) {
    const byId = await fetchTrackByStatsfmId(target.statsfmTrackId, force);
    if (byId) candidates.push(byId);
  }

  if (target.query) {
    const query = buildQuery({
      query: target.query,
      type: "track",
      limit: MAX_SEARCH_RESULTS,
    });
    const result = await statsfmFetch(`/search${query}`, {
      force,
      cacheProfile: "heavy",
      requestTimeoutMs: 3500,
      maxRetries: 0,
    });

    if (result.ok) {
      const tracks = getItems(result.data)
        .map((item: any) => item?.track ?? item?.item ?? item)
        .filter(Boolean);
      if (tracks.length) {
        const enriched = await enrichTrackItemsWithAlbumOwners(tracks, { force });
        candidates.push(...enriched.map(normalizeTrack));
      }
    }
  }

  return dedupeTracks(candidates.map(normalizeTrack));
}

async function fetchTrackByStatsfmId(id: string, force: boolean) {
  const result = await statsfmFetch(`/tracks/${encodeSegment(id)}`, {
    force,
    cacheProfile: "heavy",
    requestTimeoutMs: 3500,
    maxRetries: 0,
  });
  if (!result.ok) return null;

  const entity = getItem(result.data);
  if (!entity) return null;

  const [enriched] = await enrichTrackItemsWithAlbumOwners([entity], { force });
  return normalizeTrack(enriched);
}

function buildBridgeLinks(track: any) {
  const links = [];
  const spotifyId = normalizeSpotifyId(track?.spotifyId || track?.externalIds?.spotify?.[0]);
  const appleMusicId = normalizeNumericId(track?.appleMusicId || track?.externalIds?.appleMusic?.[0]);

  if (spotifyId) {
    links.push({
      type: "spotify",
      id: spotifyId,
      url: `https://open.spotify.com/track/${spotifyId}`,
      isVerified: true,
      source: "statslc_bridge",
    });
  }

  if (appleMusicId) {
    links.push({
      type: "appleMusic",
      id: appleMusicId,
      url: `https://music.apple.com/song/${appleMusicId}`,
      isVerified: true,
      source: "statslc_bridge",
    });
  }

  return links;
}

function scoreBridgeCandidate(target: BridgeTarget, track: any, index: number) {
  let score = Math.max(0, 8 - index);
  const spotifyIds = new Set([
    normalizeSpotifyId(track?.spotifyId),
    ...(Array.isArray(track?.externalIds?.spotify) ? track.externalIds.spotify.map(normalizeSpotifyId) : []),
  ].filter(Boolean));
  const appleMusicIds = new Set([
    normalizeNumericId(track?.appleMusicId),
    ...(Array.isArray(track?.externalIds?.appleMusic) ? track.externalIds.appleMusic.map(normalizeNumericId) : []),
  ].filter(Boolean));
  const isrcs = new Set(
    (Array.isArray(track?.externalIds?.isrc) ? track.externalIds.isrc : [])
      .map(normalizeIsrc)
      .filter(Boolean)
  );

  if (target.spotifyId && spotifyIds.has(target.spotifyId)) score += 90;
  if (target.appleMusicId && appleMusicIds.has(target.appleMusicId)) score += 90;
  if (target.isrc && isrcs.has(target.isrc)) score += 70;
  if (target.statsfmTrackId && String(track?.id || "") === target.statsfmTrackId) score += 90;

  score += scoreText(target.title, track?.name, 34, 12);
  score += scoreText(target.artist, [
    track?.primaryArtistName,
    ...(Array.isArray(track?.artists) ? track.artists.map((artist: any) => artist?.name) : []),
  ].filter(Boolean).join(" "), 28, 10);

  const targetDuration = Number(target.durationMs || 0) || 0;
  const candidateDuration = Number(track?.durationMs || 0) || 0;
  if (targetDuration > 0 && candidateDuration > 0) {
    const diff = Math.abs(targetDuration - candidateDuration);
    if (diff <= 2500) score += 16;
    else if (diff <= 7000) score += 8;
    else if (diff > 15000) score -= 18;
  }

  if (!spotifyIds.size && !appleMusicIds.size) score -= 30;
  return Math.max(0, Math.min(100, Math.round(score)));
}

function scoreText(target: string, candidate: string, fullPoints: number, partialPoints: number) {
  const targetTokens = tokenize(target);
  const candidateText = normalizeText(candidate);
  if (!targetTokens.length || !candidateText) return 0;

  const matches = targetTokens.filter((token) => candidateText.includes(token)).length;
  const ratio = matches / targetTokens.length;
  if (ratio >= 0.85) return fullPoints;
  if (ratio >= 0.5) return partialPoints;
  return -partialPoints;
}

function dedupeTracks(tracks: any[]) {
  const seen = new Set<string>();
  const out = [];
  for (const track of tracks) {
    const key = [
      track?.id && `id:${track.id}`,
      track?.spotifyId && `spotify:${track.spotifyId}`,
      track?.appleMusicId && `apple:${track.appleMusicId}`,
      track?.name && `name:${normalizeText(track.name)}:${normalizeText(track.primaryArtistName)}`,
    ].find(Boolean);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

function hasBridgeAccess(req: VercelRequest) {
  const expected = String(process.env.CATALOG_LINK_BRIDGE_TOKEN || "").trim();
  if (!expected) return true;

  const auth = String(req.headers.authorization || "");
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1] || "";
  const header = Array.isArray(req.headers["x-bridge-token"])
    ? req.headers["x-bridge-token"][0]
    : req.headers["x-bridge-token"];
  return safeEqual(expected, bearer || String(header || ""));
}

function safeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) return false;
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function normalizeSpotifyId(value: unknown) {
  const id = String(value || "").trim();
  return /^[A-Za-z0-9]{22}$/.test(id) ? id : "";
}

function normalizeNumericId(value: unknown) {
  const id = String(value || "").trim();
  return /^\d{5,}$/.test(id) ? id : "";
}

function normalizeIsrc(value: unknown) {
  return String(value || "").replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

function normalizeText(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokenize(value: unknown) {
  const stopWords = new Set(["a", "as", "o", "os", "the", "of", "de", "da", "do", "and", "feat", "featuring", "ft"]);
  return normalizeText(value)
    .split(" ")
    .filter(Boolean)
    .filter((token) => !stopWords.has(token));
}
