import { USERS, type UserKey } from "./users.js";

type ServicePlatform = "appleMusic" | "spotify" | "unknown";
type ServiceConfidence = "high" | "medium" | "low" | "manual";

const SERVICE_CANDIDATE_KEYS = [
  "service",
  "services",
  "platform",
  "provider",
  "source",
  "importSource",
  "musicService",
  "streamingService",
  "connectedServices",
  "integrations"
] as const;

export function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function asArray(value: unknown): any[] {
  return Array.isArray(value) ? value : [];
}

export function pickFirstNonEmpty(...values: unknown[]) {
  for (const value of values) {
    if (value == null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return value;
  }
  return null;
}

export function normalizeDurationMs(value: unknown): number | null {
  return asNumber(value);
}

export function normalizePlayedMs(value: unknown): number | null {
  return asNumber(value);
}

export function normalizeExternalIds(entity: any) {
  const externalIds = entity?.externalIds ?? {};

  const spotify = asArray(externalIds?.spotify)
    .map((value) => asString(value))
    .filter(Boolean) as string[];

  const appleMusic = asArray(externalIds?.appleMusic)
    .map((value) => asString(value))
    .filter(Boolean) as string[];

  const musicBrainz = asArray(externalIds?.musicBrainz)
    .map((value) => asString(value))
    .filter(Boolean) as string[];

  const isrc = asArray(externalIds?.isrc)
    .map((value) => asString(value))
    .filter(Boolean) as string[];

  return {
    spotify,
    appleMusic,
    musicBrainz,
    isrc,
    raw: externalIds
  };
}

export function normalizeImage(entity: any): string | null {
  return asString(entity?.image);
}

function normalizeServicePlatform(value: unknown): ServicePlatform {
  if (typeof value !== "string") return "unknown";

  const normalized = value.trim().toLowerCase();

  if (!normalized) return "unknown";
  if (normalized.includes("apple")) return "appleMusic";
  if (normalized.includes("spotify")) return "spotify";

  return "unknown";
}

function extractTextValues(value: unknown): string[] {
  if (typeof value === "string") return [value];

  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractTextValues(entry));
  }

  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).flatMap((entry) =>
      extractTextValues(entry)
    );
  }

  return [];
}


export function extractUserPlatform(profileData: any, fallbackKey?: string) {
  const fallbackPlatform = fallbackKey ? USERS[fallbackKey as UserKey]?.platform ?? null : null;
  if (fallbackPlatform) {
    return {
      primary: fallbackPlatform,
      confidence: "manual" as ServiceConfidence,
      source: "manual",
      sourceKey: fallbackKey,
      rawValue: fallbackPlatform
    };
  }

  const profile = profileData?.profile ?? profileData ?? {};

  const candidates = [
    { key: "orderBy", value: profile?.orderBy, source: "orderBy", confidence: "medium" },
    { key: "platform", value: profile?.platform, source: "profile", confidence: "high" },
    { key: "service", value: profile?.service, source: "service", confidence: "high" },
    { key: "services", value: profile?.services, source: "service", confidence: "medium" },
    { key: "connectedServices", value: profile?.connectedServices, source: "service", confidence: "medium" },
    { key: "integrations", value: profile?.integrations, source: "service", confidence: "medium" },
    { key: "imports", value: profile?.imports, source: "import", confidence: "medium" },
    { key: "importSource", value: profile?.importSource, source: "import", confidence: "high" },
    { key: "musicService", value: profile?.musicService, source: "service", confidence: "high" },
    { key: "streamingService", value: profile?.streamingService, source: "service", confidence: "high" },
    { key: "settings", value: profile?.settings, source: "profile", confidence: "medium" },
    { key: "serviceSettings", value: profile?.serviceSettings, source: "service", confidence: "medium" },
    { key: "hasImported", value: profile?.hasImported, source: "import", confidence: "low" }
  ] as const;

  for (const candidate of candidates) {
    for (const rawValue of extractTextValues(candidate.value)) {
      const platform = normalizeServicePlatform(rawValue);
      if (platform === "unknown") continue;
      return {
        primary: platform,
        confidence: candidate.confidence as ServiceConfidence,
        source: candidate.source,
        sourceKey: candidate.key,
        rawValue
      };
    }
  }

  return {
    primary: "unknown" as ServicePlatform,
    confidence: "low" as ServiceConfidence,
    source: "unknown",
    sourceKey: null,
    rawValue: null
  };
}

