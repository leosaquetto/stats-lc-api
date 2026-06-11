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
  lyrics?: string | null;
  writers?: string[];
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

function canonicalTitleComparableText(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/[\(\)\[\]]/g, " ")
        .replace(/\b(feat|ft|with|prod)\.?\b.*$/i, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
    : "";
}

function stripLyricsTitleVersion(value: unknown) {
  if (typeof value !== "string") return value;

  return value
    .replace(
      /\s+[-–—]\s+(?:(?:\d{4}\s+)?remaster(?:ed)?(?:\s+version)?|remaster(?:ed)?(?:\s+\d{4})?)\s*$/i,
      ""
    )
    .trim();
}

function stripLyricsSearchSuffix(value: string) {
  return String(stripLyricsTitleVersion(value))
    .replace(/\s*[\(\[]\s*(?:feat|ft|with|from)\.?\b[\s\S]*[\)\]]\s*$/i, "")
    .replace(/\s+(?:feat|ft|with)\.?\b.*$/i, "")
    .trim();
}

function canonicalTitleText(value: unknown) {
  return canonicalText(stripLyricsTitleVersion(value));
}

function canonicalTitleComparable(value: unknown) {
  return canonicalTitleComparableText(stripLyricsTitleVersion(value));
}

function cacheKey(title: string, artist: string | null, includeLyrics: boolean, includeWriters: boolean) {
  return `${canonicalTitleText(title)}|${canonicalText(artist)}|lyrics=${includeLyrics ? "1" : "0"}|writers=${includeWriters ? "1" : "0"}`;
}

function includesText(value: string, candidate: string) {
  return Boolean(value && candidate && (value.includes(candidate) || candidate.includes(value)));
}

function scoreHit(hit: any, title: string, artist: string | null) {
  const result = hit?.result ?? hit;
  const titleNeedle = canonicalTitleText(title);
  const comparableTitleNeedle = canonicalTitleComparable(title);
  const artistNeedle = canonicalText(artist);
  const resultTitle = canonicalText(result?.title);
  const resultFullTitle = canonicalText(result?.full_title);
  const comparableResultTitle = canonicalTitleComparable(result?.title);
  const comparableResultFullTitle = canonicalTitleComparable(result?.full_title);
  const resultArtist = canonicalText(result?.primary_artist?.name);

  let score = 0;
  if (comparableTitleNeedle && comparableResultTitle === comparableTitleNeedle) score += 0.6;
  else if (titleNeedle && resultTitle === titleNeedle) score += 0.6;
  else if (includesText(comparableResultTitle, comparableTitleNeedle)) score += 0.48;
  else if (includesText(comparableResultFullTitle, comparableTitleNeedle)) score += 0.4;
  else if (includesText(resultTitle, titleNeedle)) score += 0.42;
  else if (includesText(resultFullTitle, titleNeedle)) score += 0.34;

  if (artistNeedle && resultArtist === artistNeedle) score += 0.35;
  else if (includesText(resultArtist, artistNeedle)) score += 0.24;
  else if (artistNeedle && includesText(resultFullTitle, artistNeedle)) score += 0.18;

  if (result?.lyrics_state === "complete") score += 0.05;

  return Math.min(1, score);
}

function searchTitleVariants(title: string) {
  const variants: string[] = [];
  const addVariant = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!variants.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) {
      variants.push(trimmed);
    }
  };

  addVariant(title);

  const dashMatch = String(stripLyricsTitleVersion(title)).match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (dashMatch) {
    addVariant(`${dashMatch[1].trim()} (${dashMatch[2].trim()})`);
  }

  addVariant(stripLyricsSearchSuffix(title));

  return variants;
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

