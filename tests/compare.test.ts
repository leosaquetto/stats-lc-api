import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { VercelResponse } from "@vercel/node";
import compareHandler from "../lib/api-handlers/compare.ts";
import { __resetStatsfmStateForTests } from "../lib/statsfm.ts";

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
    setHeader() {
      return this;
    },
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

function userFromPath(pathname: string) {
  return decodeURIComponent(pathname.split("/")[4] ?? "");
}

function profileFor(userId: string) {
  return {
    item: {
      id: userId,
      customId: userId.includes("000997") ? "leosaquetto" : userId,
      displayName: userId.includes("000997") ? "leo saquetto" : userId,
      image: `https://img.test/${encodeURIComponent(userId)}.jpg`,
    },
  };
}

function makeTopItems(userId: string, kind: "tracks" | "artists" | "albums" | "genres") {
  if (kind === "tracks") {
    const sharedTrack = userId.includes("000997")
      ? {
          position: 2,
          streams: 120,
          playedMs: 24_000_000,
          track: {
            id: "shared-track",
            name: "Shared Track",
            externalIds: { spotify: ["spotify-shared-track"] },
            artists: [{ id: "artist-1", name: "Artist One" }],
          },
        }
      : {
          position: userId === "raw-user" ? 12 : 250,
          streams: userId === "raw-user" ? 90 : 9,
          playedMs: userId === "raw-user" ? 18_000_000 : 900_000,
          track: {
            id: userId === "raw-user" ? "shared-track" : null,
            name: "Shared Track",
            externalIds: { spotify: ["spotify-shared-track"] },
            artists: [{ id: "artist-1", name: "Artist One" }],
          },
        };

    return {
      items: [
        sharedTrack,
        {
          position: 1,
          streams: 200,
          playedMs: 40_000_000,
          track: {
            id: `solo-track-${userId}`,
            name: `Solo Track ${userId}`,
          },
        },
      ],
    };
  }

  if (kind === "artists") {
    return {
      items: [
        {
          position: userId === "raw-user" ? 33 : 3,
          streams: userId === "raw-user" ? 30 : 140,
          playedMs: userId === "raw-user" ? 3_000_000 : 14_000_000,
          artist: {
            id: userId === "raw-user" ? `solo-artist-${userId}` : "shared-artist",
            name: userId === "raw-user" ? "Raw Solo Artist" : "Shared Artist",
            externalIds: userId === "raw-user" ? {} : { appleMusic: ["am-shared-artist"] },
          },
        },
      ],
    };
  }

  if (kind === "albums") {
    return {
      items: [
        {
          position: 4,
          streams: 55,
          playedMs: 5_500_000,
          album: {
            id: "shared-album",
            name: "Shared Album",
            label: "Test Label",
          },
        },
      ],
    };
  }

  return {
    items: [
      {
        position: userId === "raw-user" ? 20 : 1,
        streams: userId === "raw-user" ? 5 : 80,
        playedMs: userId === "raw-user" ? 500_000 : 8_000_000,
        name: userId === "raw-user" ? "hyperpop" : "pop",
      },
    ],
  };
}

function setupCompareFetch(options: { failGenresFor?: string } = {}) {
  const urls: URL[] = [];

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    const pathname = url.pathname;

    if (pathname.includes("/top/genres")) {
      const userId = userFromPath(pathname);
      if (options.failGenresFor === userId) {
        return jsonResponse({ error: "genres unavailable" }, 500);
      }
      return jsonResponse(makeTopItems(userId, "genres"));
    }

    if (pathname.includes("/top/tracks")) {
      return jsonResponse(makeTopItems(userFromPath(pathname), "tracks"));
    }

    if (pathname.includes("/top/artists")) {
      return jsonResponse(makeTopItems(userFromPath(pathname), "artists"));
    }

    if (pathname.includes("/top/albums")) {
      return jsonResponse(makeTopItems(userFromPath(pathname), "albums"));
    }

    if (pathname.endsWith("/streams/stats")) {
      return jsonResponse({
        items: {
          count: 321,
          durationMs: 19_260_000,
          cardinality: {
            artists: 44,
            tracks: 123,
            albums: 55,
          },
        },
      });
    }

    if (pathname.endsWith("/streams/dates")) {
      return jsonResponse({
        items: {
          hours: {
            4: { count: 12, durationMs: 720_000 },
          },
          months: {},
          weekDays: {},
        },
      });
    }

    if (pathname.endsWith("/streams")) {
      const order = url.searchParams.get("order");
      return jsonResponse({
        items: [
          {
            id: `${order}-stream`,
            trackId: `${order}-track`,
            trackName: `${order} Track`,
            playedMs: 180_000,
          },
        ],
      });
    }

    if (pathname.includes("/users/")) {
      return jsonResponse(profileFor(userFromPath(pathname)));
    }

    return jsonResponse({ error: "unexpected" }, 404);
  };

  return urls;
}