export function extractServiceCandidate(obj: any) {
  if (!obj || typeof obj !== "object") {
    return {
      platform: "unknown" as ServicePlatform,
      confidence: "low" as ServiceConfidence,
      sourceKey: null as string | null,
      rawValue: null as string | null
    };
  }

  for (const key of SERVICE_CANDIDATE_KEYS) {
    const sourceValue = obj?.[key];
    if (sourceValue == null) continue;

    const candidates = extractTextValues(sourceValue);

    for (const candidate of candidates) {
      const platform = normalizeServicePlatform(candidate);
      if (platform === "unknown") continue;

      const isPrimaryKey =
        key === "service" ||
        key === "platform" ||
        key === "provider" ||
        key === "musicService" ||
        key === "streamingService";

      return {
        platform,
        confidence: (isPrimaryKey ? "high" : "medium") as ServiceConfidence,
        sourceKey: key,
        rawValue: candidate
      };
    }
  }

  return {
    platform: "unknown" as ServicePlatform,
    confidence: "low" as ServiceConfidence,
    sourceKey: null as string | null,
    rawValue: null as string | null
  };
}


export function normalizeArtist(artist: any) {
  const externalIds = normalizeExternalIds(artist);
  const spotifyId = pickFirstNonEmpty(artist?.spotifyId, externalIds.spotify[0]);
  const appleMusicId = pickFirstNonEmpty(artist?.appleMusicId, externalIds.appleMusic[0]);

  return {
    id: artist?.id ?? null,
    name: artist?.name ?? null,
    image: normalizeImage(artist),
    followers: asNumber(artist?.followers),
    genres: asArray(artist?.genres),
    spotifyPopularity: asNumber(artist?.spotifyPopularity),
    externalIds,
    spotifyId,
    appleMusicId,
    catalogAvailability: {
      spotify: externalIds.spotify.length > 0 || !!spotifyId,
      appleMusic: externalIds.appleMusic.length > 0 || !!appleMusicId
    },
    rawAvailableKeys: artist && typeof artist === "object" ? Object.keys(artist) : []
  };
}

function normalizedText(value: unknown) {
  return typeof value === "string"
    ? value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim()
    : "";
}

function sameArtist(a: any, b: any) {
  if (!a || !b) return false;

  const aId = asString(a?.id);
  const bId = asString(b?.id);
  if (aId && bId && aId === bId) return true;

  const aName = normalizedText(a?.name);
  const bName = normalizedText(b?.name);
  return Boolean(aName && bName && aName === bName);
}

function pickAlbumOwner(album: any) {
  if (!album || typeof album !== "object") return null;

  if (album.artist && typeof album.artist === "object") {
    return normalizeArtist(album.artist);
  }

  const firstArtist = Array.isArray(album.artists) ? album.artists.find(Boolean) : null;
  if (firstArtist && typeof firstArtist === "object") {
    return normalizeArtist(firstArtist);
  }

  if (album.primaryArtist && typeof album.primaryArtist === "object") {
    return normalizeArtist(album.primaryArtist);
  }

  const name = pickFirstNonEmpty(
    album.primaryArtistName,
    album.artistName,
    typeof album.artist === "string" ? album.artist : null,
    typeof firstArtist === "string" ? firstArtist : null
  );
  const id = pickFirstNonEmpty(album.primaryArtistId, album.artistId);

  return name || id ? normalizeArtist({ id: id ?? null, name: name ?? null }) : null;
}

