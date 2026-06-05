const ITUNES_LOOKUP_BASE = "https://itunes.apple.com/lookup";
const REQUEST_TIMEOUT_MS = 800;
const CACHE_TTL_MS = 7 * 24 * 60 * 60_000;

type AppleMusicTrackEvidence = {
  artistName: string | null;
};

const cache = new Map<string, { expiresAt: number; data: AppleMusicTrackEvidence | null }>();

function readText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function fetchAppleMusicTrackEvidence(
  appleMusicId: string,
  options: { force?: boolean } = {}
): Promise<AppleMusicTrackEvidence | null> {
  const id = appleMusicId.trim();
  if (!id) return null;

  const cached = cache.get(id);
  if (!options.force && cached && cached.expiresAt > Date.now()) return cached.data;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const query = new URLSearchParams({ id, entity: "song", limit: "1" });
    const response = await fetch(`${ITUNES_LOOKUP_BASE}?${query.toString()}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data: any = await response.json();
    const result = Array.isArray(data?.results)
      ? data.results.find((entry: any) => String(entry?.trackId) === id) ?? data.results[0]
      : null;
    const evidence = result
      ? { artistName: readText(result.artistName) }
      : null;

    cache.set(id, { expiresAt: Date.now() + CACHE_TTL_MS, data: evidence });
    return evidence;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
