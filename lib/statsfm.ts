const API_BASE = "https://api.stats.fm/api/v1";

export async function statsfmFetch(path: string, options?: { force?: boolean }) {
  const url = `${API_BASE}${path}`;

  const response = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Accept": "application/json"
    },
    cache: options?.force ? "no-store" : "default"
  });

  const text = await response.text();

  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      endpoint: url,
      data
    };
  }

  return {
    ok: true,
    status: response.status,
    endpoint: url,
    data
  };
}

export function getCount(data: any) {
  return data?.items?.count ?? data?.item?.count ?? data?.count ?? 0;
}

export function getDurationMs(data: any) {
  return data?.items?.durationMs ?? data?.item?.durationMs ?? data?.durationMs ?? 0;
}