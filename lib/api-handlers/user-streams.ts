import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  readOptionalQueryString,
  readQueryString,
  sendJsonError,
  setCacheHeaders,
} from "../api-helpers.js";
import { fetchUserStreams, normalizeStreamItems } from "../user-streams-service.js";
import { resolveUserId } from "../users.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = readQueryString(req.query.user);
  const force = req.query.force === "1";
  const resolveAlbums = req.query.resolveAlbums === "1";

  if (!user) {
    return sendJsonError(res, 400, "missing_user");
  }

  const userId = resolveUserId(user);
  const params = {
    limit: readOptionalQueryString(req.query.limit),
    offset: readOptionalQueryString(req.query.offset),
    after: readOptionalQueryString(req.query.after),
    before: readOptionalQueryString(req.query.before),
  };

  const limit = Number(params.limit || 0);
  const upstreamForce = force && limit <= 50;

  try {
    const result = await fetchUserStreams(userId, params, { force: upstreamForce });

    if (!result.ok) {
      return sendJsonError(res, result.status || 502, "upstream_error", {
        endpoint: result.endpoint,
        upstreamStatus: result.status,
      });
    }

    setCacheHeaders(res, resolveAlbums ? 600 : 300, upstreamForce, resolveAlbums ? 3600 : 1800);

    return res.status(200).json({
      ok: true,
      user,
      userId,
      endpoint: result.endpoint,
      items: await normalizeStreamItems(result.data, {
        force: upstreamForce,
        userId,
        useTrackStreamEvidence: resolveAlbums,
      }),
    });
  } catch (error: any) {
    return sendJsonError(res, 503, "user_streams_failed", {
      user,
      userId,
      message: error?.message ?? String(error),
    });
  }
}
