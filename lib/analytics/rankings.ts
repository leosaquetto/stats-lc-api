import type { GroupMember, RankingItem } from "../types.js";

export function buildRanking(members: GroupMember[], period: "today" | "week" | "month"): RankingItem[] {
  return [...members]
    .sort((a: any, b: any) => (b?.stats?.[period]?.streams ?? 0) - (a?.stats?.[period]?.streams ?? 0))
    .map((member, index) => ({
      position: index + 1,
      key: member.key,
      id: member.id,
      displayName: member.profile?.displayName ?? member.key,
      image: member.profile?.image ?? null,
      streams: (member as any).stats?.[period]?.streams ?? 0
    }));
}
