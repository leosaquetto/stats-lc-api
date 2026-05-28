import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  readOptionalQueryString,
  readQueryString,
} from "../api-helpers.js";
import { fetchUserStreams, normalizeStreamItems } from "../user-streams-service.js";
import { resolveUserId } from "../users.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = readQueryString(req.query.user);
  const force = req.query.force === "1";
  const resolveAlbums = req.query.resolveAlbums === "1";

  if (!user) {
    return res.status(400).json({ ok: false, error: "missing_user" });
  }

  const userId = resolveUserId(user);
  const params = {
    limit: readOptionalQueryString(req.query.limit),
    offset: readOptionalQueryString(req.query.offset),
    after: readOptionalQueryString(req.query.after),
    before: readOptionalQueryString(req.query.before),
  };

  const result = await fetchUserStreams(userId, params, { force });

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  res.status(200).json({
    ok: true,
    user,
    userId,
    endpoint: result.endpoint,
    items: await normalizeStreamItems(result.data, {
      force,
      userId,
      useTrackStreamEvidence: resolveAlbums,
    }),
  });
}
