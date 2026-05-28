import type { VercelRequest, VercelResponse } from "@vercel/node";
import { USERS } from "../users.js";
import { getCount, getDurationMs, statsfmFetch } from "../statsfm.js";

const routeMap = {
  track: "tracks",
  album: "albums",
  artist: "artists",
} as const;

async function getEntityStatsForUser(
  key: string,
  user: { id: string },
  type: keyof typeof routeMap,
  id: string,
  force: boolean
) {
  const result = await statsfmFetch(
    `/users/${user.id}/streams/${routeMap[type]}/${id}/stats`,
    { force }
  );

  if (!result.ok) {
    return {
      key,
      id: user.id,
      count: 0,
      durationMs: 0,
      minutes: 0,
      error: {
        ok: result.ok,
        status: result.status,
        endpoint: result.endpoint,
      },
    };
  }

  const durationMs = getDurationMs(result.data);

  return {
    key,
    id: user.id,
    count: getCount(result.data),
    durationMs,
    minutes: Math.floor(durationMs / 60000),
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const type = String(req.query.type || "") as keyof typeof routeMap;
  const id = String(req.query.id || "");
  const force = req.query.force === "1";

  if (!type || !id) {
    return res.status(400).json({ ok: false, error: "missing_params" });
  }

  if (!routeMap[type]) {
    return res.status(400).json({ ok: false, error: "invalid_type" });
  }

  const users = Object.entries(USERS) as Array<[keyof typeof USERS, { id: string }]>;
  const settled = await Promise.allSettled(
    users.map(([key, user]) => getEntityStatsForUser(String(key), user, type, id, force))
  );

  const members = settled.map((result, index) => {
    if (result.status === "fulfilled") return result.value;

    const [key, user] = users[index];

    return {
      key,
      id: user.id,
      count: 0,
      durationMs: 0,
      minutes: 0,
      error: String(result.reason),
    };
  });

  res.status(200).json({
    ok: true,
    type,
    id,
    generatedAt: new Date().toISOString(),
    members,
  });
}
