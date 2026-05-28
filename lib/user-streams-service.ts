import { buildQuery, encodeSegment, getItems } from "./api-helpers.js";
import { normalizeRecentItem } from "./normalize.js";
import { statsfmFetch } from "./statsfm.js";
import { enrichTrackItemsWithAlbumOwners } from "./track-album-enrichment.js";

type FetchOptions = NonNullable<Parameters<typeof statsfmFetch>[1]>;
type StreamEntityType = "tracks" | "artists" | "albums";
type StreamNormalizeOptions = FetchOptions & {
  albumItems?: any[];
  userId?: string;
  after?: string | number | null;
  before?: string | number | null;
  useTrackStreamEvidence?: boolean;
};

export async function fetchUserStreams(
  userId: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
  options: FetchOptions = {}
) {
  return statsfmFetch(`/users/${encodeSegment(userId)}/streams${buildQuery(params)}`, options);
}

export async function fetchUserRecentStreams(
  userId: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
  options: FetchOptions = {}
) {
  return statsfmFetch(`/users/${encodeSegment(userId)}/streams/recent${buildQuery(params)}`, options);
}

export async function fetchUserEntityStreams(
  userId: string,
  entityType: StreamEntityType,
  id: string,
  params: Record<string, string | number | boolean | null | undefined> = {},
  options: FetchOptions = {}
) {
  return statsfmFetch(
    `/users/${encodeSegment(userId)}/streams/${entityType}/${encodeSegment(id)}${buildQuery(params)}`,
    options
  );
}

export async function normalizeStreamItems(data: unknown, options: StreamNormalizeOptions = {}) {
  const items = await enrichTrackItemsWithAlbumOwners(getItems(data), options);
  return items.map(normalizeRecentItem);
}
