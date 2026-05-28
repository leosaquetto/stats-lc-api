import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  ENTITY_ROUTE_MAP,
  readEntityType,
  readOptionalQueryString,
  readQueryString,
} from "../api-helpers.js";
import { fetchUserEntityStreams, normalizeStreamItems } from "../user-streams-service.js";
import { resolveUserId } from "../users.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const type = readEntityType(req.query.type);
  const id = readQueryString(req.query.id);
  const user = readQueryString(req.query.user);
  const force = req.query.force === "1";

  if (!type || !id || !user) {
    return res.status(400).json({ ok: false, error: "missing_type_id_or_user" });
  }

  const userId = resolveUserId(user);
  const params = {
    limit: readOptionalQueryString(req.query.limit),
    offset: readOptionalQueryString(req.query.offset),
    after: readOptionalQueryString(req.query.after),
    before: readOptionalQueryString(req.query.before),
  };

  const result = await fetchUserEntityStreams(userId, ENTITY_ROUTE_MAP[type], id, params, { force });

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  res.status(200).json({
    ok: true,
    user,
    userId,
    type,
    id,
    endpoint: result.endpoint,
    items: await normalizeStreamItems(result.data, { force }),
  });
}
