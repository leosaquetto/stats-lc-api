import type { Artist } from "../types.js";
export function normalizeArtist(artist: any): Artist {
  return { id: artist?.id ?? null, name: artist?.name ?? null, image: artist?.image ?? null };
}
