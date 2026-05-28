import type { VercelRequest, VercelResponse } from "@vercel/node";
import { getStatsfmHealthSnapshot } from "../statsfm.js";

export default function handler(req: VercelRequest, res: VercelResponse) {
  const statsfm = getStatsfmHealthSnapshot();

  res.status(200).json({
    ok: true,
    service: "stats.lc api",
    time: new Date().toISOString(),
    statsfm
  });
}
