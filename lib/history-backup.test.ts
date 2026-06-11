import assert from "node:assert/strict";
import test from "node:test";
import {
  backupHistoryMonth,
  createHistoryMonth,
  estimateHistoryMonths,
  listHistoryMonths,
  normalizeHistoryEvent,
  parseHistoryMonth,
} from "./history-backup.ts";
import type { StreamHistoryEvent } from "./history-store.ts";
import type { StatsfmResult } from "./statsfm.ts";

const user = {
  key: "leo",
  id: "user-1",
  platform: "appleMusic",
};

function result(data: unknown, status = 200): StatsfmResult {
  return {
    ok: status >= 200 && status < 300,
    status,
    endpoint: "https://stats.test",
    data,
  };
}

function stream(id: string, playedAt: string, overrides: any = {}) {
  return {
    playedAt,
    playedMs: 180000,
    trackId: id,
    albumId: `album-${id}`,
    track: {
      id,
      name: `Track ${id}`,
      artists: [{ id: `artist-${id}`, name: `Artist ${id}` }],
    },
    ...overrides,
  };
}

function createMemoryStore() {
  const events = new Map<string, StreamHistoryEvent>();
  const months: any[] = [];

  return {
    events,
    months,
    store: {
      async upsertMonthStart(input: any) {
        months.push({ ...input, status: "running", storedCount: 0 });
      },
      async upsertEvents(input: StreamHistoryEvent[]) {
        for (const event of input) events.set(event.sourceHash, event);
        return input.length;
      },
      async countEventsForMonth(userKey: string, afterMs: number, beforeMs: number) {
        return [...events.values()].filter((event) =>
          event.userKey === userKey &&
          event.playedAtMs >= afterMs &&
          event.playedAtMs < beforeMs
        ).length;
      },
      async finishMonth(input: any) {
        months.push(input);
      },
    },
  };
}

test("listHistoryMonths returns inclusive month ranges", () => {
  const months = listHistoryMonths(parseHistoryMonth("2025-11"), parseHistoryMonth("2026-02"));
  assert.deepEqual(months.map((month) => `${month.year}-${month.month}`), [
    "2025-11",
    "2025-12",
    "2026-1",
    "2026-2",
  ]);
});

test("estimateHistoryMonths reads monthly counts without fetching streams", async () => {
  const months = [createHistoryMonth(2026, 1), createHistoryMonth(2026, 2)];
  const requested: string[] = [];
  const rows = await estimateHistoryMonths(user, months, {
    pageSize: 1000,
    fetchers: {
      async fetchStats(_userId, month) {
        requested.push(`${month.year}-${month.month}`);
        return result({ items: { count: month.month === 1 ? 1500 : 0, durationMs: 1 } });
      },
      async fetchStreams() {
        throw new Error("estimate should not fetch streams");
      },
    },
  });

  assert.deepEqual(requested, ["2026-1", "2026-2"]);
  assert.equal(rows[0].expectedCount, 1500);
  assert.equal(rows[0].pages, 2);
  assert.equal(rows[1].expectedCount, 0);
});

test("backupHistoryMonth stores a complete closed month", async () => {
  const month = createHistoryMonth(2026, 1);
  const memory = createMemoryStore();

  const output = await backupHistoryMonth(user, month, {
    pageSize: 2,
    store: memory.store,
    fetchers: {
      async fetchStats() {
        return result({ items: { count: 2, durationMs: 360000 } });
      },
      async fetchStreams(_userId, currentMonth, _limit, beforeMs) {
        assert.equal(beforeMs, currentMonth.beforeMs - 1);
        return result({
          items: [
            stream("one", "2026-01-02T10:00:00.000Z"),
            stream("two", "2026-01-03T10:00:00.000Z"),
          ],
        });
      },
    },
  });

  assert.equal(output.expectedCount, 2);
  assert.equal(output.fetchedCount, 2);
  assert.equal(output.storedCount, 2);
  assert.equal(output.status, "complete");
  assert.equal(memory.events.size, 2);
});

test("backupHistoryMonth dedupes repeated stream rows by source hash", async () => {
  const month = createHistoryMonth(2026, 1);
  const memory = createMemoryStore();
  const repeated = stream("one", "2026-01-02T10:00:00.000Z");

  const output = await backupHistoryMonth(user, month, {
    pageSize: 2,
    store: memory.store,
    fetchers: {
      async fetchStats() {
        return result({ items: { count: 2, durationMs: 360000 } });
      },
      async fetchStreams() {
        return result({ items: [repeated, repeated] });
      },
    },
  });

  assert.equal(output.fetchedCount, 2);
  assert.equal(output.storedCount, 1);
  assert.equal(output.status, "partial");
  assert.equal(memory.events.size, 1);
});

test("backupHistoryMonth marks partial when a later page fails", async () => {
  const month = createHistoryMonth(2026, 1);
  const memory = createMemoryStore();

  const output = await backupHistoryMonth(user, month, {
    pageSize: 1,
    store: memory.store,
    fetchers: {
      async fetchStats() {
        return result({ items: { count: 2, durationMs: 360000 } });
      },
      async fetchStreams(_userId, currentMonth, _limit, beforeMs) {
        return beforeMs === currentMonth.beforeMs - 1
          ? result({ items: [stream("one", "2026-01-02T10:00:00.000Z")] })
          : result({ error: "upstream_failed" }, 503);
      },
    },
  });

  assert.equal(output.fetchedCount, 1);
  assert.equal(output.storedCount, 1);
  assert.equal(output.status, "partial");
  assert.equal(output.errors.length, 1);
});

test("normalizeHistoryEvent extracts stable searchable fields", () => {
  const event = normalizeHistoryEvent(stream("one", "2026-01-02T10:00:00.000Z"), user);
  assert.ok(event);
  assert.equal(event.userKey, "leo");
  assert.equal(event.trackId, "one");
  assert.equal(event.albumId, "album-one");
  assert.equal(event.artistId, "artist-one");
  assert.equal(event.playedMs, 180000);
  assert.equal(typeof event.sourceHash, "string");
});
