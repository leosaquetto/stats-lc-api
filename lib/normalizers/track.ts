import type { Track } from "../types.js";
import { normalizeAlbum } from "./album.js";
import { normalizeArtist } from "./artist.js";
export function normalizeTrack(track: any): Track {
  const album = track?.albums?.[0] || track?.album || null;
  return {
    id: track?.id ?? null,
    name: track?.name ?? null,
    artists: Array.isArray(track?.artists) ? track.artists.map(normalizeArtist) : [],
    album: album ? normalizeAlbum(album) : null,
    image: album?.image ?? null,
    spotifyId: track?.spotifyId ?? track?.externalIds?.spotify?.[0] ?? null,
    appleMusicId: track?.appleMusicId ?? track?.externalIds?.appleMusic?.[0] ?? null
  };
}
