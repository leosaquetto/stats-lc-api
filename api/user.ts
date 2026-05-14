import type { VercelRequest, VercelResponse } from "@vercel/node";
import { resolveUserId } from "../lib/users.js";
import { statsfmFetch } from "../lib/statsfm.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const force = req.query.force === "1";

  if (!user) {
    return res.status(400).json({ ok: false, error: "missing_user" });
  }

  const userId = resolveUserId(user);
  const result = await statsfmFetch(`/users/${userId}`, { force });

  res.status(result.ok ? 200 : result.status).json(result);
}