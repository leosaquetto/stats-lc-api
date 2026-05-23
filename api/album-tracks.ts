import type { VercelRequest, VercelResponse } from "@vercel/node";
import { encodeSegment, getItems, readQueryString } from "../lib/api-helpers.js";
import { normalizeTrack } from "../lib/normalize.js";
import { statsfmFetch } from "../lib/statsfm.js";

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

  res.status(200).json({
    ok: true,
    id,
    endpoint: result.endpoint,
    items: getItems(result.data).map(normalizeTrack),
  });
}