function pickPrimaryArtist(artists: any[], album: any, rawArtists: any[] = []) {
  if (artists.length === 0) return null;

  const albumCandidates = [
    album?.artist,
    ...(Array.isArray(album?.artists) ? album.artists : []),
  ].filter(Boolean);

  for (const candidate of albumCandidates) {
    const normalizedCandidate = typeof candidate === "string"
      ? { id: null, name: candidate }
      : normalizeArtist(candidate);
    const match = artists.find((artist) => sameArtist(artist, normalizedCandidate));
    if (match) return match;
  }

  const markedRawArtist = rawArtists.find((artist: any) =>
    artist?.isMainArtist === true ||
    artist?.isPrimary === true ||
    artist?.role === "main" ||
    artist?.role === "primary"
  );
  if (markedRawArtist) {
    const normalizedMarked = normalizeArtist(markedRawArtist);
    const match = artists.find((artist) => sameArtist(artist, normalizedMarked));
    if (match) return match;
  }

  return artists[0];
}

export function normalizeAlbum(album: any) {
  const externalIds = normalizeExternalIds(album);
  const spotifyId = pickFirstNonEmpty(album?.spotifyId, externalIds.spotify[0]);
  const appleMusicId = pickFirstNonEmpty(album?.appleMusicId, externalIds.appleMusic[0]);

  const artists = Array.isArray(album?.artists)
    ? album.artists.map((artist: any) => normalizeArtist(artist))
    : [];
  const primaryArtist = artists[0] ?? pickAlbumOwner(album);

  return {
    id: album?.id ?? null,
    name: album?.name ?? null,
    type: album?.type ?? null,
    image: normalizeImage(album),
    label: album?.label ?? null,
    releaseDate: album?.releaseDate ?? null,
    genres: asArray(album?.genres),
    totalTracks: asNumber(pickFirstNonEmpty(album?.totalTracks, album?.total_tracks)),
    spotifyPopularity: asNumber(album?.spotifyPopularity),
    artist: album?.artist?.name ?? album?.artists?.[0]?.name ?? primaryArtist?.name ?? null,
    artists,
    artistId: album?.artist?.id ?? album?.artists?.[0]?.id ?? primaryArtist?.id ?? null,
    artistName: album?.artist?.name ?? album?.artists?.[0]?.name ?? primaryArtist?.name ?? null,
    primaryArtist,
    primaryArtistId: primaryArtist?.id ?? null,
    primaryArtistName: primaryArtist?.name ?? null,
    externalIds,
    spotifyId,
    appleMusicId,
    catalogAvailability: {
      spotify: externalIds.spotify.length > 0 || !!spotifyId,
      appleMusic: externalIds.appleMusic.length > 0 || !!appleMusicId
    },
    rawAvailableKeys: album && typeof album === "object" ? Object.keys(album) : []
  };
}

function albumLookupKeys(album: any) {
  const keys = new Set<string>();
  if (!album || typeof album !== "object") return keys;

  const id = asString(album.id);
  if (id) keys.add(`id:${id}`);

  const externalIds = normalizeExternalIds(album);
  for (const spotifyId of externalIds.spotify) keys.add(`spotify:${spotifyId}`);
  for (const appleMusicId of externalIds.appleMusic) keys.add(`appleMusic:${appleMusicId}`);

  const name = normalizedText(album.name);
  if (name) keys.add(`name:${name}`);

  return keys;
}

function topAlbumValue(item: any) {
  return item?.album ?? item;
}

function topTrackValue(item: any) {
  return item?.track ?? item;
}

function albumNeedsOwner(album: any) {
  return album && typeof album === "object" && !pickAlbumOwner(album);
}

