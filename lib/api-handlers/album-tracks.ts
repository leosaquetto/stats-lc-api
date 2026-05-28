import type { VercelRequest, VercelResponse } from "@vercel/node";
import { encodeSegment, getItems, readQueryString } from "../api-helpers.js";
import { normalizeTrack } from "../normalize.js";
import { statsfmFetch } from "../statsfm.js";
import { enrichTrackItemsWithAlbumOwners } from "../track-album-enrichment.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const id = readQueryString(req.query.id);
  const force = req.query.force === "1";

  if (!id) {
    return res.status(400).json({ ok: false, error: "missing_id" });
  }

  const result = await statsfmFetch(`/albums/${encodeSegment(id)}/tracks`, { force });

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  const items = await enrichTrackItemsWithAlbumOwners(getItems(result.data), { force });

  res.status(200).json({
    ok: true,
    id,
    endpoint: result.endpoint,
    items: items.map(normalizeTrack),
  });
}
