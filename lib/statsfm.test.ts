import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  __setStatsfmNowForTests,
  __resetStatsfmStateForTests,
  getStatsfmHealthSnapshot,
  statsfmFetch,
} from "./statsfm.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetStatsfmStateForTests();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

test("cache hit avoids a second upstream fetch", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ item: { id: 1 } });
  };

  const first = await statsfmFetch("/users/leo");
  const second = await statsfmFetch("/users/leo");

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(calls, 1);
  assert.equal(getStatsfmHealthSnapshot().metrics.cacheHits, 1);
});

test("force bypasses fresh cache outside cooldown", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ item: { version: calls } });
  };

  const first = await statsfmFetch("/users/leo");
  const forced = await statsfmFetch("/users/leo", { force: true });

  assert.equal(first.ok, true);
  assert.equal(forced.ok, true);
  assert.equal(calls, 2);
});

test("force inside cooldown serves cached result without refetch", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ item: { version: calls } });
  };

  const firstForce = await statsfmFetch("/users/leo", { force: true });
  const secondForce = await statsfmFetch("/users/leo", { force: true });

  assert.equal(firstForce.ok, true);
  assert.equal(secondForce.ok, true);
  assert.equal(calls, 1);
  assert.equal(getStatsfmHealthSnapshot().metrics.cooldownHits, 1);
});

test("simultaneous requests to the same path are deduplicated", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return jsonResponse({ item: { id: "same" } });
  };

  const [a, b] = await Promise.all([
    statsfmFetch("/users/leo"),
    statsfmFetch("/users/leo"),
  ]);

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(calls, 1);
  assert.equal(getStatsfmHealthSnapshot().metrics.dedupedRequests, 1);
});

test("500 retries once and then succeeds", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ error: "upstream" }, 500);
    return jsonResponse({ item: { recovered: true } });
  };

  const result = await statsfmFetch("/users/leo");

  assert.equal(result.ok, true);
  assert.equal(calls, 2);
  assert.equal(getStatsfmHealthSnapshot().metrics.retries, 1);
});

test("404 does not retry", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({ error: "missing" }, 404);
  };

  const result = await statsfmFetch("/users/leo");

  assert.equal(result.ok, false);
  assert.equal(result.status, 404);
  assert.equal(calls, 1);
});

test("429 falls back to stale without retry", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) return jsonResponse({ item: { cached: true } });
    return jsonResponse({ error: "rate_limited" }, 429);
  };

  const first = await statsfmFetch("/users/leo");
  const second = await statsfmFetch("/users/leo", { force: true });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(second.data, first.data);
  assert.equal(calls, 2);
  assert.equal(getStatsfmHealthSnapshot().metrics.retries, 0);
  assert.equal(getStatsfmHealthSnapshot().metrics.staleServed, 1);
});

test("year-long stats range reuses historical monthly segments after current month expires", async () => {
  const fixedNow = Date.UTC(2026, 4, 22, 12, 0, 0, 0);
  const januaryStart = Date.UTC(2026, 0, 1, 3, 0, 0, 0);
  const juneStart = Date.UTC(2026, 5, 1, 3, 0, 0, 0);
  __setStatsfmNowForTests(fixedNow);

  let calls = 0;

  globalThis.fetch = async (input: string | URL | Request) => {
    calls += 1;
    const url = new URL(String(input));
    const after = Number(url.searchParams.get("after"));

    return jsonResponse({
      items: {
        count: after,
        durationMs: after * 10,
      },
    });
  };

  const first = await statsfmFetch(
    `/users/leo/streams/stats?after=${januaryStart}&before=${juneStart}`
  );

  assert.equal(first.ok, true);
  assert.equal(calls, 5);

  __setStatsfmNowForTests(fixedNow + 60 * 60_000);

  const second = await statsfmFetch(
    `/users/leo/streams/stats?after=${januaryStart}&before=${juneStart}`
  );

  assert.equal(second.ok, true);
  assert.equal(calls, 6);
  assert.equal(getStatsfmHealthSnapshot().monthlySegments.total, 5);
  assert.equal(getStatsfmHealthSnapshot().metrics.aggregateSegmentReuses, 4);
});

