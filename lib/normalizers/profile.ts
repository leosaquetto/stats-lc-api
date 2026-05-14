import type { UserProfile } from "../types.js";
export function normalizeProfile(profileData: any, fallback: string): UserProfile {
  return {
    displayName: profileData?.item?.displayName ?? profileData?.item?.username ?? profileData?.item?.name ?? fallback,
    username: profileData?.item?.username ?? null,
    image: profileData?.item?.image ?? null
  };
}
