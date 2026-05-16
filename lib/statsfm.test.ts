import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
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
