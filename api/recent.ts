import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveUserId } from "../lib/users";
import { statsfmFetch } from "../lib/statsfm";
import { normalizeRecentItem } from "../lib/normalize";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const limit = Number(req.query.limit || 50);
  const offset = Number(req.query.offset || 0);
  const force = req.query.force === "1";

  if (!user) {
    return res.status(400).json({ ok: false, error: "missing_user" });
  }

  const userId = resolveUserId(user);

  const result = await statsfmFetch(
    `/users/${userId}/streams/recent?limit=${limit}&offset=${offset}`,
    { force }
  );

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  const data: any = result.data;

  res.status(200).json({
    ok: true,
    user,
    userId,
    endpoint: result.endpoint,
    items: Array.isArray(data?.items)
      ? data.items.map(normalizeRecentItem)
      : []
  });
}