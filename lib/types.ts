export type Artist = { id: string | null; name: string | null; image?: string | null };
export type Album = { id: string | null; name: string | null; image: string | null; artist: string | null };
export type Track = {
  id: string | null;
  name: string | null;
  artists: Artist[];
  album: Album | null;
  image: string | null;
  spotifyId: string | null;
  appleMusicId: string | null;
};
export type UserProfile = { displayName: string; username: string | null; image: string | null };
export type StreamStats = { streams: number; durationMs: number; minutes: number; hours?: number };
export type GroupMember = {
  key: string;
  id: string;
  profile: UserProfile;
  nowPlaying?: { playedAt: string | null; track: Track } | null;
  recent?: Array<{ playedAt: string | null; track: Track }>;
  stats?: { today: StreamStats; week: StreamStats; month: StreamStats };
};
export type RankingItem = {
  position: number;
  key: string;
  id: string;
  displayName: string;
  image: string | null;
  streams: number;
};
