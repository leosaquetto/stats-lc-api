import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveUserId } from "../users.js";
import { fetchUserRecentStreams, normalizeStreamItems } from "../user-streams-service.js";
import { attachDominantColorToItems } from "../artwork-color.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);
  const force = req.query.force === "1";
  const resolveAlbums = req.query.resolveAlbums === "1";

  if (!user) {
    return res.status(400).json({ ok: false, error: "missing_user" });
  }

  const userId = resolveUserId(user);

  const result = await fetchUserRecentStreams(userId, { limit, offset }, { force });

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  const items = await normalizeStreamItems(result.data, {
    force,
    userId,
    useTrackStreamEvidence: resolveAlbums,
  });

  res.status(200).json({
    ok: true,
    user,
    userId,
    endpoint: result.endpoint,
    items: await attachDominantColorToItems(items, Math.min(limit, 50)),
  });
}
