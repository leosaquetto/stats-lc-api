import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveUserId } from "../users.js";
import {
  fetchUserDatesFallbackFromStreams,
  fetchUserDatesRange,
  normalizeDatesSummary,
} from "../user-stats-service.js";
import { sendJsonError, setCacheHeaders, setCorsHeaders } from "../api-helpers.js";

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
  const fetchOptions = lifetime
    ? {
        force: false,
        aggregateMode: "none" as const,
        cacheProfile: "heavy" as const,
        requestTimeoutMs: 6500,
        maxRetries: 0,
      }
    : { force };

  try {
    const result = await fetchUserDatesRange(userId, after, before, fetchOptions);

    if (!result.ok) {
      if (result.status === 404) {
        const fallback = await fetchUserDatesFallbackFromStreams(userId, after, before, fetchOptions);
        if (fallback.ok) {
          setCorsHeaders(res);
          setCacheHeaders(res, lifetime ? 900 : 120, lifetime ? false : force, lifetime ? 86400 : 720);
          return res.status(200).json({
            ok: true,
            user,
            userId,
            endpoint: result.endpoint,
            empty: fallback.coverage.aggregatedCount === 0,
            reason: "streams_fallback",
            ...normalizeDatesSummary(fallback),
            coverage: fallback.coverage,
          });
        }

        setCorsHeaders(res);
        setCacheHeaders(res, lifetime ? 900 : 120, lifetime ? false : force, lifetime ? 86400 : 720);
        return res.status(200).json({
          ok: true,
          user,
          userId,
          endpoint: result.endpoint,
          empty: true,
          reason: "upstream_not_found",
          ...normalizeDatesSummary({ items: {} }),
          coverage: {
            source: "unavailable",
            totalCount: 0,
            requestedCount: 0,
            aggregatedCount: 0,
            partial: false,
          },
        });
      }

      return sendJsonError(res, result.status === 504 ? 503 : result.status || 502, "upstream_error", {
        endpoint: result.endpoint,
        upstreamStatus: result.status,
      });
    }

    setCorsHeaders(res);
    setCacheHeaders(res, lifetime ? 900 : 120, lifetime ? false : force, lifetime ? 86400 : 720);
    return res.status(200).json({
      ok: true,
      user,
      userId,
      endpoint: result.endpoint,
      ...normalizeDatesSummary(result.data),
    });
  } catch (error: any) {
    return sendJsonError(res, 503, "stats_dates_fetch_failed", {
      user,
      userId,
      after,
      message: error?.message ?? String(error),
    });
  }
}
