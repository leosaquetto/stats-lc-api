import { USERS, type UserKey } from "./users";

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

export function normalizeAlbum(album: any) {
  const externalIds = normalizeExternalIds(album);
  const spotifyId = pickFirstNonEmpty(album?.spotifyId, externalIds.spotify[0]);
  const appleMusicId = pickFirstNonEmpty(album?.appleMusicId, externalIds.appleMusic[0]);

  return {
    id: album?.id ?? null,
    name: album?.name ?? null,
    type: album?.type ?? null,
    image: normalizeImage(album),
    totalTracks: asNumber(pickFirstNonEmpty(album?.totalTracks, album?.total_tracks)),
    spotifyPopularity: asNumber(album?.spotifyPopularity),
    artist: album?.artist?.name ?? album?.artists?.[0]?.name ?? null,
    artists: Array.isArray(album?.artists)
      ? album.artists.map((artist: any) => normalizeArtist(artist))
      : [],
    artistId: album?.artist?.id ?? album?.artists?.[0]?.id ?? null,
    artistName: album?.artist?.name ?? album?.artists?.[0]?.name ?? null,
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

export function normalizeTrack(track: any) {
  const album = track?.albums?.[0] || track?.album || null;
  const trackExternalIds = normalizeExternalIds(track);
  const spotifyId = pickFirstNonEmpty(track?.spotifyId, trackExternalIds.spotify[0]);
  const appleMusicId = pickFirstNonEmpty(track?.appleMusicId, trackExternalIds.appleMusic[0]);

  const artists = Array.isArray(track?.artists)
    ? track.artists.map((artist: any) => normalizeArtist(artist))
    : [];

  const normalizedAlbum = album ? normalizeAlbum(album) : null;

  return {
    id: track?.id ?? null,
    name: track?.name ?? null,
    durationMs: normalizeDurationMs(
      pickFirstNonEmpty(track?.durationMs, track?.duration_ms, track?.duration, track?.trackDurationMs)
    ),
    spotifyPopularity: asNumber(track?.spotifyPopularity),
    explicit: track?.explicit ?? null,
    image: normalizeImage(album),
    artists,
    artistIds: artists.map((artist: any) => artist?.id).filter(Boolean),
    album: normalizedAlbum,
    albumId: normalizedAlbum?.id ?? null,
    albumName: normalizedAlbum?.name ?? null,
    albumImage: normalizedAlbum?.image ?? null,
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
    trackId: track?.id ?? null,
    trackName: track?.name ?? null,
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
      streams: item?.streams ?? 0
    };
  }

  if (type === "albums") {
    return {
      ...normalizeAlbum(item?.album),
      streams: item?.streams ?? 0
    };
  }

  return {
    ...normalizeTrack(item?.track),
    streams: item?.streams ?? 0
  };
}
