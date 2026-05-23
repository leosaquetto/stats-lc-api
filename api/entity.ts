import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  encodeSegment,
  ENTITY_ROUTE_MAP,
  getItem,
  readEntityType,
  readQueryString,
} from "../lib/api-helpers.js";
import { normalizeEntity } from "../lib/normalize.js";
import { statsfmFetch } from "../lib/statsfm.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const type = readEntityType(req.query.type);
  const id = readQueryString(req.query.id);
  const force = req.query.force === "1";

  if (!type || !id) {
    return res.status(400).json({ ok: false, error: "missing_type_or_id" });
  }

  const result = await statsfmFetch(`/${ENTITY_ROUTE_MAP[type]}/${encodeSegment(id)}`, {
    force,
  });

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  res.status(200).json({
    ok: true,
    type,
    id,
    endpoint: result.endpoint,
    entity: normalizeEntity(getItem(result.data), type),
  });
}
