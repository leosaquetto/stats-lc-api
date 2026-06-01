import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readOptionalQueryString, readQueryString, sendJsonError, setCacheHeaders } from "../api-helpers.js";
import { findGeniusLyricsMatch } from "../genius.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const title = readQueryString(req.query.title || req.query.track || req.query.name);
  const artist = readOptionalQueryString(req.query.artist);
  const includeLyrics = req.query.includeLyrics === "1" || req.query.lyrics === "1";
  const includeWriters = includeLyrics || req.query.includeWriters === "1" || req.query.writers === "1";

  if (!title) {
    return sendJsonError(res, 400, "missing_title");
  }

  const result = await findGeniusLyricsMatch(title, artist, { includeLyrics, includeWriters });
  setCacheHeaders(res, result.hasLyrics ? 3600 : 300);
  return res.status(200).json(result);
}
