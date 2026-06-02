import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildQuery, readOptionalQueryString } from "../api-helpers.js";
import { resolveUserId } from "../users.js";
import { getCount, getDurationMs, statsfmFetch } from "../statsfm.js";

const routeMap = {
  track: "tracks",
  album: "albums",
  artist: "artists"
} as const;

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const type = String(req.query.type || "") as keyof typeof routeMap;
  const id = String(req.query.id || "");
  const force = req.query.force === "1";
  const after = readOptionalQueryString(req.query.after);
  const before = readOptionalQueryString(req.query.before);

  if (!user || !type || !id) {
    return res.status(400).json({ ok: false, error: "missing_params" });
  }

  if (!routeMap[type]) {
    return res.status(400).json({ ok: false, error: "invalid_type" });
  }

  const userId = resolveUserId(user);

  const result = await statsfmFetch(
    `/users/${userId}/streams/${routeMap[type]}/${id}/stats${buildQuery({ after, before })}`,
    { force }
  );

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  const data: any = result.data;
  const durationMs = getDurationMs(data);

  res.status(200).json({
    ok: true,
    user,
    userId,
    type,
    id,
    endpoint: result.endpoint,
    count: getCount(data),
    durationMs,
    minutes: Math.floor(durationMs / 60000)
  });
}