test("compare accepts aliases and raw ids with explicit date range", async () => {
  const urls = setupCompareFetch();
  const { res, captured } = createResponseCapture();

  await compareHandler({
    query: {
      users: "leo,raw-user",
      after: "1000",
      before: "2000",
      limit: "999",
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.users.length, 2);
  assert.equal(captured.body.users[0].userId, "000997.3647cff9cc2b42359d6ca7f79a0f2c91.0428");
  assert.equal(captured.body.users[1].userId, "raw-user");
  assert.equal(captured.body.range.source, "explicit");
  assert.equal(captured.body.range.after, 1000);
  assert.equal(captured.body.range.before, 2000);
  assert.equal(captured.body.limit, 500);
  assert.equal(
    urls.some((url) => url.pathname.endsWith("/top/tracks") && url.searchParams.get("limit") === "500"),
    true
  );
});

test("compare matches common tracks by external ids and exposes original ranks", async () => {
  setupCompareFetch();
  const { res, captured } = createResponseCapture();

  await compareHandler({
    query: {
      users: "leo,peter",
      after: "1000",
      before: "2000",
      limit: "250",
    },
  } as any, res);

  const [commonTrack] = captured.body.common.tracks;
  const leoId = "000997.3647cff9cc2b42359d6ca7f79a0f2c91.0428";
  const peterId = "12182998998";

  assert.equal(commonTrack.item.name, "Shared Track");
  assert.equal(commonTrack.sharedByCount, 2);
  assert.equal(commonTrack.byUser[leoId].rank, 2);
  assert.equal(commonTrack.byUser[peterId].rank, 250);
  assert.equal(commonTrack.score > 0, true);
});

test("compare supports more than two users without requiring all users to share an item", async () => {
  setupCompareFetch();
  const { res, captured } = createResponseCapture();

  await compareHandler({
    query: {
      users: "leo,peter,raw-user",
      after: "1000",
      before: "2000",
    },
  } as any, res);

  const [commonArtist] = captured.body.common.artists;

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.users.length, 3);
  assert.equal(commonArtist.item.name, "Shared Artist");
  assert.equal(commonArtist.sharedByCount, 2);
  assert.equal(Object.keys(commonArtist.byUser).includes("raw-user"), false);
});

test("compare can require all users or an explicit shared count", async () => {
  setupCompareFetch();

  const all = createResponseCapture();
  await compareHandler({
    query: {
      users: "leo,peter,raw-user",
      after: "1000",
      before: "2000",
      commonMode: "all",
    },
  } as any, all.res);

  const minShared = createResponseCapture();
  await compareHandler({
    query: {
      users: "leo,peter,raw-user",
      after: "1000",
      before: "2000",
      minSharedBy: "2",
    },
  } as any, minShared.res);

  assert.equal(all.captured.statusCode, 200);
  assert.equal(all.captured.body.commonFilter.mode, "all");
  assert.equal(all.captured.body.commonFilter.minSharedBy, 3);
  assert.equal(all.captured.body.common.artists.length, 0);
  assert.equal(minShared.captured.body.commonFilter.mode, "any");
  assert.equal(minShared.captured.body.commonFilter.minSharedBy, 2);
  assert.equal(minShared.captured.body.common.artists[0].sharedByCount, 2);
});

test("compare period presets are dynamic and explicit after takes priority", async () => {
  setupCompareFetch();

  const all = createResponseCapture();
  await compareHandler({ query: { users: "leo,peter", period: "all" } } as any, all.res);

  const sixMonths = createResponseCapture();
  await compareHandler({ query: { users: "leo,peter", period: "6m" } } as any, sixMonths.res);

  const explicit = createResponseCapture();
  await compareHandler({
    query: { users: "leo,peter", period: "all", after: "123", before: "456" },
  } as any, explicit.res);

  assert.equal(all.captured.body.range.after, 0);
  assert.equal(all.captured.body.range.period, "all");
  assert.equal(sixMonths.captured.body.range.period, "6m");
  assert.equal(sixMonths.captured.body.range.after < sixMonths.captured.body.range.before, true);
  assert.equal(explicit.captured.body.range.source, "explicit");
  assert.equal(explicit.captured.body.range.after, 123);
});

test("compare keeps partial section failures isolated", async () => {
  setupCompareFetch({ failGenresFor: "raw-user" });
  const { res, captured } = createResponseCapture();

  await compareHandler({
    query: {
      users: "leo,raw-user",
      after: "1000",
      before: "2000",
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.common.tracks.length > 0, true);
  assert.equal(captured.body.errors["raw-user"].topGenres.status, 500);
});

test("compare validates user count and range", async () => {
  const single = createResponseCapture();
  await compareHandler({ query: { users: "leo" } } as any, single.res);

  const tooMany = createResponseCapture();
  await compareHandler({
    query: { users: "a,b,c,d,e,f" },
  } as any, tooMany.res);

  const invalidRange = createResponseCapture();
  await compareHandler({
    query: { users: "leo,peter", after: "2000", before: "1000" },
  } as any, invalidRange.res);

  assert.equal(single.captured.statusCode, 400);
  assert.equal(single.captured.body.error, "missing_users");
  assert.equal(tooMany.captured.statusCode, 400);
  assert.equal(tooMany.captured.body.error, "too_many_users");
  assert.equal(invalidRange.captured.statusCode, 400);
  assert.equal(invalidRange.captured.body.error, "invalid_range");
});
