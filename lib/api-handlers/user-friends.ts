import type { VercelRequest, VercelResponse } from "@vercel/node";
import { encodeSegment, getItem, getItems, readQueryString } from "../api-helpers.js";
import { normalizeUserSummary } from "../normalize.js";
import { statsfmFetch } from "../statsfm.js";
import { resolveUserId } from "../users.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = readQueryString(req.query.user);
  const force = req.query.force === "1";

  if (!user) {
    return res.status(400).json({ ok: false, error: "missing_user" });
  }

  const userId = resolveUserId(user);
  const [friends, count] = await Promise.all([
    statsfmFetch(`/users/${encodeSegment(userId)}/friends`, { force }),
    statsfmFetch(`/users/${encodeSegment(userId)}/friends/count`, { force }),
  ]);

  if (!friends.ok) {
    return res.status(friends.status).json(friends);
  }

  const items = getItems(friends.data).map(normalizeUserSummary);
  const countItem = count.ok ? getItem(count.data) : null;

  res.status(200).json({
    ok: true,
    user,
    userId,
    endpoint: friends.endpoint,
    count: typeof countItem === "number" ? countItem : countItem?.count ?? items.length,
    items,
    errors: {
      count: count.ok ? null : count,
    },
  });
}
