import { buildQuery, encodeSegment, getItems } from "./api-helpers.js";
import { normalizeTopItem } from "./normalize.js";
import { statsfmFetch } from "./statsfm.js";
import {
  enrichAlbumItemsWithOwners,
  enrichTrackItemsWithAlbumOwners,
} from "./track-album-enrichment.js";

export type TopType = "artists" | "tracks" | "albums";
type FetchOptions = NonNullable<Parameters<typeof statsfmFetch>[1]>;

export function buildTopQuery(after: string | number, limit: string | number, before?: string | number | null) {
  return buildQuery({ after, before, limit });
}

export async function fetchUserTop(
  userId: string,
  type: TopType | "genres",
  after: string | number,
  limit: string | number,
  options: FetchOptions = {},
  before?: string | number | null
) {
  return statsfmFetch(
    `/users/${encodeSegment(userId)}/top/${type}${buildTopQuery(after, limit, before)}`,
    options
  );
}

export async function normalizeTopItems(
  data: unknown,
  type: TopType,
  options: FetchOptions & {
    albumItems?: any[];
    userId?: string;
    after?: string | number | null;
    before?: string | number | null;
  } = {}
) {
  const items = getItems(data);
  const enrichedItems = type === "tracks"
    ? await enrichTrackItemsWithAlbumOwners(items, options)
    : type === "albums"
      ? await enrichAlbumItemsWithOwners(items, options)
      : items;

  return enrichedItems.map((item: any) => normalizeTopItem(item, type));
}