export function enrichTopTracksWithAlbumOwners(trackItems: any[], albumItems: any[] = []) {
  if (!Array.isArray(trackItems) || trackItems.length === 0) return [];

  const albumByKey = new Map<string, any>();
  const duplicateKeys = new Set<string>();

  for (const item of Array.isArray(albumItems) ? albumItems : []) {
    const album = topAlbumValue(item);
    const owner = pickAlbumOwner(album);
    if (!owner) continue;

    for (const key of albumLookupKeys(album)) {
      if (albumByKey.has(key)) duplicateKeys.add(key);
      albumByKey.set(key, album);
    }
  }

  for (const key of duplicateKeys) {
    if (key.startsWith("name:")) albumByKey.delete(key);
  }

  return trackItems.map((item) => {
    const track = topTrackValue(item);
    const album = track?.albums?.[0] || track?.album || null;
    if (!albumNeedsOwner(album)) return item;

    const matchedAlbum = [...albumLookupKeys(album)]
      .map((key) => albumByKey.get(key))
      .find(Boolean);
    const owner = pickAlbumOwner(matchedAlbum);
    if (!owner) return item;

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

    const enrichedTrack = {
      ...track,
      album: track?.album ? enrichedAlbum : track?.album,
      albums: Array.isArray(track?.albums)
        ? [enrichedAlbum, ...track.albums.slice(1)]
        : track?.albums,
    };

    if (item?.track) {
      return {
        ...item,
        track: enrichedTrack,
      };
    }

    return enrichedTrack;
  });
}

export function normalizeTrack(track: any) {
  const album = track?.albums?.[0] || track?.album || null;
  const trackExternalIds = normalizeExternalIds(track);
  const spotifyId = pickFirstNonEmpty(track?.spotifyId, trackExternalIds.spotify[0]);
  const appleMusicId = pickFirstNonEmpty(track?.appleMusicId, trackExternalIds.appleMusic[0]);

  const rawArtists = Array.isArray(track?.artists) ? track.artists : [];
  const artists = rawArtists.length > 0
    ? rawArtists.map((artist: any) => normalizeArtist(artist))
    : [];

  const normalizedAlbum = album ? normalizeAlbum(album) : null;
  const fallbackArtistName = pickFirstNonEmpty(
    track?.primaryArtistName,
    track?.artistName,
    typeof track?.artist === "string" ? track.artist : null,
    track?.artist?.name,
    album?.artistName,
    typeof album?.artist === "string" ? album.artist : null,
    album?.artist?.name,
    album?.primaryArtistName,
    album?.primaryArtist?.name
  );
  const fallbackArtistId = pickFirstNonEmpty(
    track?.primaryArtistId,
    track?.artistId,
    track?.artist?.id,
    album?.artistId,
    album?.artist?.id,
    album?.primaryArtistId,
    album?.primaryArtist?.id
  );
  const fallbackArtist = track?.primaryArtist && typeof track.primaryArtist === "object"
    ? normalizeArtist(track.primaryArtist)
    : fallbackArtistName || fallbackArtistId
      ? normalizeArtist({ id: fallbackArtistId ?? null, name: fallbackArtistName ?? null })
      : null;
  const primaryArtist = pickPrimaryArtist(artists, album, rawArtists) ?? fallbackArtist ?? pickAlbumOwner(album);
  const secondaryArtists = primaryArtist
    ? artists.filter((artist: any) => !sameArtist(artist, primaryArtist))
    : [];

  return {
    id: track?.id ?? null,
    name: track?.name ?? null,
    durationMs: normalizeDurationMs(
      pickFirstNonEmpty(track?.durationMs, track?.duration_ms, track?.trackDurationMs)
    ),
    spotifyPopularity: asNumber(track?.spotifyPopularity),
    explicit: track?.explicit ?? null,
    spotifyPreview: track?.spotifyPreview ?? null,
    appleMusicPreview: track?.appleMusicPreview ?? null,
    image: normalizeImage(album) ?? normalizeImage(track),
    artists,
    primaryArtist,
    secondaryArtists,
    primaryArtistId: primaryArtist?.id ?? null,
    primaryArtistName: primaryArtist?.name ?? null,
    artistIds: artists.map((artist: any) => artist?.id).filter(Boolean),
    album: normalizedAlbum,
    albumId: normalizedAlbum?.id ?? null,
    albumName: normalizedAlbum?.name ?? null,
    albumImage: normalizedAlbum?.image ?? normalizeImage(track),
    externalIds: trackExternalIds,
    spotifyId,
    appleMusicId,
    catalogAvailability: {
      spotify: trackExternalIds.spotify.length > 0 || !!spotifyId,
      appleMusic: trackExternalIds.appleMusic.length > 0 || !!appleMusicId
    },
    rawAvailableKeys: track && typeof track === "object" ? Object.keys(track) : []
  };
}

