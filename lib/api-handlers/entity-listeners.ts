import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildQuery,
  encodeSegment,
  ENTITY_ROUTE_MAP,
  getItems,
  readEntityType,
  readOptionalQueryString,
  readQueryString,
} from "../api-helpers.js";
import { normalizePlayedMs, normalizeUserSummary } from "../normalize.js";
import { statsfmFetch } from "../statsfm.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const type = readEntityType(req.query.type);
  const id = readQueryString(req.query.id);
  const force = req.query.force === "1";

  if (!type || !id) {
    return res.status(400).json({ ok: false, error: "missing_type_or_id" });
  }

  const query = buildQuery({
    friends: req.query.friends === "1" ? "true" : null,
    limit: readOptionalQueryString(req.query.limit),
    offset: readOptionalQueryString(req.query.offset),
  });

  const result = await statsfmFetch(
    `/${ENTITY_ROUTE_MAP[type]}/${encodeSegment(id)}/top/listeners${query}`,
    { force }
  );

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  res.status(200).json({
    ok: true,
    type,
    id,
    endpoint: result.endpoint,
    items: getItems(result.data).map((item: any) => ({
      position: item?.position ?? null,
      streams: item?.streams ?? 0,
      playedMs: normalizePlayedMs(item?.playedMs ?? item?.played_ms ?? null),
      indicator: item?.indicator ?? null,
      user: normalizeUserSummary(item?.user),
    })),
  });
}
