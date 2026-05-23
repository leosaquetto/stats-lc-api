import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildQuery, getItems, readOptionalQueryString, readQueryString } from "../lib/api-helpers.js";
import {
  normalizeAlbum,
  normalizeArtist,
  normalizeTrack,
  normalizeUserSummary,
} from "../lib/normalize.js";
import { statsfmFetch } from "../lib/statsfm.js";

function normalizeSearchItem(item: any) {
  const type = item?.type ?? item?.item?.type ?? null;
  const value = item?.item ?? item;

  if (type === "track" || item?.track) {
    return { type: "track", item: normalizeTrack(item?.track ?? value) };
  }

  if (type === "artist" || item?.artist) {
    return { type: "artist", item: normalizeArtist(item?.artist ?? value) };
  }

  if (type === "album" || item?.album) {
    return { type: "album", item: normalizeAlbum(item?.album ?? value) };
  }

  if (type === "user" || item?.user) {
    return { type: "user", item: normalizeUserSummary(item?.user ?? value) };
  }

  return {
    type,
    item: value,
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const q = readQueryString(req.query.q || req.query.query);
  const type = readQueryString(req.query.type || "track,artist,album,user");
  const force = req.query.force === "1";

  if (!q) {
    return res.status(400).json({ ok: false, error: "missing_q" });
  }

  const query = buildQuery({
    query: q,
    type,
    limit: readOptionalQueryString(req.query.limit),
  });

  const result = await statsfmFetch(`/search${query}`, { force });

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  res.status(200).json({
    ok: true,
    q,
    type,
    endpoint: result.endpoint,
    items: getItems(result.data).map(normalizeSearchItem),
  });
}
