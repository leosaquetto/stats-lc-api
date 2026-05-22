import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { VercelResponse } from "@vercel/node";
import statsCardinalityHandler from "./stats-cardinality.ts";
import statsDatesHandler from "./stats-dates.ts";
import {
  __resetStatsfmStateForTests,
  __setStatsfmNowForTests,
} from "../lib/statsfm.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetStatsfmStateForTests();
});

function createResponseCapture() {
  const captured = {
    statusCode: 200,
    body: undefined as any,
  };

  const res = {
    status(code: number) {
      captured.statusCode = code;
      return this;
    },
    json(body: any) {
      captured.body = body;
      return this;
    },
  } as unknown as VercelResponse;

  return {
    res,
    captured,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

test("stats-cardinality exposes count, duration, and cardinality without aggregate folding", async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      items: {
        count: 42,
        durationMs: 420000,
        cardinality: {
          artists: 9,
          tracks: 30,
          albums: 12,
        },
      },
    });

  const { res, captured } = createResponseCapture();

  await statsCardinalityHandler({
    query: {
      user: "leo",
      after: "1000",
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.deepEqual(captured.body.cardinality, {
    artists: 9,
    tracks: 30,
    albums: 12,
  });
  assert.equal(captured.body.streams, 42);
  assert.equal(captured.body.durationMs, 420000);
});

test("stats-dates returns stable zero-filled buckets", async () => {
  __setStatsfmNowForTests(Date.UTC(2026, 4, 22, 12, 0, 0, 0));
  const mayStart = Date.UTC(2026, 4, 1, 3, 0, 0, 0);
  const mayMid = Date.UTC(2026, 4, 15, 3, 0, 0, 0);

  globalThis.fetch = async () =>
    jsonResponse({
      items: {
        hours: {
          23: { count: 7, durationMs: 7000 },
        },
        months: {
          5: { count: 3, durationMs: 3000 },
        },
        weekDays: {
          7: { count: 1, durationMs: 1000 },
        },
      },
    });

  const { res, captured } = createResponseCapture();

  await statsDatesHandler({
    query: {
      user: "leo",
      after: String(mayStart),
      before: String(mayMid),
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.deepEqual(captured.body.hours["23"], { count: 7, durationMs: 7000 });
  assert.deepEqual(captured.body.hours["0"], { count: 0, durationMs: 0 });
  assert.deepEqual(captured.body.months["5"], { count: 3, durationMs: 3000 });
  assert.deepEqual(captured.body.weekDays["7"], { count: 1, durationMs: 1000 });
});
