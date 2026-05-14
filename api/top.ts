import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveUserId } from "../lib/users.js";
import { statsfmFetch } from "../lib/statsfm.js";
import { normalizeTopItem } from "../lib/normalize.js";

function getAfterFromPeriod(period: string) {
  const now = new Date();

  if (period === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  if (period === "week") {
    return Date.now() - 7 * 24 * 60 * 60 * 1000;
  }

  if (period === "month") {
    return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  }

  return 0;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const type = String(req.query.type || "tracks") as "artists" | "tracks" | "albums";
  const period = String(req.query.period || "week");
  const limit = Number(req.query.limit || 20);
  const force = req.query.force === "1";

  if (!user) {
    return res.status(400).json({ ok: false, error: "missing_user" });
  }

  if (!["artists", "tracks", "albums"].includes(type)) {
    return res.status(400).json({ ok: false, error: "invalid_type" });
  }

  const userId = resolveUserId(user);
  const after = req.query.after ? Number(req.query.after) : getAfterFromPeriod(period);

  const result = await statsfmFetch(
    `/users/${userId}/top/${type}?after=${after}&limit=${limit}`,
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
    type,
    period,
    after,
    endpoint: result.endpoint,
    items: Array.isArray(data?.items)
      ? data.items.map((item: any) => normalizeTopItem(item, type))
      : []
  });
}