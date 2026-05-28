import { encodeSegment, getItem } from "./api-helpers.js";
import { enrichTopTracksWithAlbumOwners } from "./normalize.js";
import { statsfmFetch } from "./statsfm.js";

type FetchOptions = NonNullable<Parameters<typeof statsfmFetch>[1]>;

function readText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getTrackValue(item: any) {
  return item?.track ?? item;
}

function getTrackAlbum(track: any) {
  return track?.albums?.[0] ?? track?.album ?? null;
}

function hasMultipleArtists(track: any) {
  return Array.isArray(track?.artists) && track.artists.filter(Boolean).length > 1;
}

function albumHasOwner(album: any) {
  if (!album || typeof album !== "object") return false;
  if (album.artist) return true;
  if (Array.isArray(album.artists) && album.artists.some(Boolean)) return true;
  if (album.primaryArtist) return true;
  return Boolean(
    readText(album.primaryArtistName) ||
    readText(album.artistName) ||
    readText(album.primaryArtistId) ||
    readText(album.artistId)
  );
}

function albumIdForDetail(album: any) {
  const id = album?.id;
  if (id == null) return null;
  return String(id);
}

function needsAlbumOwnerDetail(item: any) {
  const track = getTrackValue(item);
  if (!hasMultipleArtists(track)) return false;

  const album = getTrackAlbum(track);
  return Boolean(album && !albumHasOwner(album) && albumIdForDetail(album));
}

export async function enrichTrackItemsWithAlbumOwners<T>(
  items: T[],
  options: FetchOptions & { albumItems?: any[] } = {}
): Promise<T[]> {
  const sourceItems = Array.isArray(items) ? items : [];
  if (sourceItems.length === 0) return [];

  const lookupEnriched = options.albumItems
    ? enrichTopTracksWithAlbumOwners(sourceItems, options.albumItems)
    : sourceItems;

  const albumIds = [
    ...new Set(
      lookupEnriched
        .filter(needsAlbumOwnerDetail)
        .map((item: any) => albumIdForDetail(getTrackAlbum(getTrackValue(item))))
        .filter(Boolean)
    ),
  ] as string[];

  if (albumIds.length === 0) return lookupEnriched as T[];

  const albumDetails = await Promise.all(
    albumIds.map(async (id) => {
      const result = await statsfmFetch(`/albums/${encodeSegment(id)}`, {
        force: options.force,
        cacheProfile: options.cacheProfile,
      });

      if (!result.ok) return null;
      const detail: any = getItem(result.data) ?? result.data;
      return detail?.album ?? detail;
    })
  );

  return enrichTopTracksWithAlbumOwners(
    lookupEnriched,
    albumDetails.filter(Boolean).map((album) => ({ album }))
  ) as T[];
}
