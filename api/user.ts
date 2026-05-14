import type { VercelRequest, VercelResponse } from "@vercel/node";
import { extractUserPlatform } from "../lib/normalize.js";
import { resolveUserId } from "../lib/users.js";
import { statsfmFetch } from "../lib/statsfm.js";

const SENSITIVE_KEY_PATTERN = /(token|authorization|cookie|secret|session)/i;

function sanitizeDebugValue(value: any): any {
  if (Array.isArray(value)) return value.map(sanitizeDebugValue);

  if (value && typeof value === "object") {
    return Object.entries(value).reduce((acc, [key, entry]) => {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        acc[key] = "[REDACTED]";
        return acc;
      }

      acc[key] = sanitizeDebugValue(entry);
      return acc;
    }, {} as Record<string, any>);
  }

  return value;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const user = String(req.query.user || "");
  const force = req.query.force === "1";
  const debug = req.query.debug === "1";

  if (!user) {
    return res.status(400).json({ ok: false, error: "missing_user" });
  }

  const userId = resolveUserId(user);
  const result = await statsfmFetch(`/users/${userId}`, { force });

  const profileRaw = result?.data?.item ?? null;
  const platform = extractUserPlatform(profileRaw, user);

  const payload = {
    ok: result.ok,
    user,
    userId,
    profile: {
      displayName:
        profileRaw?.displayName ?? profileRaw?.username ?? profileRaw?.name ?? user,
      username: profileRaw?.username ?? null,
      image: profileRaw?.image ?? null,
      hasImported: profileRaw?.hasImported ?? null,
      orderBy: profileRaw?.orderBy ?? null,
      platform: platform.primary,
      rawAvailableKeys: profileRaw && typeof profileRaw === "object" ? Object.keys(profileRaw) : [],
    },
    platform,
    legacy: result,
    ...(debug ? { raw: sanitizeDebugValue(result) } : {}),
  };

  res.status(result.ok ? 200 : result.status).json(payload);
}
