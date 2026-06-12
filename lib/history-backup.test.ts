import assert from "node:assert/strict";
import test from "node:test";
import {
  backupHistoryMonth,
  createHistoryMonth,
  estimateHistoryMonths,
  listHistoryMonths,
  maintainWeeklyHistoryUser,
  normalizeHistoryEvent,
  parseHistoryMonth,
  resolveHistoryUsers,
} from "./history-backup.ts";
import { historyEventToStream, resolveClosedMonthRange } from "./history-local.ts";
import type {
  HistoryUserState,
  StreamHistoryEvent,
  StreamMonthBackup,
} from "./history-store.ts";
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

function createMaintenanceStore(input: {
  events?: StreamHistoryEvent[];
  months?: StreamMonthBackup[];
  state?: HistoryUserState | null;
} = {}) {
  const events = new Map((input.events ?? []).map((event) => [event.sourceHash, event]));
  const months = new Map(
    (input.months ?? []).map((month) => [`${month.userKey}:${month.year}-${month.month}`, month])
  );
  let state = input.state ?? null;

  const store = {
    async upsertMonthStart(month: any) {
      const key = `${month.userKey}:${month.year}-${month.month}`;
      const previous = months.get(key);
      months.set(key, {
        ...previous,
        ...month,
        storedCount: previous?.storedCount ?? 0,
        status: month.status ?? "running",
      });
    },
    async upsertEvents(inputEvents: StreamHistoryEvent[]) {
      for (const event of inputEvents) events.set(event.sourceHash, event);
      return inputEvents.length;
    },
    async countEventsForMonth(userKey: string, afterMs: number, beforeMs: number) {
      return [...events.values()].filter((event) =>
        event.userKey === userKey
        && event.playedAtMs >= afterMs
        && event.playedAtMs < beforeMs
      ).length;
    },
    async finishMonth(month: any) {
      const key = `${month.userKey}:${month.year}-${month.month}`;
      const previous = months.get(key);
      months.set(key, { ...previous, ...month });
    },
    async listMonths(userKey?: string) {
      return [...months.values()]
        .filter((month) => !userKey || month.userKey === userKey)
        .sort((left, right) => left.afterMs - right.afterMs);
    },
    async getLatestEventMs(userKey: string) {
      const timestamps = [...events.values()]
        .filter((event) => event.userKey === userKey)
        .map((event) => event.playedAtMs);
      return timestamps.length > 0 ? Math.max(...timestamps) : null;
    },
    async getUserState(userKey: string) {
      return state?.userKey === userKey ? state : null;
    },
    async upsertUserState(nextState: HistoryUserState) {
      state = nextState;
      return nextState;
    },
  };

  return {
    events,
    months,
    store,
    getState: () => state,
  };
}

