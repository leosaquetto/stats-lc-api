import type { VercelRequest, VercelResponse } from "@vercel/node";
import { buildQuery, getItems, readOptionalQueryString, readQueryString } from "../lib/api-helpers.js";
import {
  normalizeAlbum,
  normalizeArtist,
  normalizeTrack,
  normalizeUserSummary,
} from "../lib/normalize.js";
import { statsfmFetch } from "../lib/statsfm.js";
import { enrichTrackItemsWithAlbumOwners } from "../lib/track-album-enrichment.js";

function getSearchType(item: any) {
  return item?.type ?? item?.item?.type ?? null;
}

function isSearchTrack(item: any) {
  return getSearchType(item) === "track" || item?.track;
}

function normalizeSearchItem(item: any) {
  const type = getSearchType(item);
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

  const rawItems = getItems(result.data);
  const enrichedTracks = await enrichTrackItemsWithAlbumOwners(
    rawItems.filter(isSearchTrack).map((item: any) => item?.track ?? item?.item ?? item),
    { force }
  );
  let enrichedTrackIndex = 0;
  const items = rawItems.map((item: any) => {
    if (!isSearchTrack(item)) return item;
    const enrichedTrack = enrichedTracks[enrichedTrackIndex++];
    if (item?.track) return { ...item, track: enrichedTrack };
    if (item?.item) return { ...item, item: enrichedTrack };
    return enrichedTrack;
  });

  res.status(200).json({
    ok: true,
    q,
    type,
    endpoint: result.endpoint,
    items: items.map(normalizeSearchItem),
  });
}
