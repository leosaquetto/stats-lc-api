import type { VercelRequest, VercelResponse } from "@vercel/node";
import albumTracksHandler from "../lib/api-handlers/album-tracks.js";
import artistCatalogHandler from "../lib/api-handlers/artist-catalog.js";
import compareHandler from "../lib/api-handlers/compare.js";
import entityGroupStatsHandler from "../lib/api-handlers/entity-group-stats.js";
import entityListenersHandler from "../lib/api-handlers/entity-listeners.js";
import entityStatsHandler from "../lib/api-handlers/entity-stats.js";
import entityStreamsHandler from "../lib/api-handlers/entity-streams.js";
import entityHandler from "../lib/api-handlers/entity.js";
import groupActivityHandler from "../lib/api-handlers/group-activity.js";
import groupLiveHandler from "../lib/api-handlers/group-live.js";
import groupHandler from "../lib/api-handlers/group.js";
import healthHandler from "../lib/api-handlers/health.js";
import latestDiscoveryHandler from "../lib/api-handlers/latest-discovery.js";
import lyricsHandler from "../lib/api-handlers/lyrics.js";
import orbitsHandler from "../lib/api-handlers/orbits.js";
import recentHandler from "../lib/api-handlers/recent.js";
import replayHandler from "../lib/api-handlers/replay.js";
import searchHandler from "../lib/api-handlers/search.js";
import statsCardinalityHandler from "../lib/api-handlers/stats-cardinality.js";
import statsDatesHandler from "../lib/api-handlers/stats-dates.js";
import statsHandler from "../lib/api-handlers/stats.js";
import simultaneousHandler from "../lib/api-handlers/simultaneous.js";
import topHandler from "../lib/api-handlers/top.js";
import userFriendsHandler from "../lib/api-handlers/user-friends.js";
import userStreamsHandler from "../lib/api-handlers/user-streams.js";
import userHandler from "../lib/api-handlers/user.js";
import { sendJsonError, setCorsHeaders } from "../lib/api-helpers.js";
import { randomUUID } from "node:crypto";

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
  "group-activity": groupActivityHandler,
  "group-live": groupLiveHandler,
  group: groupHandler,
  health: healthHandler,
  "latest-discovery": latestDiscoveryHandler,
  lyrics: lyricsHandler,
  orbits: orbitsHandler,
  recent: recentHandler,
  replay: replayHandler,
  search: searchHandler,
  "stats-cardinality": statsCardinalityHandler,
  "stats-dates": statsDatesHandler,
  stats: statsHandler,
  simultaneous: simultaneousHandler,
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
  const startedAt = performance.now();
  const requestId = String(req.headers["x-request-id"] || randomUUID());
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
    if (!res.headersSent) {
      res.setHeader("Server-Timing", `app;dur=${durationMs}`);
      res.setHeader("X-App-Timing", `app;dur=${durationMs}`);
    }
    console.info(JSON.stringify({
      event: "api_request",
      requestId,
      method: req.method || "GET",
      route: getRoutePath(req) || "unknown",
      status: res.statusCode,
      durationMs,
    }));
  };
  const originalJson = res.json.bind(res);
  const originalEnd = res.end.bind(res);
  res.json = ((body: any) => {
    finalize();
    return originalJson(body);
  }) as typeof res.json;
  res.end = ((...args: Parameters<typeof res.end>) => {
    finalize();
    return originalEnd(...args);
  }) as typeof res.end;

  setCorsHeaders(res);
  res.setHeader("X-Request-Id", requestId);
  // Set the header before dispatch so Vercel preserves it even when a response
  // helper commits headers before our json/end wrappers run.
  res.setHeader("Server-Timing", "app;dur=0");
  res.setHeader("X-App-Timing", "app;dur=0");

  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  const routePath = getRoutePath(req);
  const [routeName, routeId, routeAction] = routePath.split("/");
  if (routeName === "orbits" && routeId) {
    if (routeId === "summary") {
      req.query.action = "summary";
    } else {
      req.query.id = routeId;
      req.query.pathAction = routeAction || "";
    }
  }

  const route = ROUTES[routePath] || ROUTES[routeName];

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
