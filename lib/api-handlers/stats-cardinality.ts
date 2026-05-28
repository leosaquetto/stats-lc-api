import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveUserId } from "../users.js";
import { fetchUserStatsRange, normalizeStatsCardinality } from "../user-stats-service.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const after = String(req.query.after || "");
  const before = req.query.before ? String(req.query.before) : "";
  const force = req.query.force === "1";

  if (!user || !after) {
    return res.status(400).json({ ok: false, error: "missing_user_or_after" });
  }

  const userId = resolveUserId(user);

  const result = await fetchUserStatsRange(userId, after, before, {
    force,
    aggregateMode: "none",
  });

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  res.status(200).json({
    ok: true,
    user,
    userId,
    endpoint: result.endpoint,
    ...normalizeStatsCardinality(result.data),
  });
}
