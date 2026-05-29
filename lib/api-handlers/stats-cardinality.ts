import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveUserId } from "../users.js";
import { fetchUserStatsRange, normalizeStatsCardinality } from "../user-stats-service.js";
import { sendJsonError, setCacheHeaders } from "../api-helpers.js";

function isLifetimeRequest(after: string) {
  return after === "0";
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const after = String(req.query.after || "");
  const before = req.query.before ? String(req.query.before) : "";
  const force = req.query.force === "1";

  if (!user || !after) {
    return sendJsonError(res, 400, "missing_user_or_after");
  }

  const userId = resolveUserId(user);
  const lifetime = isLifetimeRequest(after);

  try {
    const result = await fetchUserStatsRange(userId, after, before, {
      force: lifetime ? false : force,
      aggregateMode: "none",
      cacheProfile: lifetime ? "heavy" : "default",
      requestTimeoutMs: lifetime ? 6500 : undefined,
      maxRetries: lifetime ? 0 : undefined,
    });

    if (!result.ok) {
      return sendJsonError(res, result.status === 504 ? 503 : result.status || 502, "upstream_error", {
        endpoint: result.endpoint,
        upstreamStatus: result.status,
      });
    }

    setCacheHeaders(res, lifetime ? 900 : 120, lifetime ? false : force, lifetime ? 86400 : 720);
    return res.status(200).json({
      ok: true,
      user,
      userId,
      endpoint: result.endpoint,
      ...normalizeStatsCardinality(result.data),
    });
  } catch (error: any) {
    return sendJsonError(res, 503, "stats_cardinality_fetch_failed", {
      user,
      userId,
      after,
      message: error?.message ?? String(error),
    });
  }
}
