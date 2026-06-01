import sharp from "sharp";

const colorCache = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();
const MAX_CACHE_SIZE = 500;
const FETCH_TIMEOUT_MS = 2200;

function normalizeColor(input: number[]) {
  const toHex = (value: number) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0");
  return `#${toHex(input[0])}${toHex(input[1])}${toHex(input[2])}`;
}

function cacheColor(url: string, color: string) {
  if (colorCache.size >= MAX_CACHE_SIZE) {
    const firstKey = colorCache.keys().next().value;
    if (firstKey) colorCache.delete(firstKey);
  }
  colorCache.set(url, color);
}

function getArtworkUrlFromTrack(track: any): string {
  return [
    track?.albumImage,
    track?.album?.image,
    track?.album?.images?.[0]?.url,
    track?.album?.images?.[0],
    track?.image,
    track?.images?.[0]?.url,
    track?.images?.[0],
    track?.albumArt,
    track?.coverArt,
    track?.cover_art,
    track?.album_image,
    track?.cover,
  ].find((url) => typeof url === "string" && url.trim().length > 5) || "";
}

function chooseAccentColor(data: Buffer) {
  const buckets = new Map<string, { r: number; g: number; b: number; score: number; count: number }>();
  let fallbackR = 0;
  let fallbackG = 0;
  let fallbackB = 0;
  let fallbackScore = 0;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha < 0.65) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const saturation = max === 0 ? 0 : (max - min) / max;
    const brightness = (r * 299 + g * 587 + b * 114) / 1000;

    if (brightness > 235 || brightness < 24 || saturation < 0.08) continue;

    const warmthBoost = r > b && r > g ? 1.18 : 1;
    const score = alpha * (0.7 + saturation * 1.8) * (brightness > 205 ? 0.72 : 1) * warmthBoost;
    const qR = Math.round(r / 24) * 24;
    const qG = Math.round(g / 24) * 24;
    const qB = Math.round(b / 24) * 24;
    const key = `${qR},${qG},${qB}`;
    const bucket = buckets.get(key) || { r: 0, g: 0, b: 0, score: 0, count: 0 };

    bucket.r += r * score;
    bucket.g += g * score;
    bucket.b += b * score;
    bucket.score += score;
    bucket.count += 1;
    buckets.set(key, bucket);

    fallbackR += r * score;
    fallbackG += g * score;
    fallbackB += b * score;
    fallbackScore += score;
  }

  const chosen = [...buckets.values()]
    .filter((bucket) => bucket.score > 0 && bucket.count >= 2)
    .sort((a, b) => b.score - a.score)[0];

  if (chosen) {
    return normalizeColor([chosen.r / chosen.score, chosen.g / chosen.score, chosen.b / chosen.score]);
  }

  if (fallbackScore > 0) {
    return normalizeColor([fallbackR / fallbackScore, fallbackG / fallbackScore, fallbackB / fallbackScore]);
  }

  return null;
}

export async function getDominantColorForArtwork(url: string): Promise<string | null> {
  if (!url) return null;
  if (colorCache.has(url)) return colorCache.get(url)!;
  if (inFlight.has(url)) return inFlight.get(url)!;

  const promise = (async () => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (!response.ok) return null;

      const input = Buffer.from(await response.arrayBuffer());
      const { data } = await sharp(input)
        .resize(64, 64, { fit: "cover" })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });

      const color = chooseAccentColor(data);
      if (color) cacheColor(url, color);
      return color;
    } catch {
      return null;
    } finally {
      clearTimeout(timeout);
      inFlight.delete(url);
    }
  })();

  inFlight.set(url, promise);
  return promise;
}

export async function attachDominantColorToTrack(track: any): Promise<any> {
  if (!track || typeof track !== "object") return track;
  if (track.dominantColor) return track;

  const artworkUrl = getArtworkUrlFromTrack(track);
  const dominantColor = await getDominantColorForArtwork(artworkUrl);
  if (!dominantColor) return track;

  return {
    ...track,
    dominantColor,
    album: track.album && typeof track.album === "object"
      ? { ...track.album, dominantColor: track.album.dominantColor || dominantColor }
      : track.album,
  };
}

export async function attachDominantColorToRecentItem(item: any): Promise<any> {
  if (!item?.track) return item;
  const track = await attachDominantColorToTrack(item.track);
  return {
    ...item,
    dominantColor: item.dominantColor || track?.dominantColor || null,
    track,
  };
}

export async function attachDominantColorToItems<T extends any[]>(items: T, limit = 60): Promise<T> {
  const next = [...items];
  const capped = next.slice(0, limit);
  const concurrency = 4;
  let cursor = 0;

  await Promise.all(Array.from({ length: Math.min(concurrency, capped.length) }, async () => {
    while (cursor < capped.length) {
      const index = cursor++;
      const item = capped[index];
      next[index] = item?.track
        ? await attachDominantColorToRecentItem(item)
        : await attachDominantColorToTrack(item);
    }
  }));

  return next as T;
}
