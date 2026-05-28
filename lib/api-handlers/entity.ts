import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  encodeSegment,
  ENTITY_ROUTE_MAP,
  getItem,
  readEntityType,
  readQueryString,
} from "../api-helpers.js";
import { normalizeEntity } from "../normalize.js";
import { statsfmFetch } from "../statsfm.js";
import { enrichTrackItemsWithAlbumOwners } from "../track-album-enrichment.js";

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

  const rawEntity = getItem(result.data);
  const entity = type === "track"
    ? (await enrichTrackItemsWithAlbumOwners([rawEntity], { force }))[0]
    : rawEntity;

  res.status(200).json({
    ok: true,
    type,
    id,
    endpoint: result.endpoint,
    entity: normalizeEntity(entity, type),
  });
}