export function normalizeRecentItem(item: any) {
  const service = extractServiceCandidate(item);
  const track = normalizeTrack(item?.track);

  return {
    id: item?.id ?? null,
    playedAt: item?.endTime ?? item?.playedAt ?? null,
    endTime: item?.endTime ?? item?.playedAt ?? null,
    playedMs: normalizePlayedMs(item?.playedMs ?? item?.played_ms ?? null),
    durationMs: track?.durationMs ?? null,
    position: item?.position ?? null,
    streams: item?.streams ?? null,
    indicator: item?.indicator ?? null,
    trackId: track?.id ?? item?.trackId ?? null,
    trackName: track?.name ?? item?.trackName ?? null,
    platform: service.platform,
    platformConfidence: service.confidence,
    platformSourceKey: service.sourceKey,
    serviceCandidate: {
      platform: service.platform,
      confidence: service.confidence,
      sourceKey: service.sourceKey,
      rawValue: service.rawValue
    },
    track,
    rawAvailableKeys: item && typeof item === "object" ? Object.keys(item) : []
  };
}

export function normalizeTopItem(item: any, type: "artists" | "tracks" | "albums") {
  if (type === "artists") {
    return {
      ...normalizeArtist(item?.artist),
      streams: item?.streams ?? 0,
      playedMs: normalizePlayedMs(item?.playedMs ?? item?.played_ms ?? null),
      position: item?.position ?? null,
      indicator: item?.indicator ?? null
    };
  }

  if (type === "albums") {
    return {
      ...normalizeAlbum(item?.album),
      streams: item?.streams ?? 0,
      playedMs: normalizePlayedMs(item?.playedMs ?? item?.played_ms ?? null),
      position: item?.position ?? null,
      indicator: item?.indicator ?? null
    };
  }

  return {
    ...normalizeTrack(item?.track),
    streams: item?.streams ?? 0,
    playedMs: normalizePlayedMs(item?.playedMs ?? item?.played_ms ?? null),
    position: item?.position ?? null,
    indicator: item?.indicator ?? null
  };
}

export function normalizeUserSummary(user: any) {
  return {
    id: user?.id ?? null,
    customId: user?.customId ?? null,
    displayName: user?.displayName ?? user?.username ?? user?.name ?? null,
    username: user?.username ?? null,
    image: user?.image ?? null,
    isPlus: user?.isPlus ?? null,
    isPro: user?.isPro ?? null,
    orderBy: user?.orderBy ?? null,
    timezone: user?.timezone ?? null,
    recentlyActive: user?.recentlyActive ?? null,
    hasImported: user?.hasImported ?? null,
    syncEnabled: user?.syncEnabled ?? null,
    profile: user?.profile
      ? {
          bio: user.profile?.bio ?? null,
          pronouns: user.profile?.pronouns ?? null,
          theme: user.profile?.theme ?? null,
        }
      : null,
    privacySettings: user?.privacySettings ?? null,
    rawAvailableKeys: user && typeof user === "object" ? Object.keys(user) : []
  };
}

export function normalizeEntity(entity: any, type: "track" | "artist" | "album") {
  if (type === "track") return normalizeTrack(entity);
  if (type === "artist") return normalizeArtist(entity);
  return normalizeAlbum(entity);
}
