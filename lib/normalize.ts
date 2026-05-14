type ServicePlatform = "appleMusic" | "spotify" | "unknown";
type ServiceConfidence = "high" | "medium" | "low";

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

export function normalizeTrack(track: any) {
  const album = track?.albums?.[0] || track?.album || null;

  return {
    id: track?.id ?? null,
    name: track?.name ?? null,
    artists: Array.isArray(track?.artists)
      ? track.artists.map((artist: any) => ({
          id: artist?.id ?? null,
          name: artist?.name ?? null
        }))
      : [],
    album: album
      ? {
          id: album?.id ?? null,
          name: album?.name ?? null,
          image: album?.image ?? null,
          artist: album?.artist?.name ?? album?.artists?.[0]?.name ?? null
        }
      : null,
    image: album?.image ?? null,
    spotifyId: track?.spotifyId ?? track?.externalIds?.spotify?.[0] ?? null,
    appleMusicId: track?.appleMusicId ?? track?.externalIds?.appleMusic?.[0] ?? null
  };
}

export function normalizeRecentItem(item: any) {
  const service = extractServiceCandidate(item);

  return {
    playedAt: item?.endTime ?? item?.playedAt ?? null,
    platform: service.platform,
    platformConfidence: service.confidence,
    platformSourceKey: service.sourceKey,
    track: normalizeTrack(item?.track)
  };
}

export function normalizeTopItem(item: any, type: "artists" | "tracks" | "albums") {
  if (type === "artists") {
    return {
      id: item?.artist?.id ?? null,
      name: item?.artist?.name ?? null,
      image: item?.artist?.image ?? null,
      streams: item?.streams ?? 0
    };
  }

  if (type === "albums") {
    const album = item?.album;
    return {
      id: album?.id ?? null,
      name: album?.name ?? null,
      artist: album?.artist?.name ?? album?.artists?.[0]?.name ?? null,
      image: album?.image ?? null,
      streams: item?.streams ?? 0
    };
  }

  return {
    ...normalizeTrack(item?.track),
    streams: item?.streams ?? 0
  };
}
