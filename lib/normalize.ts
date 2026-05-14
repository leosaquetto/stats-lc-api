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
    spotifyId:
      track?.spotifyId ??
      track?.externalIds?.spotify?.[0] ??
      null,
    appleMusicId:
      track?.appleMusicId ??
      track?.externalIds?.appleMusic?.[0] ??
      null
  };
}

export function normalizeRecentItem(item: any) {
  return {
    playedAt: item?.endTime ?? item?.playedAt ?? null,
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