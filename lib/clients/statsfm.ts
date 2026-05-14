import { getMemoryCache, setMemoryCache } from "../cache/memory.js";

const API_BASE = "https://api.stats.fm/api/v1";

export async function statsfmFetch(path: string, options?: { force?: boolean; timeoutMs?: number; retries?: number }) {
  const startedAt = Date.now();
  const url = `${API_BASE}${path}`;
  const timeoutMs = options?.timeoutMs ?? 8000;
  const retries = options?.retries ?? 2;
  const cacheKey = `statsfm:${url}`;

  if (!options?.force) {
    const cached = getMemoryCache<any>(cacheKey);
    if (cached) return { ...cached, cached: true };
  }

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" },
        cache: options?.force ? "no-store" : "default",
        signal: controller.signal
      });
      clearTimeout(timeout);

      const text = await response.text();
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

      const result = { ok: response.ok, status: response.status, endpoint: url, data, durationMs: Date.now() - startedAt };
      console.log("[statsfmFetch]", { endpoint: path, status: response.status, durationMs: result.durationMs, attempt });

      if (!response.ok && (response.status === 429 || response.status >= 500) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
        continue;
      }

      if (response.ok && !options?.force) setMemoryCache(cacheKey, result);
      return result;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (attempt < retries) await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
    }
  }

  console.error("[statsfmFetch:error]", { endpoint: path, durationMs: Date.now() - startedAt, error: String(lastError) });
  return { ok: false, status: 504, endpoint: url, data: { error: "timeout_or_network", detail: String(lastError) }, durationMs: Date.now() - startedAt };
}

export function getCount(data: any) { return data?.items?.count ?? data?.item?.count ?? data?.count ?? 0; }
export function getDurationMs(data: any) { return data?.items?.durationMs ?? data?.item?.durationMs ?? data?.durationMs ?? 0; }