function uniqueNames(names: string[]) {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    const key = canonicalText(trimmed);
    if (!key || seen.has(key)) continue;

    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

function extractArtistNames(value: any) {
  return uniqueNames(
    (Array.isArray(value) ? value : [])
      .map((artist: any) => typeof artist === "string" ? artist : artist?.name)
      .filter((name: any): name is string => typeof name === "string" && name.trim() !== "")
  );
}

function decodeHtml(value: string) {
  return value
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function htmlToText(value: string) {
  return decodeHtml(
    value
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|h[1-6])>/gi, "\n")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "")
  )
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripExcludedSelectionNodes(value: string) {
  let html = value;
  const excludedElementPattern =
    /<([a-z0-9-]+)\b[^>]*data-exclude-from-selection=["']true["'][^>]*>[\s\S]*?<\/\1>/gi;
  let previous = "";

  while (previous !== html) {
    previous = html;
    html = html.replace(excludedElementPattern, "");
  }

  return html.replace(/<[^>]+data-exclude-from-selection=["']true["'][^>]*\/?>/gi, "");
}

function extractLyricsFromHtml(html: string) {
  const rootMatch = html.match(/<div\b[^>]*id=["']lyrics-root["'][^>]*>([\s\S]*?)(?:<div\b[^>]*id=["']annotation_sidebar["']|<\/main>|<\/body>)/i);
  const searchArea = rootMatch?.[1] ?? html;
  const modernBlocks = [...searchArea.matchAll(/<div\b[^>]*data-lyrics-container=["']true["'][^>]*>([\s\S]*?)<\/div>/gi)]
    .map((match) => htmlToText(stripExcludedSelectionNodes(match[1])))
    .filter(Boolean);

  if (modernBlocks.length > 0) return modernBlocks.join("\n").trim();

  const legacyMatch = html.match(/<div\b[^>]*class=["'][^"']*\blyrics\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i);
  return legacyMatch ? htmlToText(stripExcludedSelectionNodes(legacyMatch[1])) : null;
}

function stripLyricsSectionTags(value: string) {
  const sectionPattern =
    /^(?:intro|outro|verse|chorus|hook|bridge|pre[- ]?chorus|post[- ]?chorus|refrain|interlude|instrumental|solo|spoken|skit|part|section|refr[aã]o|verso|ponte|coro)(?:\s+\d+)?(?:\s*\:.*)?$/i;

  const cleaned = value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return true;
      const match = line.match(/^\[([^\]]+)\]$/);
      if (!match) return true;

      const label = match[1].trim();
      return !sectionPattern.test(label);
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return cleaned;
}

async function fetchGeniusLyrics(url: string | null) {
  if (!url) return { lyrics: null, reason: "missing_url" };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        "User-Agent": "Mozilla/5.0 (compatible; stats.lc lyrics matcher; +https://statslc.leosaquetto.com)",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return { lyrics: null, reason: `lyrics_upstream_${response.status}` };
    }

    const html = await response.text();
    const lyrics = extractLyricsFromHtml(html);
    return lyrics
      ? { lyrics: stripLyricsSectionTags(lyrics), reason: null }
      : { lyrics: null, reason: "lyrics_not_found" };
  } catch (error: any) {
    return { lyrics: null, reason: error?.name === "AbortError" ? "lyrics_timeout" : "lyrics_request_failed" };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchGeniusWriters(songId: number | string | null, token: string) {
  if (songId == null || songId === "") return [];

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${GENIUS_API_BASE}/songs/${encodeURIComponent(String(songId))}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    if (!response.ok) return [];

    const data: any = await response.json();
    return extractArtistNames(data?.response?.song?.writer_artists);
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

export async function findGeniusLyricsMatch(
  title: string,
  artist: string | null,
  options: { includeLyrics?: boolean; includeWriters?: boolean } = {}
): Promise<GeniusLyricsMatch> {
  const includeLyrics = options.includeLyrics === true;
  const includeWriters = options.includeWriters === true || includeLyrics;
  const normalizedTitle = title.trim();
  const normalizedArtist = artist?.trim() || null;
  const key = cacheKey(normalizedTitle, normalizedArtist, includeLyrics, includeWriters);
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
    const search = async (searchTitle: string) => {
      const query = buildQuery({ q: [searchTitle, normalizedArtist].filter(Boolean).join(" ") });
      const response = await fetch(`${GENIUS_API_BASE}/search${query}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`upstream_${response.status}`);
      }

      const data: any = await response.json();
      return Array.isArray(data?.response?.hits) ? data.response.hits : [];
    };
    const rankHits = (hits: any[]) => hits
      .map((hit: any) => ({ hit, score: scoreHit(hit, normalizedTitle, normalizedArtist) }))
      .sort((a: any, b: any) => b.score - a.score);

    let hits: any[] = [];
    let winner: { hit: any; score: number } | undefined;

    for (const searchTitle of searchTitleVariants(normalizedTitle)) {
      const nextHits = await search(searchTitle);
      hits = [...hits, ...nextHits];
      winner = rankHits(hits)[0];
      if (winner && winner.score >= 0.72) break;
    }

    const result: GeniusLyricsMatch = winner && winner.score >= 0.72
      ? {
          ...baseResponse,
          hasLyrics: true,
          match: normalizeMatch(winner.hit, winner.score),
        }
      : {
          ...baseResponse,
          reason: hits.length > 0 ? "no_confident_match" : "not_found",
        };

    if ((includeLyrics || includeWriters) && result.match) {
      const [lyricsResult, writers] = await Promise.all([
        includeLyrics ? fetchGeniusLyrics(result.match.url) : Promise.resolve({ lyrics: null, reason: null }),
        fetchGeniusWriters(result.match.id, token),
      ]);
      if (includeLyrics) result.lyrics = lyricsResult.lyrics;
      if (writers.length > 0) result.writers = writers;
      if (includeLyrics && !lyricsResult.lyrics && lyricsResult.reason) result.reason = lyricsResult.reason;
    }

    cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, data: result });
    return result;
  } catch (error: any) {
    return {
      ...baseResponse,
      reason: error?.name === "AbortError"
        ? "timeout"
        : typeof error?.message === "string" && error.message.startsWith("upstream_")
          ? error.message
          : "request_failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}
