import type { VercelRequest, VercelResponse } from "@vercel/node";
import { readQueryString, setCacheHeaders } from "../api-helpers.js";
import { getPushPublicKey, isPushConfigured } from "../push-service.js";
import { pushStore, usingDurablePushStore } from "../push-store.js";
import { USERS } from "../users.js";

function getKnownUserId(value: unknown) {
  const requested = typeof value === "string" ? value.trim() : "";
  if (!requested) return null;
  const entry = Object.entries(USERS).find(([key, user]) =>
    key === requested || user.id === requested
  );
  return entry?.[1].id || null;
}

function getValidSubscription(value: any) {
  if (!value?.endpoint || !value?.keys?.p256dh || !value?.keys?.auth) return null;
  return {
    endpoint: String(value.endpoint),
    expirationTime: typeof value.expirationTime === "number" ? value.expirationTime : null,
    keys: {
      p256dh: String(value.keys.p256dh),
      auth: String(value.keys.auth),
    },
  };
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const action = readQueryString(req.query.action);

  if (req.method === "GET" && action === "public-key") {
    setCacheHeaders(res, 300, false, 300);
    return res.status(200).json({
      ok: true,
      configured: isPushConfigured(),
      publicKey: getPushPublicKey(),
    });
  }

  if (req.method === "POST" && action === "subscribe") {
    const userId = getKnownUserId(req.body?.userId);
    const subscription = getValidSubscription(req.body?.subscription);
    if (!userId || !subscription) {
      return res.status(400).json({ ok: false, error: "invalid_push_subscription" });
    }
    await pushStore.upsert({ userId, ...subscription });
    setCacheHeaders(res, 0, true);
    return res.status(200).json({ ok: true, durable: usingDurablePushStore() });
  }

  if (req.method === "POST" && action === "unsubscribe") {
    const endpoint = typeof req.body?.endpoint === "string" ? req.body.endpoint : "";
    if (!endpoint) {
      return res.status(400).json({ ok: false, error: "missing_push_endpoint" });
    }
    const removed = await pushStore.remove(endpoint);
    setCacheHeaders(res, 0, true);
    return res.status(200).json({ ok: true, removed });
  }

  return res.status(405).json({ ok: false, error: "method_not_allowed" });
}
