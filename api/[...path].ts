import type { VercelRequest, VercelResponse } from "@vercel/node";
import albumTracksHandler from "../lib/api-handlers/album-tracks.js";
import artistCatalogHandler from "../lib/api-handlers/artist-catalog.js";
import compareHandler from "../lib/api-handlers/compare.js";
import entityGroupStatsHandler from "../lib/api-handlers/entity-group-stats.js";
import entityListenersHandler from "../lib/api-handlers/entity-listeners.js";
import entityStatsHandler from "../lib/api-handlers/entity-stats.js";
import entityStreamsHandler from "../lib/api-handlers/entity-streams.js";
import entityHandler from "../lib/api-handlers/entity.js";
import groupLiveHandler from "../lib/api-handlers/group-live.js";
import groupHandler from "../lib/api-handlers/group.js";
import healthHandler from "../lib/api-handlers/health.js";
import recentHandler from "../lib/api-handlers/recent.js";
import replayHandler from "../lib/api-handlers/replay.js";
import searchHandler from "../lib/api-handlers/search.js";
import statsCardinalityHandler from "../lib/api-handlers/stats-cardinality.js";
import statsDatesHandler from "../lib/api-handlers/stats-dates.js";
import statsHandler from "../lib/api-handlers/stats.js";
import topHandler from "../lib/api-handlers/top.js";
import userFriendsHandler from "../lib/api-handlers/user-friends.js";
import userStreamsHandler from "../lib/api-handlers/user-streams.js";
import userHandler from "../lib/api-handlers/user.js";
import { sendJsonError, setCorsHeaders } from "../lib/api-helpers.js";

type Handler = (req: VercelRequest, res: VercelResponse) => unknown;

const ROUTES: Record<string, Handler> = {
  "album-tracks": albumTracksHandler,
  "artist-catalog": artistCatalogHandler,
  compare: compareHandler,
  "entity-group-stats": entityGroupStatsHandler,
  "entity-listeners": entityListenersHandler,
  "entity-stats": entityStatsHandler,
  "entity-streams": entityStreamsHandler,
  entity: entityHandler,
  "group-live": groupLiveHandler,
  group: groupHandler,
  health: healthHandler,
  recent: recentHandler,
  replay: replayHandler,
  search: searchHandler,
  "stats-cardinality": statsCardinalityHandler,
  "stats-dates": statsDatesHandler,
  stats: statsHandler,
  top: topHandler,
  "user-friends": userFriendsHandler,
  "user-streams": userStreamsHandler,
  user: userHandler,
};

function readRoutePath(value: unknown) {
  if (Array.isArray(value)) return value.join("/");
  return value == null ? "" : String(value);
}

function getRoutePath(req: VercelRequest) {
  const queryPath = readRoutePath(req.query.path || req.query["...path"]);
  if (queryPath) return queryPath.replace(/^\/+|\/+$/g, "");

  const url = typeof req.url === "string" ? req.url : "";
  return url
    .split("?")[0]
    .replace(/^\/api\/?/, "")
    .replace(/^\/+|\/+$/g, "");
}

export default function handler(req: VercelRequest, res: VercelResponse) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const routePath = getRoutePath(req);
  const route = ROUTES[routePath];

  if (!route) {
    return sendJsonError(res, 404, "not_found", { path: routePath });
  }

  try {
    return Promise.resolve(route(req, res)).catch((error: any) =>
      sendJsonError(res, 500, "handler_failed", {
        path: routePath,
        message: error?.message ?? String(error),
      })
    );
  } catch (error: any) {
    return sendJsonError(res, 500, "handler_failed", {
      path: routePath,
      message: error?.message ?? String(error),
    });
  }
}
