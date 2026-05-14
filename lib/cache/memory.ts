const memory = new Map<string, { expiresAt: number; value: unknown }>();

export function getMemoryCache<T>(key: string): T | null {
  const hit = memory.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    memory.delete(key);
    return null;
  }
  return hit.value as T;
}

export function setMemoryCache(key: string, value: unknown, ttlMs = 15_000) {
  memory.set(key, { value, expiresAt: Date.now() + ttlMs });
}
