import type { VercelRequest, VercelResponse } from "@vercel/node";
import {
  buildQuery,
  encodeSegment,
  getItems,
  readOptionalQueryString,
  readQueryString,
} from "../lib/api-helpers.js";
import { normalizeAlbum, normalizeArtist, normalizeTrack } from "../lib/normalize.js";
import { statsfmFetch } from "../lib/statsfm.js";

const SECTION_PATHS = {
  tracks: "tracks",
  "top-tracks": "tracks/top",
  albums: "albums",
  "top-albums": "albums/top",
  related: "related",
} as const;

type ArtistCatalogSection = keyof typeof SECTION_PATHS;

function readSection(value: unknown): ArtistCatalogSection | null {
  const section = readQueryString(value);
  return section in SECTION_PATHS ? (section as ArtistCatalogSection) : null;
}

function normalizeSectionItem(item: any, section: ArtistCatalogSection) {
  if (section === "albums" || section === "top-albums") {
    return normalizeAlbum(item?.album ?? item);
  }

  if (section === "related") {
    return normalizeArtist(item?.artist ?? item);
  }

  return normalizeTrack(item?.track ?? item);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const id = readQueryString(req.query.id);
  const section = readSection(req.query.section);
  const force = req.query.force === "1";

  if (!id || !section) {
    return res.status(400).json({ ok: false, error: "missing_id_or_section" });
  }

  const query = buildQuery({
    limit: readOptionalQueryString(req.query.limit),
    offset: readOptionalQueryString(req.query.offset),
  });

  const result = await statsfmFetch(
    `/artists/${encodeSegment(id)}/${SECTION_PATHS[section]}${query}`,
    { force }
  );

  if (!result.ok) {
    return res.status(result.status).json(result);
  }

  res.status(200).json({
    ok: true,
    id,
    section,
    endpoint: result.endpoint,
    items: getItems(result.data).map((item: any) => normalizeSectionItem(item, section)),
  });
}
