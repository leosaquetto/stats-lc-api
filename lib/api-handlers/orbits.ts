import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readQueryString, setCacheHeaders } from "../api-helpers.js";
import { normalizeTrack } from "../normalize.js";
import { orbitStore, usingDurableOrbitStore, type Orbit, type OrbitBox } from "../orbits-store.js";
import { sendOrbitPush } from "../push-service.js";
import { fetchUserEntityStreams } from "../user-streams-service.js";
import { USERS, resolveUserId } from "../users.js";

const getUserPlatform = (userId: string) => {
  const entry = Object.entries(USERS).find(([key, user]) => key === userId || user.id === userId);
  return entry?.[1]?.platform || "unknown";
};

const getKnownUserId = (userId: unknown) => {
  if (typeof userId !== "string" || !userId.trim()) return null;
  const normalized = userId.trim();
  const entry = Object.entries(USERS).find(([key, user]) => key === normalized || user.id === normalized);
  return entry?.[1]?.id || null;
};

const hasTrackIdentity = (track: any) => Boolean(
  track?.id
  || track?.spotifyId
  || track?.appleMusicId
  || track?.externalIds?.spotify?.[0]
  || track?.externalIds?.appleMusic?.[0]
);

const getListenUrl = (track: any, platform: string) => {
  const spotifyId = track?.spotifyId || track?.externalIds?.spotify?.[0];
  const appleMusicId = track?.appleMusicId || track?.externalIds?.appleMusic?.[0];

  if (platform === "spotify" && spotifyId) return `https://open.spotify.com/track/${spotifyId}`;
  if (platform === "appleMusic" && appleMusicId) return `https://music.apple.com/song/${appleMusicId}`;
  if (spotifyId) return `https://open.spotify.com/track/${spotifyId}`;
  if (appleMusicId) return `https://music.apple.com/song/${appleMusicId}`;
  return null;
};

const getTrackMatchIds = (track: any) => new Set([
  track?.id,
  track?.spotifyId,
  track?.appleMusicId,
  ...(track?.externalIds?.spotify || []),
  ...(track?.externalIds?.appleMusic || []),
].filter(Boolean).map(String));

const streamMatchesTrack = (stream: any, matchIds: Set<string>) => {
  const track = stream?.track || {};
  return [
    track?.id,
    track?.spotifyId,
    track?.appleMusicId,
    ...(track?.externalIds?.spotify || []),
    ...(track?.externalIds?.appleMusic || []),
  ].some(value => value && matchIds.has(String(value)));
};

const checkOrbitListens = async (orbit: Orbit) => {
  if (!orbit.track?.id) return orbit;

  const result = await fetchUserEntityStreams(
    resolveUserId(orbit.toUserId),
    "tracks",
    orbit.track.id,
    { limit: 50, after: Date.parse(orbit.createdAt) },
    { force: false }
  );

  if (!result.ok) {
    orbit.lastCheckedAt = new Date().toISOString();
    return orbit;
  }

  const matchIds = getTrackMatchIds(orbit.track);
  const data = result.data as any;
  const items = Array.isArray(data?.items) ? data.items : [];
  const matchingItems = items.filter((item: any) => streamMatchesTrack(item, matchIds));
  orbit.listenCountSinceSent = matchingItems.length;
  orbit.lastCheckedAt = new Date().toISOString();

  if (matchingItems.length > 0) {
    orbit.status = "listened";
    orbit.firstListenedAt = orbit.firstListenedAt || (
      matchingItems
        .map((item: any) => item?.endTime || item?.playedAt)
        .filter(Boolean)
        .sort()[0]
    );
  }

  return orbit;
};

const safelySendOrbitPush = async (orbit: Orbit, event: "received" | "listened") => {
  try {
    await sendOrbitPush(orbit, event);
  } catch (error: any) {
    console.warn(JSON.stringify({
      event: "orbit_push_dispatch_failed",
      orbitId: orbit.id,
      pushEvent: event,
      message: error?.message || String(error),
    }));
  }
};

const sendOrbitList = async (req: VercelRequest, res: VercelResponse) => {
  const user = readQueryString(req.query.user);
  const box = readQueryString(req.query.box || "received") as OrbitBox;
  if (!user) return res.status(400).json({ ok: false, error: "missing_user" });
  if (!getKnownUserId(user)) return res.status(400).json({ ok: false, error: "invalid_user" });
  if (!["received", "sent", "all"].includes(box)) {
    return res.status(400).json({ ok: false, error: "invalid_box" });
  }

  const items = await orbitStore.list(resolveUserId(user), box);
  setCacheHeaders(res, 0, true);
  return res.status(200).json({ ok: true, durable: usingDurableOrbitStore(), items });
};

