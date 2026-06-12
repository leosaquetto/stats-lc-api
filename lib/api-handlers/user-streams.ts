import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  readOptionalQueryString,
  readQueryString,
  sendJsonError,
  setCacheHeaders,
} from "../api-helpers.js";
import { fetchLocalHistoryStreams } from "../history-local.js";
import { resolveHistoryUser } from "../history-backup.js";
import { fetchUserStreams, normalizeStreamItems } from "../user-streams-service.js";
import { fetchUserTop } from "../user-tops-service.js";
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
    let localHistory: Awaited<ReturnType<typeof fetchLocalHistoryStreams>> = null;
    if (!force && params.after && params.before) {
      const afterMs = Number(params.after);
      const beforeMs = Number(params.before);
      try {
        const historyUser = resolveHistoryUser(user);
        localHistory = await fetchLocalHistoryStreams({
          userKey: historyUser.key,
          afterMs,
          beforeMs,
          limit: params.limit ? Number(params.limit) : undefined,
          offset: params.offset ? Number(params.offset) : undefined,
          order: "desc",
        });
      } catch {
        localHistory = null;
      }
    }

    const albumItems = resolveAlbums
      ? await fetchUserTop(userId, "albums", params.after ? Number(params.after) : Date.now() - 30 * 24 * 60 * 60 * 1000, 50, { force: upstreamForce })
          .then(r => r.ok ? (r.data as any)?.items || [] : [])
      : [];

    if (localHistory?.ok) {
      setCacheHeaders(res, resolveAlbums ? 600 : 300, false, resolveAlbums ? 3600 : 1800);
      return res.status(200).json({
        ok: true,
        user,
        userId,
        endpoint: "history_store",
        source: localHistory.source,
        coverage: {
          complete: true,
          missingMonths: [],
        },
        total: localHistory.total,
        items: await normalizeStreamItems({ items: localHistory.items }, {
          force: false,
          userId,
          useTrackStreamEvidence: resolveAlbums,
          trackStreamEvidenceStrategy: "latest",
          albumItems,
        }),
      });
    }

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
      source: "stats.fm-api",
      ...(localHistory
        ? {
            coverage: {
              complete: false,
              missingMonths: localHistory.missingMonths,
            },
          }
        : {}),
      items: await normalizeStreamItems(result.data, {
        force: upstreamForce,
        userId,
        useTrackStreamEvidence: resolveAlbums,
        trackStreamEvidenceStrategy: "latest",
        albumItems,
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