function createMaintenanceFetchers(input: {
  streamsByMonth: Map<string, any[]>;
  hasImported: boolean | null;
  syncEnabled?: boolean | null;
}) {
  const allStreams = () => [...input.streamsByMonth.values()]
    .flat()
    .sort((left, right) =>
      Date.parse(right.playedAt ?? right.endTime) - Date.parse(left.playedAt ?? left.endTime)
    );

  return {
    async fetchStats(_userId: string, month: any) {
      return result({
        items: {
          count: input.streamsByMonth.get(`${month.year}-${month.month}`)?.length ?? 0,
        },
      });
    },
    async fetchStreams(_userId: string, month: any, limit: number, beforeMs: number) {
      const items = (input.streamsByMonth.get(`${month.year}-${month.month}`) ?? [])
        .filter((item) => Date.parse(item.playedAt ?? item.endTime) <= beforeMs)
        .sort((left, right) =>
          Date.parse(right.playedAt ?? right.endTime) - Date.parse(left.playedAt ?? left.endTime)
        )
        .slice(0, limit);
      return result({ items });
    },
    async fetchProfile() {
      return result({
        item: {
          hasImported: input.hasImported,
          syncEnabled: input.syncEnabled ?? null,
        },
      });
    },
    async fetchLatestStream() {
      return result({ items: allStreams().slice(0, 1) });
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

test("resolveHistoryUsers accepts all and comma-separated user keys", () => {
  const all = resolveHistoryUsers("all");
  assert.ok(all.length >= 7);
  assert.equal(all[0].key, "leo");

  const selected = resolveHistoryUsers("leo,gab");
  assert.deepEqual(selected.map((entry) => entry.key), ["leo", "gab"]);
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

test("backupHistoryMonth keeps the current month open", async () => {
  const month = createHistoryMonth(2026, 6);
  const memory = createMemoryStore();

  const output = await backupHistoryMonth(user, month, {
    referenceMs: Date.parse("2026-06-12T12:00:00.000Z"),
    coveragePolicy: {
      latestUpstreamEventMs: Date.parse("2026-06-12T11:00:00.000Z"),
      hasImported: true,
    },
    store: memory.store,
    fetchers: {
      async fetchStats() {
        return result({ items: { count: 1 } });
      },
      async fetchStreams() {
        return result({ items: [stream("june", "2026-06-12T11:00:00.000Z")] });
      },
    },
  });

  assert.equal(output.status, "open");
});

test("first weekly reconstruction starts at the latest stored activity month", async () => {
  const marchEvent = normalizeHistoryEvent(
    stream("march", "2026-03-10T12:00:00.000Z"),
    user
  );
  assert.ok(marchEvent);
  const memory = createMaintenanceStore({ events: [marchEvent] });
  const streamsByMonth = new Map<string, any[]>([
    ["2026-3", [stream("march", "2026-03-10T12:00:00.000Z")]],
  ]);

  const output = await maintainWeeklyHistoryUser(user, {
    referenceMs: Date.parse("2026-06-14T05:17:00.000Z"),
    fetchers: createMaintenanceFetchers({
      streamsByMonth,
      hasImported: null,
    }),
    store: memory.store,
  });

  assert.equal(output.pendingFromMs, createHistoryMonth(2026, 3).afterMs);
  assert.equal(output.checkedMonths, 4);
});

test("first weekly reconstruction reclassifies an unproven empty complete month", async () => {
  const februaryEvent = normalizeHistoryEvent(
    stream("feb", "2026-02-10T12:00:00.000Z"),
    user
  );
  assert.ok(februaryEvent);
  const march = createHistoryMonth(2026, 3);
  const memory = createMaintenanceStore({
    events: [februaryEvent],
    months: [{
      ...march,
      userKey: user.key,
      userId: user.id,
      expectedCount: 0,
      storedCount: 0,
      status: "complete",
    }],
  });

  const output = await maintainWeeklyHistoryUser(user, {
    referenceMs: Date.parse("2026-04-12T05:17:00.000Z"),
    fetchers: createMaintenanceFetchers({
      streamsByMonth: new Map([
        ["2026-2", [stream("feb", "2026-02-10T12:00:00.000Z")]],
      ]),
      hasImported: null,
    }),
    store: memory.store,
  });

  assert.equal(
    output.results.find((entry) => entry.month === 3)?.status,
    "awaiting_sync"
  );
});

test("weekly maintenance reconciles a long absence when history advances", async () => {
  const februaryEvent = normalizeHistoryEvent(
    stream("feb", "2026-02-10T12:00:00.000Z"),
    user
  );
  assert.ok(februaryEvent);
  const memory = createMaintenanceStore({
    events: [februaryEvent],
    state: {
      userKey: user.key,
      userId: user.id,
      pendingFromMs: createHistoryMonth(2026, 2).afterMs,
      lastEventAtMs: februaryEvent.playedAtMs,
      lastCheckedAt: null,
      lastCountChangedAt: null,
      hasImported: true,
      syncEnabled: true,
    },
  });
  const streamsByMonth = new Map<string, any[]>([
    ["2026-2", [stream("feb", "2026-02-10T12:00:00.000Z")]],
  ]);
  const fetchers = createMaintenanceFetchers({
    streamsByMonth,
    hasImported: true,
    syncEnabled: true,
  });

  const dormant = await maintainWeeklyHistoryUser(user, {
    referenceMs: Date.parse("2026-06-14T05:17:00.000Z"),
    fetchers,
    store: memory.store,
  });
  assert.equal(dormant.latestAdvanced, false);
  assert.equal(
    dormant.results.find((entry) => entry.year === 2026 && entry.month === 3)?.status,
    "awaiting_sync"
  );

  streamsByMonth.set("2026-3", [stream("march", "2026-03-12T12:00:00.000Z")]);
  streamsByMonth.set("2026-4", [stream("april", "2026-04-12T12:00:00.000Z")]);
  streamsByMonth.set("2026-5", [stream("may", "2026-05-12T12:00:00.000Z")]);
  streamsByMonth.set("2026-6", [stream("june", "2026-06-25T12:00:00.000Z")]);

  const resumed = await maintainWeeklyHistoryUser(user, {
    referenceMs: Date.parse("2026-07-05T05:17:00.000Z"),
    fetchers,
    store: memory.store,
  });

  assert.equal(resumed.latestAdvanced, true);
  assert.deepEqual(
    resumed.reconciledMonths.filter((month) => ["2026-03", "2026-04", "2026-05"].includes(month)),
    ["2026-03", "2026-04", "2026-05"]
  );
  assert.equal(memory.events.size, 5);
  assert.equal(
    resumed.nextPendingFromMs,
    createHistoryMonth(2026, 4).afterMs
  );

  await maintainWeeklyHistoryUser(user, {
    referenceMs: Date.parse("2026-07-12T05:17:00.000Z"),
    fetchers,
    store: memory.store,
  });
  assert.equal(memory.events.size, 5);
});

test("an empty month stays awaiting_sync until history advances beyond it", async () => {
  const februaryEvent = normalizeHistoryEvent(
    stream("feb", "2026-02-10T12:00:00.000Z"),
    user
  );
  assert.ok(februaryEvent);
  const memory = createMaintenanceStore({
    events: [februaryEvent],
    state: {
      userKey: user.key,
      userId: user.id,
      pendingFromMs: createHistoryMonth(2026, 3).afterMs,
      lastEventAtMs: februaryEvent.playedAtMs,
      lastCheckedAt: null,
      lastCountChangedAt: null,
      hasImported: true,
      syncEnabled: true,
    },
  });
  const streamsByMonth = new Map<string, any[]>([
    ["2026-2", [stream("feb", "2026-02-10T12:00:00.000Z")]],
  ]);
  const fetchers = createMaintenanceFetchers({ streamsByMonth, hasImported: true });

  const dormant = await maintainWeeklyHistoryUser(user, {
    referenceMs: Date.parse("2026-04-12T05:17:00.000Z"),
    fetchers,
    store: memory.store,
  });
  assert.equal(
    dormant.results.find((entry) => entry.month === 3)?.status,
    "awaiting_sync"
  );

  streamsByMonth.set("2026-4", [stream("april", "2026-04-10T12:00:00.000Z")]);
  const advanced = await maintainWeeklyHistoryUser(user, {
    referenceMs: Date.parse("2026-05-03T05:17:00.000Z"),
    fetchers,
    store: memory.store,
  });
  assert.equal(
    advanced.results.find((entry) => entry.month === 3)?.status,
    "complete"
  );
});

test("hasImported false to true starts a complete backfill", async () => {
  const memory = createMaintenanceStore({
    state: {
      userKey: user.key,
      userId: user.id,
      pendingFromMs: createHistoryMonth(2016, 2).afterMs,
      lastEventAtMs: null,
      lastCheckedAt: null,
      lastCountChangedAt: null,
      hasImported: false,
      syncEnabled: false,
    },
  });
  const streamsByMonth = new Map<string, any[]>([
    ["2016-2", [stream("first", "2016-02-10T12:00:00.000Z")]],
  ]);

  const output = await maintainWeeklyHistoryUser(user, {
    referenceMs: Date.parse("2016-03-06T05:17:00.000Z"),
    fetchers: createMaintenanceFetchers({
      streamsByMonth,
      hasImported: true,
      syncEnabled: true,
    }),
    store: memory.store,
  });

  assert.equal(output.fullBackfill, true);
  assert.equal(output.pendingFromMs, createHistoryMonth(2016, 1).afterMs);
  assert.deepEqual(output.reconciledMonths, ["2016-01", "2016-02", "2016-03"]);
  assert.equal(memory.events.size, 1);
});

test("users without imported history remain awaiting_sync", async () => {
  const memory = createMaintenanceStore();
  const output = await maintainWeeklyHistoryUser(user, {
    referenceMs: Date.parse("2026-06-14T05:17:00.000Z"),
    fetchers: createMaintenanceFetchers({
      streamsByMonth: new Map(),
      hasImported: false,
      syncEnabled: false,
    }),
    store: memory.store,
  });

  assert.equal(output.hasImported, false);
  assert.equal(
    output.results.find((entry) => entry.month === 4)?.status,
    "awaiting_sync"
  );
  assert.equal(
    output.results.find((entry) => entry.month === 6)?.status,
    "open"
  );
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

test("resolveClosedMonthRange only accepts exact closed month ranges", () => {
  const january = createHistoryMonth(2026, 1);
  const february = createHistoryMonth(2026, 2);
  const exact = resolveClosedMonthRange(january.afterMs, february.beforeMs);
  assert.deepEqual(exact?.months.map((month) => `${month.year}-${month.month}`), ["2026-1", "2026-2"]);

  assert.equal(resolveClosedMonthRange(january.afterMs + 1, january.beforeMs), null);
  assert.equal(resolveClosedMonthRange(january.afterMs, january.beforeMs - 1), null);

  const june = createHistoryMonth(2026, 6);
  assert.equal(
    resolveClosedMonthRange(
      june.afterMs,
      june.beforeMs,
      Date.parse("2026-06-12T12:00:00.000Z")
    ),
    null
  );
});

test("historyEventToStream keeps raw stream fields and durable album evidence", () => {
  const event = normalizeHistoryEvent(stream("one", "2026-01-02T10:00:00.000Z", {
    albumId: null,
    track: { id: "one", name: "Track one" },
  }), user);
  assert.ok(event);
  event.albumId = "album-from-history";

  const item = historyEventToStream(event);
  assert.equal(item.trackId, "one");
  assert.equal(item.albumId, "album-from-history");
  assert.equal(item.track.id, "one");
  assert.equal(item.playedAtMs, event.playedAtMs);
});