const createOrbit = async (req: VercelRequest, res: VercelResponse) => {
  const { fromUserId, toUserId, track, message } = req.body || {};
  if (!fromUserId || !toUserId || !track) {
    return res.status(400).json({ ok: false, error: "missing_orbit_fields" });
  }

  const normalizedFromUserId = getKnownUserId(fromUserId);
  const normalizedToUserId = getKnownUserId(toUserId);
  if (!normalizedFromUserId || !normalizedToUserId) {
    return res.status(400).json({ ok: false, error: "invalid_orbit_user" });
  }
  if (normalizedFromUserId === normalizedToUserId) {
    return res.status(400).json({ ok: false, error: "orbit_self_send_not_allowed" });
  }

  const normalizedTrack = normalizeTrack(track);
  if (!hasTrackIdentity(normalizedTrack)) {
    return res.status(400).json({ ok: false, error: "invalid_orbit_track" });
  }

  const targetPlatform = getUserPlatform(normalizedToUserId);
  const orbit: Orbit = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    fromUserId: normalizedFromUserId,
    toUserId: normalizedToUserId,
    track: normalizedTrack,
    message: typeof message === "string" ? message.slice(0, 120) : undefined,
    status: "sent",
    createdAt: new Date().toISOString(),
    listenCountSinceSent: 0,
    targetPlatform,
    listenUrl: getListenUrl(normalizedTrack, targetPlatform) || undefined,
  };

  const savedOrbit = await orbitStore.create(orbit);
  await safelySendOrbitPush(savedOrbit, "received");
  setCacheHeaders(res, 0, true);
  return res.status(201).json({ ok: true, durable: usingDurableOrbitStore(), orbit: savedOrbit });
};

const updateOrbit = async (req: VercelRequest, res: VercelResponse, action: string) => {
  const id = readQueryString(req.query.id);
  const orbit = await orbitStore.get(id);
  if (!orbit) return res.status(404).json({ ok: false, error: "orbit_not_found" });
  if (!["seen", "opened", "dismiss", "delete-sent", "delete-received", "check-listens"].includes(action)) {
    return res.status(400).json({ ok: false, error: "invalid_orbit_action" });
  }

  const now = new Date().toISOString();
  if (action === "seen") {
    orbit.status = orbit.status === "sent" ? "seen" : orbit.status;
    orbit.seenAt = orbit.seenAt || now;
  } else if (action === "opened") {
    orbit.status = orbit.status === "sent" || orbit.status === "seen" ? "opened" : orbit.status;
    orbit.openedAt = orbit.openedAt || now;
  } else if (action === "dismiss") {
    orbit.status = "dismissed";
  } else if (action === "delete-sent") {
    orbit.senderDeletedAt = now;
  } else if (action === "delete-received") {
    orbit.recipientDeletedAt = now;
  } else if (action === "check-listens") {
    const wasListened = orbit.listenCountSinceSent > 0 || orbit.status === "listened";
    await checkOrbitListens(orbit);
    const isListened = orbit.listenCountSinceSent > 0 || orbit.status === "listened";
    if (!wasListened && isListened) {
      await safelySendOrbitPush(orbit, "listened");
    }
  }

  const savedOrbit = await orbitStore.save(orbit);
  setCacheHeaders(res, 0, true);
  return res.status(200).json({ ok: true, durable: usingDurableOrbitStore(), orbit: savedOrbit });
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = readQueryString(req.query.id ? req.query.pathAction : req.query.action);

  if (req.method === "GET" && action === "summary") {
    const user = readQueryString(req.query.user);
    if (!user) return res.status(400).json({ ok: false, error: "missing_user" });
    if (!getKnownUserId(user)) return res.status(400).json({ ok: false, error: "invalid_user" });
    setCacheHeaders(res, 0, true);
    return res.status(200).json({ ok: true, durable: usingDurableOrbitStore(), ...await orbitStore.summary(resolveUserId(user)) });
  }

  if (req.method === "GET") return sendOrbitList(req, res);
  if (req.method === "POST" && !action) return createOrbit(req, res);
  if (req.method === "POST" && action) return updateOrbit(req, res, action);

  return res.status(405).json({ ok: false, error: "method_not_allowed" });
}