test("force refreshes every monthly stats block in the requested range", async () => {
  const fixedNow = Date.UTC(2026, 4, 22, 12, 0, 0, 0);
  const marchStart = Date.UTC(2025, 2, 1, 3, 0, 0, 0);
  const mayStart = Date.UTC(2025, 4, 1, 3, 0, 0, 0);
  __setStatsfmNowForTests(fixedNow);

  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    return jsonResponse({
      items: {
        count: calls,
        durationMs: calls * 100,
      },
    });
  };

  await statsfmFetch(`/users/leo/streams/stats?after=${marchStart}&before=${mayStart}`);
  await statsfmFetch(`/users/leo/streams/stats?after=${marchStart}&before=${mayStart}`, {
    force: true,
  });

  assert.equal(calls, 4);
});

test("dates aggregate merges buckets across monthly segments and fills missing values", async () => {
  const fixedNow = Date.UTC(2026, 4, 22, 12, 0, 0, 0);
  const marchStart = Date.UTC(2025, 2, 1, 3, 0, 0, 0);
  const aprilStart = Date.UTC(2025, 3, 1, 3, 0, 0, 0);
  const mayStart = Date.UTC(2025, 4, 1, 3, 0, 0, 0);
  __setStatsfmNowForTests(fixedNow);

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const after = Number(url.searchParams.get("after"));

    if (after === marchStart) {
      return jsonResponse({
        items: {
          hours: {
            1: { count: 2, durationMs: 2000 },
          },
          months: {
            3: { count: 2, durationMs: 2000 },
          },
          weekDays: {
            5: { count: 1, durationMs: 500 },
          },
        },
      });
    }

    assert.equal(after, aprilStart);

    return jsonResponse({
      items: {
        hours: [
          { hour: 1, count: 3, durationMS: 3000 },
        ],
        months: {
          4: { count: 4, durationMs: 4000 },
        },
        weekDays: [
          { weekDay: 5, count: 2, durationMs: 700 },
        ],
      },
    });
  };

  const result = await statsfmFetch(`/users/leo/streams/dates?after=${marchStart}&before=${mayStart}`);

  assert.equal(result.ok, true);
  assert.deepEqual(result.data, {
    items: {
      hours: {
        0: { count: 0, durationMs: 0 },
        1: { count: 5, durationMs: 5000 },
        2: { count: 0, durationMs: 0 },
        3: { count: 0, durationMs: 0 },
        4: { count: 0, durationMs: 0 },
        5: { count: 0, durationMs: 0 },
        6: { count: 0, durationMs: 0 },
        7: { count: 0, durationMs: 0 },
        8: { count: 0, durationMs: 0 },
        9: { count: 0, durationMs: 0 },
        10: { count: 0, durationMs: 0 },
        11: { count: 0, durationMs: 0 },
        12: { count: 0, durationMs: 0 },
        13: { count: 0, durationMs: 0 },
        14: { count: 0, durationMs: 0 },
        15: { count: 0, durationMs: 0 },
        16: { count: 0, durationMs: 0 },
        17: { count: 0, durationMs: 0 },
        18: { count: 0, durationMs: 0 },
        19: { count: 0, durationMs: 0 },
        20: { count: 0, durationMs: 0 },
        21: { count: 0, durationMs: 0 },
        22: { count: 0, durationMs: 0 },
        23: { count: 0, durationMs: 0 },
      },
      months: {
        1: { count: 0, durationMs: 0 },
        2: { count: 0, durationMs: 0 },
        3: { count: 2, durationMs: 2000 },
        4: { count: 4, durationMs: 4000 },
        5: { count: 0, durationMs: 0 },
        6: { count: 0, durationMs: 0 },
        7: { count: 0, durationMs: 0 },
        8: { count: 0, durationMs: 0 },
        9: { count: 0, durationMs: 0 },
        10: { count: 0, durationMs: 0 },
        11: { count: 0, durationMs: 0 },
        12: { count: 0, durationMs: 0 },
      },
      weekDays: {
        1: { count: 0, durationMs: 0 },
        2: { count: 0, durationMs: 0 },
        3: { count: 0, durationMs: 0 },
        4: { count: 0, durationMs: 0 },
        5: { count: 3, durationMs: 1200 },
        6: { count: 0, durationMs: 0 },
        7: { count: 0, durationMs: 0 },
      },
    },
  });
});
