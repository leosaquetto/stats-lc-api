type ManualArtist = {
  id?: string | number | null;
  name: string;
  image?: string | null;
};

export type ManualAlbumOverride = {
  id: string | number;
  name: string;
  image?: string | null;
  artist: ManualArtist;
  externalIds?: Record<string, unknown>;
  releaseDate?: number | string | null;
  totalTracks?: number | null;
  type?: string | null;
};

// Map stats.fm album/single IDs to the canonical album that should represent them.
// Add entries here when stats.fm attaches tracks to a single/EP instead of the intended album.
export const ALBUM_OVERRIDES_BY_ALBUM_ID: Record<string, ManualAlbumOverride> = {
  // "single-album-id": {
  //   id: "canonical-album-id",
  //   name: "Canonical Album",
  //   artist: { id: "artist-id", name: "Artist Name" },
  // },
};

// Optional direct track override for cases where the source album ID is not stable.
export const ALBUM_OVERRIDES_BY_TRACK_ID: Record<string, ManualAlbumOverride> = {
  // "track-id": {
  //   id: "canonical-album-id",
  //   name: "Canonical Album",
  //   artist: { id: "artist-id", name: "Artist Name" },
  // },
};

function toAlbumShape(override: ManualAlbumOverride, fallbackAlbum: any = {}) {
  const artist = {
    id: override.artist.id ?? null,
    name: override.artist.name,
    image: override.artist.image ?? null,
  };

  return {
    ...fallbackAlbum,
    id: override.id,
    name: override.name,
    image: override.image ?? fallbackAlbum?.image ?? null,
    type: override.type ?? fallbackAlbum?.type ?? null,
    releaseDate: override.releaseDate ?? fallbackAlbum?.releaseDate ?? null,
    totalTracks: override.totalTracks ?? fallbackAlbum?.totalTracks ?? null,
    externalIds: override.externalIds ?? fallbackAlbum?.externalIds ?? {},
    artist,
    artists: [artist],
    artistId: artist.id,
    artistName: artist.name,
    primaryArtist: artist,
    primaryArtistId: artist.id,
    primaryArtistName: artist.name,
    manualAlbumOverride: true,
    sourceAlbumId: fallbackAlbum?.id ?? null,
    sourceAlbumName: fallbackAlbum?.name ?? null,
  };
}

function readId(value: unknown) {
  return value == null ? null : String(value);
}

function findTrackOverride(track: any) {
  const trackId = readId(track?.id);
  if (trackId && ALBUM_OVERRIDES_BY_TRACK_ID[trackId]) {
    return ALBUM_OVERRIDES_BY_TRACK_ID[trackId];
  }

  const albumId = readId(track?.albums?.[0]?.id ?? track?.album?.id);
  return albumId ? ALBUM_OVERRIDES_BY_ALBUM_ID[albumId] : null;
}

function findAlbumOverride(album: any) {
  const albumId = readId(album?.id);
  return albumId ? ALBUM_OVERRIDES_BY_ALBUM_ID[albumId] : null;
}

export function applyManualAlbumOverrideToTrackItem<T>(item: T): T {
  const track = (item as any)?.track ?? item;
  const override = findTrackOverride(track);
  if (!override) return item;

  const currentAlbum = track?.albums?.[0] ?? track?.album ?? {};
  const overriddenAlbum = toAlbumShape(override, currentAlbum);
  const overriddenTrack = {
    ...track,
    album: overriddenAlbum,
    albums: Array.isArray(track?.albums)
      ? [overriddenAlbum, ...track.albums.slice(1)]
      : [overriddenAlbum],
    albumId: overriddenAlbum.id,
    albumName: overriddenAlbum.name,
    albumImage: overriddenAlbum.image,
    albumArtist: overriddenAlbum.artist,
    albumArtistId: overriddenAlbum.artistId,
    albumArtistName: overriddenAlbum.artistName,
  };

  if ((item as any)?.track) {
    return {
      ...(item as any),
      track: overriddenTrack,
    };
  }

  return overriddenTrack as T;
}

export function applyManualAlbumOverrideToAlbumItem<T>(item: T): T {
  const album = (item as any)?.album ?? item;
  const override = findAlbumOverride(album);
  if (!override) return item;

  const overriddenAlbum = toAlbumShape(override, album);

  if ((item as any)?.album) {
    return {
      ...(item as any),
      album: overriddenAlbum,
    };
  }

  return overriddenAlbum as T;
}
