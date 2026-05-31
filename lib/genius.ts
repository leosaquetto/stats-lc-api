import { buildQuery } from "./api-helpers.js";

const GENIUS_API_BASE = "https://api.genius.com";
const REQUEST_TIMEOUT_MS = 5_000;
const CACHE_TTL_MS = 12 * 60 * 60_000;
const cache = new Map<string, { expiresAt: number; data: GeniusLyricsMatch }>();

export type GeniusLyricsMatch = {
  ok: true;
  hasLyrics: boolean;
  source: "genius";
  reason?: string;
  query: {
    title: string;
    artist: string | null;
  };
  match: null | {
    id: number | string | null;
    title: string | null;
    artist: string | null;
    url: string | null;
    path: string | null;
    thumbnail: string | null;
    confidence: "high" | "medium";
    score: number;
  };
};

function readAccessToken() {
  return process.env.GENIUS_ACCESS_TOKEN || process.env.GENIUS_CLIENT_ACCESS_TOKEN || "";
}

function canonicalText(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/\b(feat|ft|with|prod)\.?\b.*$/i, "")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
    : "";
}

function cacheKey(title: string, artist: string | null) {
  return `${canonicalText(title)}|${canonicalText(artist)}`;
}

function includesText(value: string, candidate: string) {
  return Boolean(value && candidate && (value.includes(candidate) || candidate.includes(value)));
}

function scoreHit(hit: any, title: string, artist: string | null) {
  const result = hit?.result ?? hit;
  const titleNeedle = canonicalText(title);
  const artistNeedle = canonicalText(artist);
  const resultTitle = canonicalText(result?.title);
  const resultFullTitle = canonicalText(result?.full_title);
  const resultArtist = canonicalText(result?.primary_artist?.name);

  let score = 0;
  if (titleNeedle && resultTitle === titleNeedle) score += 0.6;
  else if (includesText(resultTitle, titleNeedle)) score += 0.42;
  else if (includesText(resultFullTitle, titleNeedle)) score += 0.34;

  if (artistNeedle && resultArtist === artistNeedle) score += 0.35;
  else if (includesText(resultArtist, artistNeedle)) score += 0.24;
  else if (artistNeedle && includesText(resultFullTitle, artistNeedle)) score += 0.18;

  if (result?.lyrics_state === "complete") score += 0.05;

  return Math.min(1, score);
}

function normalizeMatch(hit: any, score: number) {
  const result = hit?.result ?? hit;
  return {
    id: result?.id ?? null,
    title: result?.title ?? null,
    artist: result?.primary_artist?.name ?? null,
    url: result?.url ?? null,
    path: result?.path ?? null,
    thumbnail: result?.song_art_image_thumbnail_url ?? result?.header_image_thumbnail_url ?? null,
    confidence: score >= 0.88 ? "high" as const : "medium" as const,
    score: Number(score.toFixed(3)),
  };
}

export async function findGeniusLyricsMatch(title: string, artist: string | null): Promise<GeniusLyricsMatch> {
  const normalizedTitle = title.trim();
  const normalizedArtist = artist?.trim() || null;
  const key = cacheKey(normalizedTitle, normalizedArtist);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.data;

  const baseResponse: GeniusLyricsMatch = {
    ok: true,
    hasLyrics: false,
    source: "genius",
    query: {
      title: normalizedTitle,
      artist: normalizedArtist,
    },
    match: null,
  };

  const token = readAccessToken();
  if (!token) {
    return { ...baseResponse, reason: "not_configured" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const query = buildQuery({ q: [normalizedTitle, normalizedArtist].filter(Boolean).join(" ") });
    const response = await fetch(`${GENIUS_API_BASE}/search${query}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { ...baseResponse, reason: `upstream_${response.status}` };
    }

    const data: any = await response.json();
    const hits = Array.isArray(data?.response?.hits) ? data.response.hits : [];
    const ranked = hits
      .map((hit: any) => ({ hit, score: scoreHit(hit, normalizedTitle, normalizedArtist) }))
      .sort((a: any, b: any) => b.score - a.score);
    const winner = ranked[0];

    const result = winner && winner.score >= 0.72
      ? {
          ...baseResponse,
          hasLyrics: true,
          match: normalizeMatch(winner.hit, winner.score),
        }
      : {
          ...baseResponse,
          reason: hits.length > 0 ? "no_confident_match" : "not_found",
        };

    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data: result });
    return result;
  } catch (error: any) {
    return { ...baseResponse, reason: error?.name === "AbortError" ? "timeout" : "request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}
