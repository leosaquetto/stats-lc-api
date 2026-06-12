import webpush from "web-push";
import { pushStore } from "./push-store.js";
import type { Orbit } from "./orbits-store.js";

export type OrbitPushEvent = "received" | "listened";

const publicKey = process.env.VAPID_PUBLIC_KEY || "";
const privateKey = process.env.VAPID_PRIVATE_KEY || "";
const subject = process.env.VAPID_SUBJECT || "mailto:statslc@leosaquetto.com";
const configured = Boolean(publicKey && privateKey);

if (configured) {
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

export const getPushPublicKey = () => publicKey || null;
export const isPushConfigured = () => configured;

export async function sendOrbitPush(orbit: Orbit, event: OrbitPushEvent) {
  if (!configured) {
    return { configured: false, attempted: 0, delivered: 0, removed: 0 };
  }

  const userId = event === "received" ? orbit.toUserId : orbit.fromUserId;
  const claimed = await pushStore.claimDelivery(orbit.id, event, userId);
  if (!claimed) {
    return { configured: true, attempted: 0, delivered: 0, removed: 0, duplicate: true };
  }

  const subscriptions = await pushStore.listByUser(userId);
  const payload = JSON.stringify({
    title: event === "received" ? "Novo Orbit" : "Orbit ouvido",
    body: event === "received"
      ? "Você recebeu uma nova recomendação no stats.lc."
      : "Seu Orbit foi ouvido.",
    tag: `orbit-${event}-${orbit.id}`,
    url: "/#/circle?tab=orbits",
  });

  let delivered = 0;
  let removed = 0;
  await Promise.all(subscriptions.map(async (subscription) => {
    try {
      await webpush.sendNotification({
        endpoint: subscription.endpoint,
        expirationTime: subscription.expirationTime,
        keys: subscription.keys,
      }, payload, {
        TTL: 300,
        urgency: "normal",
      });
      delivered += 1;
    } catch (error: any) {
      if (error?.statusCode === 404 || error?.statusCode === 410) {
        await pushStore.remove(subscription.endpoint);
        removed += 1;
        return;
      }
      console.warn(JSON.stringify({
        event: "orbit_push_failed",
        orbitId: orbit.id,
        pushEvent: event,
        statusCode: error?.statusCode || null,
      }));
    }
  }));

  return {
    configured: true,
    attempted: subscriptions.length,
    delivered,
    removed,
  };
}
