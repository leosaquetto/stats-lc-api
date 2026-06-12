import type { VercelRequest, VercelResponse } from "@vercel/node";
import pushHandler from "../../lib/api-handlers/push.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  req.query.action = "public-key";
  return pushHandler(req, res);
}

