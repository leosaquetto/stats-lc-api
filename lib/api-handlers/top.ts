import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveUserId } from "../users.js";
import { fetchUserTop, normalizeTopItems } from "../user-tops-service.js";
import { sendJsonError, setCacheHeaders } from "../api-helpers.js";

function getAfterFromPeriod(period: string) {
  const now = new Date();

  if (period === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  if (period === "week") {
    return Date.now() - 7 * 24 * 60 * 60 * 1000;
  }

  if (period === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }

  return 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const type = String(req.query.type || "tracks") as "artists" | "tracks" | "albums";
  const period = String(req.query.period || "week");
  const limit = Number(req.query.limit || 20);
  const force = req.query.force === "1";

  if (!user) {
    return sendJsonError(res, 400, "missing_user");
  }

  if (!["artists", "tracks", "albums"].includes(type)) {
    return sendJsonError(res, 400, "invalid_type");
  }

  const userId = resolveUserId(user);
  const after = req.query.after ? Number(req.query.after) : getAfterFromPeriod(period);
  const upstreamForce = force && after !== 0;

  try {
    const result = await fetchUserTop(userId, type, after, limit, { force: upstreamForce });

    if (!result.ok) {
      return sendJsonError(res, result.status || 502, "upstream_error", {
        endpoint: result.endpoint,
        upstreamStatus: result.status,
      });
    }

    const albumResult = type === "tracks"
      ? await fetchUserTop(userId, "albums", after, limit, { force: upstreamForce })
      : null;
    const items = await normalizeTopItems(result.data, type, {
      force: upstreamForce,
      albumItems: albumResult?.ok ? (albumResult.data as any)?.items : [],
      userId,
      after,
    });

    setCacheHeaders(res, after === 0 ? 900 : 300, upstreamForce, after === 0 ? 86400 : 1800);

    return res.status(200).json({
      ok: true,
      user,
      userId,
      type,
      period,
      after,
      endpoint: result.endpoint,
      items,
    });
  } catch (error: any) {
    return sendJsonError(res, 503, "top_fetch_failed", {
      user,
      userId,
      type,
      after,
      message: error?.message ?? String(error),
    });
  }
}
