import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveUserId } from "../lib/users";
import { getCount, getDurationMs, statsfmFetch } from "../lib/statsfm";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const after = String(req.query.after || "");
  const before = req.query.before ? String(req.query.before) : "";
  const force = req.query.force === "1";

  if (!user || !after) {
    return res.status(400).json({ ok: false, error: "missing_user_or_after" });
  }

  const userId = resolveUserId(user);

  let path = `/users/${userId}/streams/stats?after=${after}`;
  if (before) path += `&before=${before}`;

  const result = await statsfmFetch(path, { force });

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  const data: any = result.data;
  const durationMs = getDurationMs(data);

  res.status(200).json({
    ok: true,
    user,
    userId,
    endpoint: result.endpoint,
    streams: getCount(data),
    durationMs,
    minutes: Math.floor(durationMs / 60000),
    hours: Math.floor(durationMs / 3600000)
  });
}