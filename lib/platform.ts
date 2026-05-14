import { extractServiceCandidate } from "./normalize.js";

type PlatformPrimary = "appleMusic" | "spotify" | "unknown";
type PlatformSource = "profile" | "recentItem" | "unknown";
type PlatformConfidence = "high" | "medium" | "low";

export type PlatformDecision = {
  primary: PlatformPrimary;
  source: PlatformSource;
  confidence: PlatformConfidence;
  profileServiceCandidate: ReturnType<typeof extractServiceCandidate>;
  recentItemServiceCandidate: ReturnType<typeof extractServiceCandidate>;
};

export function resolvePlatform({
  profileItem,
  recentItem,
}: {
  profileItem: any;
  recentItem: any;
}): PlatformDecision {
  const profileServiceCandidate = extractServiceCandidate(profileItem);
  const recentItemServiceCandidate = extractServiceCandidate(recentItem);

  if (recentItemServiceCandidate.platform !== "unknown") {
    return {
      primary: recentItemServiceCandidate.platform,
      source: "recentItem",
      confidence: "high",
      profileServiceCandidate,
      recentItemServiceCandidate,
    };
  }

  if (profileServiceCandidate.platform !== "unknown") {
    return {
      primary: profileServiceCandidate.platform,
      source: "profile",
      confidence: "medium",
      profileServiceCandidate,
      recentItemServiceCandidate,
    };
  }

  return {
    primary: "unknown",
    source: "unknown",
    confidence: "low",
    profileServiceCandidate,
    recentItemServiceCandidate,
  };
}
