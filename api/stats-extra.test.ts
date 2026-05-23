import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { VercelResponse } from "@vercel/node";
import entityGroupStatsHandler from "./entity-group-stats.ts";
import groupLiveHandler from "./group-live.ts";
import statsCardinalityHandler from "./stats-cardinality.ts";
import statsDatesHandler from "./stats-dates.ts";
import { normalizeTrack } from "../lib/normalize.ts";
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
  assert.deepEqual(captured.body.monthDays["1"], { count: 0, durationMs: 0 });
  assert.equal(Object.keys(captured.body.monthDays).length, 31);
});

test("group-live returns lightweight live members with normalized nowPlaying", async () => {
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));

    if (url.pathname.includes("/streams/recent")) {
      return jsonResponse({
        items: [
          {
            id: "stream-1",
            endTime: "2026-05-22T22:00:00.000Z",
            service: "spotify",
            track: {
              id: "track-1",
              name: "Live Song",
              artists: [{ id: "artist-1", name: "Artist One" }],
              albums: [{ id: "album-1", name: "Album One", image: "https://img.test/a.jpg" }],
              durationMs: 180000,
            },
          },
        ],
      });
    }

    return jsonResponse({
      item: {
        displayName: "Live User",
        image: "https://img.test/u.jpg",
      },
    });
  };

  const { res, captured } = createResponseCapture();

  await groupLiveHandler({ query: {} } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.members.length, 5);
  assert.equal(captured.body.members[0].profile.displayName, "Live User");
  assert.equal(captured.body.members[0].nowPlaying.track.name, "Live Song");
  assert.equal(captured.body.members[0].nowPlaying.platformCandidate.primary, "spotify");
});

test("entity-group-stats returns per-member stats and tolerates partial failures", async () => {
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 2) return jsonResponse({ error: "missing" }, 404);

    return jsonResponse({
      items: {
        count: calls,
        durationMs: calls * 60000,
      },
    });
  };

  const { res, captured } = createResponseCapture();

  await entityGroupStatsHandler({
    query: {
      type: "track",
      id: "track-1",
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.type, "track");
  assert.equal(captured.body.members.length, 5);
  assert.equal(captured.body.members[0].count, 1);
  assert.equal(captured.body.members[1].count, 0);
  assert.equal(captured.body.members[2].count, 3);
});

test("normalizeTrack exposes album-owned primary artist and secondary artists", () => {
  const track = normalizeTrack({
    id: "track-1",
    name: "Song",
    artists: [
      { id: "guest", name: "Guest Artist" },
      { id: "main", name: "Main Artist" },
    ],
    albums: [
      {
        id: "album-1",
        name: "Album",
        artist: { id: "main", name: "Main Artist" },
        artists: [{ id: "main", name: "Main Artist" }],
      },
    ],
  });

  assert.equal(track.primaryArtistId, "main");
  assert.equal(track.primaryArtistName, "Main Artist");
  assert.deepEqual(track.secondaryArtists.map((artist: any) => artist.id), ["guest"]);
});
