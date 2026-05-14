export function computeScore(streams: number, durationMs: number) { return streams * 10 + Math.floor(durationMs / 60000); }
