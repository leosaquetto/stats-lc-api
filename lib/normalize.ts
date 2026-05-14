import { normalizeTrack } from "./normalizers/track.js";

export function normalizeRecentItem(item: any) {
  return { playedAt: item?.endTime ?? item?.playedAt ?? null, track: normalizeTrack(item?.track) };
}

export function normalizeTopItem(item: any, type: "artists" | "tracks" | "albums") {
  if (type === "artists") return { id: item?.artist?.id ?? null, name: item?.artist?.name ?? null, image: item?.artist?.image ?? null, streams: item?.streams ?? 0 };
  if (type === "albums") return { id: item?.album?.id ?? null, name: item?.album?.name ?? null, artist: item?.album?.artist?.name ?? item?.album?.artists?.[0]?.name ?? null, image: item?.album?.image ?? null, streams: item?.streams ?? 0 };
  return { ...normalizeTrack(item?.track), streams: item?.streams ?? 0 };
}
