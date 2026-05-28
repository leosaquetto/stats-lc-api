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

function artistKey(artist: any) {
  if (!artist) return null;
  if (artist.id != null) return `id:${String(artist.id)}`;
  if (typeof artist.name === "string" && artist.name.trim()) {
    return `name:${artist.name.trim().toLowerCase()}`;
  }
  return null;
}

function inferAlbumOwnerFromTracks(items: any[]) {
  const counts = new Map<string, { artist: any; count: number }>();
  const tracks = Array.isArray(items) ? items : [];

  for (const item of tracks) {
    const track = getTrackValue(item);
    for (const artist of Array.isArray(track?.artists) ? track.artists : []) {
      const key = artistKey(artist);
      if (!key) continue;

      const current = counts.get(key) ?? { artist, count: 0 };
      current.count += 1;
      counts.set(key, current);
    }
  }

  const ranked = [...counts.values()].sort((a, b) => b.count - a.count);
  const winner = ranked[0];
  if (!winner) return null;

  const runnerUp = ranked[1];
  const minimum = Math.max(2, Math.ceil(tracks.length * 0.5));
  if (winner.count >= minimum || winner.count > (runnerUp?.count ?? 0)) {
    return winner.artist;
  }

  return null;
}

function albumIdForDetail(album: any) {
  const id = album?.id;
  if (id == null) return null;
  return String(id);
}

function albumValue(item: any) {
  return item?.album ?? item;
}

function needsAlbumOwnerDetail(item: any) {
  const track = getTrackValue(item);
  if (!hasMultipleArtists(track)) return false;

  const album = getTrackAlbum(track);
  return Boolean(album && !albumHasOwner(album) && albumIdForDetail(album));
}

async function fetchAlbumDetails(albumIds: string[], options: FetchOptions) {
  return Promise.all(
    albumIds.map(async (id) => {
      const result = await statsfmFetch(`/albums/${encodeSegment(id)}`, {
        force: options.force,
        cacheProfile: options.cacheProfile,
      });

      if (!result.ok) return null;
      const detail: any = getItem(result.data) ?? result.data;
      const album = detail?.album ?? detail;
      if (albumHasOwner(album)) return album;

      const tracksResult = await statsfmFetch(`/albums/${encodeSegment(id)}/tracks?limit=50`, {
        force: options.force,
        cacheProfile: options.cacheProfile,
      });
      if (!tracksResult.ok) return album;

      const owner = inferAlbumOwnerFromTracks((tracksResult.data as any)?.items);
      return owner
        ? {
            ...album,
            artist: owner,
            artists: [owner],
            artistId: owner.id ?? null,
            artistName: owner.name ?? null,
            primaryArtist: owner,
            primaryArtistId: owner.id ?? null,
            primaryArtistName: owner.name ?? null,
          }
        : album;
    })
  );
}

function mergeAlbumOwner<T>(item: T, detail: any): T {
  const album = albumValue(item);
  const owner = detail?.artists?.[0] ?? detail?.artist ?? detail?.primaryArtist ?? null;
  if (!album || !owner) return item;

  const enrichedAlbum = {
    ...album,
    artist: owner,
    artists: [owner],
    artistId: owner.id ?? null,
    artistName: owner.name ?? null,
    primaryArtist: owner,
    primaryArtistId: owner.id ?? null,
    primaryArtistName: owner.name ?? null,
  };

  if ((item as any)?.album) {
    return {
      ...(item as any),
      album: enrichedAlbum,
    };
  }

  return enrichedAlbum as T;
}

export async function enrichAlbumItemsWithOwners<T>(
  items: T[],
  options: FetchOptions = {}
): Promise<T[]> {
  const sourceItems = Array.isArray(items) ? items : [];
  if (sourceItems.length === 0) return [];

  const albumIds = [
    ...new Set(
      sourceItems
        .filter((item: any) => {
          const album = albumValue(item);
          return album && !albumHasOwner(album) && albumIdForDetail(album);
        })
        .map((item: any) => albumIdForDetail(albumValue(item)))
        .filter(Boolean)
    ),
  ] as string[];

  if (albumIds.length === 0) return sourceItems;

  const albumDetails = await fetchAlbumDetails(albumIds, options);
  const detailById = new Map(
    albumDetails
      .filter(Boolean)
      .map((album: any) => [String(album.id), album])
  );

  return sourceItems.map((item: any) => {
    const id = albumIdForDetail(albumValue(item));
    const detail = id ? detailById.get(id) : null;
    return detail ? mergeAlbumOwner(item, detail) : item;
  });
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

  const albumDetails = await fetchAlbumDetails(albumIds, options);

  return enrichTopTracksWithAlbumOwners(
    lookupEnriched,
    albumDetails.filter(Boolean).map((album) => ({ album }))
  ) as T[];
}
