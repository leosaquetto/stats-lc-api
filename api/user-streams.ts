import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildQuery,
  encodeSegment,
  getItems,
  readOptionalQueryString,
  readQueryString,
} from "../lib/api-helpers.js";
import { normalizeRecentItem } from "../lib/normalize.js";
import { statsfmFetch } from "../lib/statsfm.js";
import { resolveUserId } from "../lib/users.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = readQueryString(req.query.user);
  const force = req.query.force === "1";

  if (!user) {
    return res.status(400).json({ ok: false, error: "missing_user" });
  }

  const userId = resolveUserId(user);
  const query = buildQuery({
    limit: readOptionalQueryString(req.query.limit),
    offset: readOptionalQueryString(req.query.offset),
    after: readOptionalQueryString(req.query.after),
    before: readOptionalQueryString(req.query.before),
  });

  const result = await statsfmFetch(`/users/${encodeSegment(userId)}/streams${query}`, {
    force,
  });

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  res.status(200).json({
    ok: true,
    user,
    userId,
    endpoint: result.endpoint,
    items: getItems(result.data).map(normalizeRecentItem),
  });
}
