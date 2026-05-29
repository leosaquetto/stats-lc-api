export type EntityType = "track" | "artist" | "album";

export const ENTITY_ROUTE_MAP = {
  track: "tracks",
  artist: "artists",
  album: "albums",
} as const;

export function readQueryString(value: unknown) {
  if (Array.isArray(value)) return value[0] ? String(value[0]) : "";
  return value == null ? "" : String(value);
}

export function readOptionalQueryString(value: unknown) {
  const stringValue = readQueryString(value);
  return stringValue ? stringValue : null;
}

export function readEntityType(value: unknown): EntityType | null {
  const type = readQueryString(value);
  return type === "track" || type === "artist" || type === "album" ? type : null;
}

export function encodeSegment(value: string) {
  return encodeURIComponent(value);
}

export function buildQuery(params: Record<string, string | number | boolean | null | undefined>) {
  const query = new URLSearchParams();

  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    query.set(key, String(value));
  }

  const queryString = query.toString();
  return queryString ? `?${queryString}` : "";
}

export function getItems(data: any) {
  return Array.isArray(data?.items) ? data.items : [];
}

export function getItem(data: any) {
  return data?.item ?? null;
}

export function setCorsHeaders(
  res: { setHeader(name: string, value: string): unknown }
) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Access-Control-Expose-Headers", "Cache-Control");
}

export function setCacheHeaders(
  res: { setHeader(name: string, value: string): unknown },
  seconds: number,
  force = false,
  staleSeconds = seconds * 6
) {
  if (force) {
    res.setHeader("Cache-Control", "no-store");
    return;
  }

  res.setHeader(
    "Cache-Control",
    `public, s-maxage=${seconds}, stale-while-revalidate=${staleSeconds}`
  );
}

export function sendJsonError(
  res: { status(code: number): { json(body: any): unknown; end?: () => unknown }; setHeader(name: string, value: string): unknown },
  status: number,
  error: string,
  details?: unknown
) {
  setCorsHeaders(res);
  setCacheHeaders(res, 0, true);

  return res.status(status).json({
    ok: false,
    error,
    ...(details === undefined ? {} : { details }),
  });
}

export async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>
) {
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await Promise.resolve(mapper(items[index], index)).then(
        (value) => ({ status: "fulfilled", value }),
        (reason) => ({ status: "rejected", reason })
      );
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
