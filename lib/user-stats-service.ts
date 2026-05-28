import { buildQuery, encodeSegment } from "./api-helpers.js";
import {
  getCardinality,
  getCount,
  getDatesBreakdown,
  getDurationMs,
  statsfmFetch,
} from "./statsfm.js";

type FetchOptions = NonNullable<Parameters<typeof statsfmFetch>[1]>;

export function buildUserRangeQuery(after: string | number, before?: string | number | null) {
  return buildQuery({ after, before });
}

export async function fetchUserStatsRange(
  userId: string,
  after: string | number,
  before?: string | number | null,
  options: FetchOptions = {}
) {
  return statsfmFetch(
    `/users/${encodeSegment(userId)}/streams/stats${buildUserRangeQuery(after, before)}`,
    options
  );
}

export async function fetchUserDatesRange(
  userId: string,
  after: string | number,
  before?: string | number | null,
  options: FetchOptions = {}
) {
  return statsfmFetch(
    `/users/${encodeSegment(userId)}/streams/dates${buildUserRangeQuery(after, before)}`,
    options
  );
}

export function normalizeStatsSummary(data: unknown) {
  const durationMs = getDurationMs(data);
  return {
    streams: getCount(data),
    durationMs,
    minutes: Math.floor(durationMs / 60000),
    hours: Math.floor(durationMs / 3600000),
  };
}

export function normalizeStatsCardinality(data: unknown) {
  return {
    ...normalizeStatsSummary(data),
    cardinality: getCardinality(data),
  };
}

export function normalizeDatesSummary(data: unknown) {
  return getDatesBreakdown(data);
}
