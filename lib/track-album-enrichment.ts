import { fetchAppleMusicTrackEvidence } from "./apple-music.js";
import { encodeSegment, getItem, mapWithConcurrency } from "./api-helpers.js";
import { enrichTopTracksWithAlbumOwners, normalizeExternalIds } from "./normalize.js";
import { statsfmFetch } from "./statsfm.js";

type FetchOptions = NonNullable<Parameters<typeof statsfmFetch>[1]>;
type TrackAlbumEvidenceOptions = FetchOptions & {
  albumItems?: any[];
  userId?: string;
  after?: number | string | null;
  before?: number | string | null;
  useTrackStreamEvidence?: boolean;
  trackStreamEvidenceStrategy?: "majority" | "latest";
};

function readText(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getTrackValue(item: any) {
  return item?.track ?? item;
}

function getTrackAlbum(track: any) {
  return track?.albums?.[0] ?? track?.album ?? null;
}

function canonicalText(value: unknown) {
  return typeof value === "string"
    ? value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .replace(/&/g, " and ")
        .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
    : "";
}

function canonicalTrackTitle(value: unknown) {
  const text = typeof value === "string"
    ? value
        .replace(/\s*[\(\[]\s*(?:from|feat|ft|with)\b[\s\S]*[\)\]]\s*$/i, "")
        .replace(/\s+[-–—]\s+(?:from|feat|ft|with)\b.*$/i, "")
    : value;
  return canonicalText(text);
}

function getAppleMusicId(track: any) {
  const directId = readText(track?.appleMusicId);
  if (directId) return directId;
  return normalizeExternalIds(track).appleMusic[0] ?? null;
}

function getTrackId(item: any) {
  const streamTrackId = item?.track?.id ?? item?.trackId;
  if (streamTrackId != null) return String(streamTrackId);

  const looksLikeStreamItem =
    item?.endTime != null ||
    item?.playedAt != null ||
    item?.trackId != null ||
    item?.albumId != null ||
    item?.userId != null;
  if (looksLikeStreamItem) return null;

  const id = item?.id;
  return id == null ? null : String(id);
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

function albumForTrackReplacement(item: any) {
  const album = albumValue(item);
  return album && typeof album === "object" ? album : null;
}

function getArtistName(artist: any) {
  return typeof artist === "string" ? artist : readText(artist?.name ?? artist?.artistName);
}

function getAlbumArtistName(album: any) {
  return readText(album?.artistName) ||
    readText(album?.primaryArtistName) ||
    getArtistName(album?.artist) ||
    getArtistName(album?.primaryArtist) ||
    getArtistName(Array.isArray(album?.artists) ? album.artists[0] : null);
}

function getTrackArtistNames(track: any) {
  const names = [
    readText(track?.primaryArtistName),
    readText(track?.artistName),
    getArtistName(track?.primaryArtist),
    getArtistName(track?.artist),
    ...(Array.isArray(track?.artists) ? track.artists.map(getArtistName) : []),
  ];
  return [...new Set(names.filter(Boolean).map((name) => canonicalText(name)))];
}

function sameArtistContext(track: any, album: any) {
  const albumArtist = canonicalText(getAlbumArtistName(album));
  if (!albumArtist) return false;
  return getTrackArtistNames(track).includes(albumArtist);
}

function isSingleLikeAlbum(album: any) {
  const type = canonicalText(album?.type);
  const totalTracks = Number(album?.totalTracks ?? album?.total_tracks);
  return type === "single" || totalTracks === 1;
}

function isAlbumLikeContext(album: any) {
  if (!album || typeof album !== "object" || !albumIdForDetail(album)) return false;
  const type = canonicalText(album?.type);
  const totalTracks = Number(album?.totalTracks ?? album?.total_tracks);
  return type === "album" || totalTracks > 1;
}

function mergeAlbumIntoTrackItem<T>(item: T, album: any): T {
  const track = getTrackValue(item);
  const replacement = albumForTrackReplacement(album);
  if (!track || !replacement) return item;

  const currentAlbums = Array.isArray(track?.albums) ? track.albums : [];
  const enrichedTrack = {
    ...track,
    album: replacement,
    albums: [replacement, ...currentAlbums.filter((entry: any) => String(entry?.id) !== String(replacement.id))],
    albumId: replacement.id ?? track?.albumId ?? null,
    albumName: replacement.name ?? track?.albumName ?? null,
    albumImage: replacement.image ?? track?.albumImage ?? null,
    albumArtist: replacement.artist ?? replacement.primaryArtist ?? replacement.artists?.[0] ?? track?.albumArtist ?? null,
    albumArtistId:
      replacement.artistId ??
      replacement.primaryArtistId ??
      replacement.artist?.id ??
      replacement.primaryArtist?.id ??
      replacement.artists?.[0]?.id ??
      track?.albumArtistId ??
      null,
    albumArtistName:
      replacement.artistName ??
      replacement.primaryArtistName ??
      replacement.artist?.name ??
      replacement.primaryArtist?.name ??
      replacement.artists?.[0]?.name ??
      track?.albumArtistName ??
      null,
  };

  if ((item as any)?.track) {
    return {
      ...(item as any),
      track: enrichedTrack,
    };
  }

  return enrichedTrack as T;
}

function mergeAppleMusicAlbumOwner<T>(item: T, artistName: string): T {
  const track = getTrackValue(item);
  const album = getTrackAlbum(track);
  if (!track || !album || albumHasOwner(album)) return item;

  const enrichedAlbum = {
    ...album,
    artistName,
    primaryArtistName: artistName,
  };
  const currentAlbums = Array.isArray(track?.albums) ? track.albums : [];
  const enrichedTrack = {
    ...track,
    album: track?.album ? enrichedAlbum : track?.album,
    albums: currentAlbums.length > 0 ? [enrichedAlbum, ...currentAlbums.slice(1)] : track?.albums,
    albumArtistName: artistName,
  };

  if ((item as any)?.track) {
    return {
      ...(item as any),
      track: enrichedTrack,
    };
  }

  return enrichedTrack as T;
}

function needsAlbumOwnerDetail(item: any) {
  const track = getTrackValue(item);
  if (!hasMultipleArtists(track)) return false;

  const album = getTrackAlbum(track);
  return Boolean(album && !albumHasOwner(album) && albumIdForDetail(album));
}

function needsAppleMusicOwnerEvidence(item: any) {
  const track = getTrackValue(item);
  if (!hasMultipleArtists(track)) return false;

  const album = getTrackAlbum(track);
  return Boolean(album && !albumHasOwner(album) && getAppleMusicId(track));
}

async function enrichTracksWithAppleMusicOwners<T>(
  items: T[],
  options: FetchOptions
): Promise<T[]> {
  const candidates = items
    .filter(needsAppleMusicOwnerEvidence)
    .map((item: any) => ({ item, appleMusicId: getAppleMusicId(getTrackValue(item)) }))
    .filter((candidate): candidate is { item: T; appleMusicId: string } => Boolean(candidate.appleMusicId))
    .slice(0, 4);

  if (candidates.length === 0) return items;

  const evidenceByAppleMusicId = new Map<string, string>();
  await mapWithConcurrency(candidates, 4, async ({ appleMusicId }) => {
    if (evidenceByAppleMusicId.has(appleMusicId)) return;
    const evidence = await fetchAppleMusicTrackEvidence(appleMusicId, { force: options.force });
    if (evidence?.artistName) evidenceByAppleMusicId.set(appleMusicId, evidence.artistName);
  });

  if (evidenceByAppleMusicId.size === 0) return items;

  return items.map((item: any) => {
    if (!needsAppleMusicOwnerEvidence(item)) return item;
    const appleMusicId = getAppleMusicId(getTrackValue(item));
    const artistName = appleMusicId ? evidenceByAppleMusicId.get(appleMusicId) : null;
    return artistName ? mergeAppleMusicAlbumOwner(item, artistName) : item;
  });
}

async function fetchAlbumTrackTitleKeys(albumId: string, options: FetchOptions) {
  const result = await statsfmFetch(`/albums/${encodeSegment(albumId)}/tracks?limit=100`, {
    force: options.force,
    cacheProfile: options.cacheProfile,
    requestTimeoutMs: Math.min(options.requestTimeoutMs ?? 1000, 1000),
  });

  if (!result.ok) return new Set<string>();

  const keys = new Set<string>();
  for (const item of Array.isArray((result.data as any)?.items) ? (result.data as any).items : []) {
    const track = getTrackValue(item);
    const key = canonicalTrackTitle(track?.name);
    if (key) keys.add(key);
  }
  return keys;
}

async function enrichSingleTracksWithRecentAlbumContext<T>(
  items: T[],
  options: FetchOptions
): Promise<T[]> {
  const sourceItems = Array.isArray(items) ? items : [];
  const contextAlbums = sourceItems
    .map((item: any) => getTrackAlbum(getTrackValue(item)))
    .filter(isAlbumLikeContext);

  if (contextAlbums.length === 0) return sourceItems;

  const contextAlbumById = new Map<string, any>();
  for (const album of contextAlbums) {
    const id = albumIdForDetail(album);
    if (id && !contextAlbumById.has(id)) contextAlbumById.set(id, album);
  }

  const singleCandidates = sourceItems.filter((item: any) => {
    const track = getTrackValue(item);
    const album = getTrackAlbum(track);
    return Boolean(track && album && isSingleLikeAlbum(album) && canonicalTrackTitle(track?.name));
  });

  if (singleCandidates.length === 0) return sourceItems;

  const albumIds = [...contextAlbumById.keys()].slice(0, 4);
  const trackKeysByAlbumId = new Map<string, Set<string>>();
  await mapWithConcurrency(albumIds, 2, async (albumId) => {
    trackKeysByAlbumId.set(albumId, await fetchAlbumTrackTitleKeys(albumId, options));
  });

  if (trackKeysByAlbumId.size === 0) return sourceItems;

  return sourceItems.map((item: any) => {
    const track = getTrackValue(item);
    const album = getTrackAlbum(track);
    if (!track || !album || !isSingleLikeAlbum(album)) return item;

    const titleKey = canonicalTrackTitle(track?.name);
    if (!titleKey) return item;

    const matchedAlbum = albumIds
      .map((albumId) => contextAlbumById.get(albumId))
      .find((candidateAlbum) => {
        const albumId = albumIdForDetail(candidateAlbum);
        return albumId &&
          sameArtistContext(track, candidateAlbum) &&
          trackKeysByAlbumId.get(albumId)?.has(titleKey);
      });

    return matchedAlbum ? mergeAlbumIntoTrackItem(item, matchedAlbum) : item;
  });
}

async function fetchAlbumDetails(albumIds: string[], options: FetchOptions) {
  return Promise.all(
    albumIds.map(async (id) => {
      const result = await statsfmFetch(`/albums/${encodeSegment(id)}`, {
        force: options.force,
        cacheProfile: options.cacheProfile,
        requestTimeoutMs: options.requestTimeoutMs,
      });

      if (!result.ok) return null;
      const detail: any = getItem(result.data) ?? result.data;
      const album = detail?.album ?? detail;
      if (albumHasOwner(album)) return album;

      const tracksResult = await statsfmFetch(`/albums/${encodeSegment(id)}/tracks?limit=50`, {
        force: options.force,
        cacheProfile: options.cacheProfile,
        requestTimeoutMs: options.requestTimeoutMs,
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

async function fetchStreamAlbumEvidence(
  items: any[],
  options: TrackAlbumEvidenceOptions,
  wantedTrackIds = new Set(items.map(getTrackId).filter(Boolean) as string[])
) {
  if (!options.userId || !Array.isArray(options.albumItems) || options.albumItems.length === 0) {
    return new Map<string, any>();
  }

  if (wantedTrackIds.size === 0) return new Map<string, any>();

  const candidates = options.albumItems
    .map((item) => albumForTrackReplacement(item))
    .filter((album) => album && albumIdForDetail(album));
  const albumIds = [...new Set(candidates.map((album) => albumIdForDetail(album)).filter(Boolean))] as string[];
  if (albumIds.length === 0) return new Map<string, any>();

  const albumById = new Map(candidates.map((album) => [String(album.id), album]));
  const evidence = new Map<string, any>();

  await Promise.all(
    albumIds.map(async (albumId) => {
      const query = new URLSearchParams({ limit: "200" });
      if (options.after != null && options.after !== "") query.set("after", String(options.after));
      if (options.before != null && options.before !== "") query.set("before", String(options.before));

      const result = await statsfmFetch(
        `/users/${encodeSegment(options.userId!)}/streams/albums/${encodeSegment(albumId)}?${query.toString()}`,
        {
          force: options.force,
          cacheProfile: options.cacheProfile,
          requestTimeoutMs: options.requestTimeoutMs,
        }
      );
      if (!result.ok) return;

      const album = albumById.get(albumId);
      for (const stream of Array.isArray((result.data as any)?.items) ? (result.data as any).items : []) {
        const trackId = stream?.trackId == null ? null : String(stream.trackId);
        if (!trackId || !wantedTrackIds.has(trackId) || evidence.has(trackId)) continue;
        evidence.set(trackId, album);
      }
    })
  );

  return evidence;
}

async function fetchTrackStreamAlbumEvidence(
  items: any[],
  options: TrackAlbumEvidenceOptions
) {
  if (!options.userId) return new Map<string, any>();

  const trackIds = [...new Set(items.map(getTrackId).filter(Boolean) as string[])];
  if (trackIds.length === 0) return new Map<string, any>();

  const albumIdByTrackId = new Map<string, string>();

  await Promise.all(
    trackIds.map(async (trackId) => {
      const query = new URLSearchParams({ limit: "50" });
      if (options.after != null && options.after !== "") query.set("after", String(options.after));
      if (options.before != null && options.before !== "") query.set("before", String(options.before));

      const result = await statsfmFetch(
        `/users/${encodeSegment(options.userId!)}/streams/tracks/${encodeSegment(trackId)}?${query.toString()}`,
        {
          force: options.force,
          cacheProfile: options.cacheProfile,
          requestTimeoutMs: options.requestTimeoutMs,
        }
      );
      if (!result.ok) return;

      const streams = Array.isArray((result.data as any)?.items) ? (result.data as any).items : [];
      if (options.trackStreamEvidenceStrategy === "latest") {
        const latestAlbumId = streams
          .map((stream: any) => stream?.albumId == null ? null : String(stream.albumId))
          .find(Boolean);
        if (latestAlbumId) albumIdByTrackId.set(trackId, latestAlbumId);
        return;
      }

      const counts = new Map<string, number>();
      for (const stream of streams) {
        const albumId = stream?.albumId == null ? null : String(stream.albumId);
        if (!albumId) continue;
        counts.set(albumId, (counts.get(albumId) ?? 0) + 1);
      }

      const winner = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (winner) albumIdByTrackId.set(trackId, winner);
    })
  );

  const albumIds = [...new Set(albumIdByTrackId.values())];
  const albums = await fetchAlbumDetails(albumIds, options);
  const albumById = new Map(albums.filter(Boolean).map((album: any) => [String(album.id), album]));
  const evidence = new Map<string, any>();

  for (const [trackId, albumId] of albumIdByTrackId) {
    const album = albumById.get(albumId);
    if (album) evidence.set(trackId, album);
  }

  return evidence;
}

async function fetchDirectStreamAlbumDetails(
  items: any[],
  options: FetchOptions
) {
  const albumIds = [
    ...new Set(
      items
        .map((item: any) => item?.albumId)
        .filter((id: unknown) => id != null)
        .map(String)
    ),
  ];
  if (albumIds.length === 0) return new Map<string, any>();

  const albums = await fetchAlbumDetails(albumIds, options);
  return new Map(
    albums
      .filter(Boolean)
      .map((album: any) => [String(album.id), album])
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
  options: TrackAlbumEvidenceOptions = {}
): Promise<T[]> {
  const sourceItems = Array.isArray(items) ? items : [];
  if (sourceItems.length === 0) return [];

  const directStreamAlbumDetails = await fetchDirectStreamAlbumDetails(sourceItems, options);
  const itemsNeedingTrackStreamEvidence = sourceItems.filter((item: any) => (
    item?.albumId == null || !directStreamAlbumDetails.has(String(item.albumId))
  ));
  const trackStreamEvidence = options.useTrackStreamEvidence === false
    ? new Map<string, any>()
    : await fetchTrackStreamAlbumEvidence(itemsNeedingTrackStreamEvidence, options);
  const missingTrackIds = new Set(
    sourceItems
      .map(getTrackId)
      .filter((trackId): trackId is string => {
        if (!trackId) return false;
        return !trackStreamEvidence.has(trackId);
      })
  );
  const streamAlbumEvidence = missingTrackIds.size > 0
    ? await fetchStreamAlbumEvidence(sourceItems, options, missingTrackIds)
    : new Map<string, any>();

  const streamEnriched = sourceItems.map((item: any) => {
    const trackId = getTrackId(item);
    const albumFromTrackStreams = trackId ? trackStreamEvidence.get(trackId) : null;
    const albumFromTopAlbumStreams = trackId ? streamAlbumEvidence.get(trackId) : null;
    const albumFromStreamRow = item?.albumId == null ? null : directStreamAlbumDetails.get(String(item.albumId));
    const album = albumFromTrackStreams ?? albumFromTopAlbumStreams ?? albumFromStreamRow;
    return album ? mergeAlbumIntoTrackItem(item, album) : item;
  });

  const lookupEnriched = options.albumItems
    ? enrichTopTracksWithAlbumOwners(streamEnriched, options.albumItems)
    : streamEnriched;

  const contextEnriched = await enrichSingleTracksWithRecentAlbumContext(lookupEnriched as T[], options);
  const appleMusicEnriched = await enrichTracksWithAppleMusicOwners(contextEnriched as T[], options);

  const albumIds = [
    ...new Set(
      appleMusicEnriched
        .filter(needsAlbumOwnerDetail)
        .map((item: any) => albumIdForDetail(getTrackAlbum(getTrackValue(item))))
        .filter(Boolean)
    ),
  ] as string[];

  if (albumIds.length === 0) return appleMusicEnriched as T[];

  const albumDetails = await fetchAlbumDetails(albumIds, options);

  return enrichTopTracksWithAlbumOwners(
    appleMusicEnriched,
    albumDetails.filter(Boolean).map((album) => ({ album }))
  ) as T[];
}
