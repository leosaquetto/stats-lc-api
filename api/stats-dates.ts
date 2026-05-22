import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getDatesBreakdown, statsfmFetch } from "../lib/statsfm.ts";
import { resolveUserId } from "../lib/users.ts";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const after = String(req.query.after || "");
  const before = req.query.before ? String(req.query.before) : "";
  const force = req.query.force === "1";

  if (!user || !after) {
    return res.status(400).json({ ok: false, error: "missing_user_or_after" });
  }

  const userId = resolveUserId(user);

  let path = `/users/${userId}/streams/dates?after=${after}`;
  if (before) path += `&before=${before}`;

  const result = await statsfmFetch(path, { force });

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  res.status(200).json({
    ok: true,
    user,
    userId,
    endpoint: result.endpoint,
    ...getDatesBreakdown(result.data),
  });
}
