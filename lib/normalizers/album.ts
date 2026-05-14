import type { Album } from "../types.js";
export function normalizeAlbum(album: any): Album {
  return { id: album?.id ?? null, name: album?.name ?? null, image: album?.image ?? null, artist: album?.artist?.name ?? album?.artists?.[0]?.name ?? null };
}
