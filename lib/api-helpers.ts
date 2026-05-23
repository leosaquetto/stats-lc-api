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
