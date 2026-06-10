import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { VercelResponse } from "@vercel/node";
import entityGroupStatsHandler from "../lib/api-handlers/entity-group-stats.ts";
import entityStreamsHandler from "../lib/api-handlers/entity-streams.ts";
import groupActivityHandler from "../lib/api-handlers/group-activity.ts";
import groupLiveHandler from "../lib/api-handlers/group-live.ts";
import latestDiscoveryHandler from "../lib/api-handlers/latest-discovery.ts";
import replayHandler from "../lib/api-handlers/replay.ts";
import statsCardinalityHandler from "../lib/api-handlers/stats-cardinality.ts";
import statsDatesHandler from "../lib/api-handlers/stats-dates.ts";
import simultaneousHandler from "../lib/api-handlers/simultaneous.ts";
import topHandler from "../lib/api-handlers/top.ts";
import userStreamsHandler from "../lib/api-handlers/user-streams.ts";
import { normalizeTopItem, normalizeTrack } from "../lib/normalize.ts";
import { USERS } from "../lib/users.ts";
import {
  enrichAlbumItemsWithOwners,
  enrichTrackItemsWithAlbumOwners,
} from "../lib/track-album-enrichment.ts";
import {
  __resetStatsfmStateForTests,
  __setStatsfmNowForTests,
} from "../lib/statsfm.ts";

const originalFetch = globalThis.fetch;
const configuredUserCount = Object.keys(USERS).length;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __resetStatsfmStateForTests();
});

function createResponseCapture() {
  const captured = {
    statusCode: 200,
    body: undefined as any,
    headers: {} as Record<string, string>,
  };

  const res = {
    setHeader(name: string, value: string) {
      captured.headers[name.toLowerCase()] = value;
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

test("stats-dates derives real buckets from streams when upstream dates is unavailable", async () => {
  __setStatsfmNowForTests(Date.UTC(2026, 4, 22, 12, 0, 0, 0));
  const mayStart = Date.UTC(2026, 4, 1, 3, 0, 0, 0);
  const mayMid = Date.UTC(2026, 4, 15, 3, 0, 0, 0);

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/streams/dates")) {
      return jsonResponse({ error: "not_found" }, 404);
    }
    if (url.pathname.endsWith("/streams/stats")) {
      return jsonResponse({ items: { count: 2, durationMs: 420000 } });
    }
    if (url.pathname.endsWith("/streams")) {
      return jsonResponse({
        items: [
          {
            endTime: "2026-05-05T15:00:00.000Z",
            playedMs: 180000,
          },
          {
            endTime: "2026-05-06T00:30:00.000Z",
            playedMs: 240000,
          },
        ],
      });
    }
    return jsonResponse({ error: "unexpected" }, 500);
  };

  const { res, captured } = createResponseCapture();
  await statsDatesHandler({
    query: {
      user: "leo",
      after: String(mayStart),
      before: String(mayMid),
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.reason, "streams_fallback");
  assert.deepEqual(captured.body.hours["12"], { count: 1, durationMs: 180000 });
  assert.deepEqual(captured.body.hours["21"], { count: 1, durationMs: 240000 });
  assert.deepEqual(captured.body.months["5"], { count: 2, durationMs: 420000 });
  assert.deepEqual(captured.body.weekDays["3"], { count: 2, durationMs: 420000 });
  assert.deepEqual(captured.body.monthDays["5"], { count: 2, durationMs: 420000 });
  assert.deepEqual(captured.body.coverage, {
    source: "streams_fallback",
    totalCount: 2,
    requestedCount: 2,
    aggregatedCount: 2,
    partial: false,
    maxStreams: 12000,
  });
});

test("simultaneous returns compact historical matches within the requested gap", async () => {
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const isLeo = url.pathname.includes(encodeURIComponent(USERS.leo.id));
    return jsonResponse({
      items: [
        {
          id: isLeo ? "leo-stream" : "gab-stream",
          endTime: isLeo ? "2026-05-05T15:00:00.000Z" : "2026-05-05T15:07:00.000Z",
          playedMs: 180000,
          track: {
            id: "shared-track",
            name: "Shared Song",
            artists: [{ id: "shared-artist", name: "Shared Artist" }],
            albums: [{ id: "album-1", name: "Shared Album", image: "https://img.test/shared.jpg" }],
          },
        },
      ],
    });
  };

  const { res, captured } = createResponseCapture();
  await simultaneousHandler({
    query: {
      users: "leo,gab",
      after: String(Date.parse("2026-05-05T00:00:00.000Z")),
      before: String(Date.parse("2026-05-06T00:00:00.000Z")),
      gapMinutes: "10",
      limit: "5",
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.items.length, 1);
  assert.equal(captured.body.items[0].matchType, "track");
  assert.equal(captured.body.items[0].gapMinutes, 7);
  assert.equal(captured.body.items[0].track.name, "Shared Song");
  assert.deepEqual(captured.body.items[0].users.map((user: any) => user.key), ["leo", "gab"]);
  assert.deepEqual(captured.body.coverage, {
    source: "user_streams",
    requestedUsers: 2,
    successfulUsers: 2,
    fetchedByUser: {
      leo: 1,
      gab: 1,
    },
    perUserLimit: 1000,
    partial: false,
    failures: [],
  });
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
  assert.equal(captured.body.members.length, configuredUserCount);
  assert.equal(captured.body.members[0].profile.displayName, "Live User");
  assert.equal(captured.body.members[0].nowPlaying.track.name, "Live Song");
  assert.equal(typeof captured.body.members[0].nowPlaying.isNow, "boolean");
  assert.equal(captured.body.members[0].nowPlaying.timestamp, "2026-05-22T22:00:00.000Z");
  assert.equal(captured.body.members[0].nowPlaying.playbackKey, "stream-1");
  assert.equal(captured.body.members[0].nowPlaying.platformCandidate.primary, "spotify");
});

test("group-live uses stream album id to correct live now track album", async () => {
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));

    if (url.pathname.includes("/streams/recent")) {
      return jsonResponse({
        items: [
          {
            id: "stream-1",
            albumId: "album-main",
            endTime: "2026-05-22T22:00:00.000Z",
            track: {
              id: "track-1",
              name: "Live Song",
              artists: [{ id: "artist-1", name: "Main Artist" }],
              albums: [{ id: "single-1", name: "Wrong Single" }],
            },
          },
        ],
      });
    }

    if (url.pathname.endsWith("/albums/album-main")) {
      return jsonResponse({
        item: {
          id: "album-main",
          name: "Main Album",
          artists: [{ id: "artist-1", name: "Main Artist" }],
        },
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
  assert.equal(captured.body.members[0].nowPlaying.track.albumId, "album-main");
  assert.equal(captured.body.members[0].nowPlaying.track.albumName, "Main Album");
});

test("group-live optionally returns fresh daily stats for the requested member", async () => {
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/streams/stats")) {
      return jsonResponse({
        items: {
          count: 27,
          durationMs: 5400000,
        },
      });
    }

    if (url.pathname.includes("/streams/recent")) {
      return jsonResponse({ items: [] });
    }

    return jsonResponse({ item: null });
  };

  const { res, captured } = createResponseCapture();

  await groupLiveHandler({ query: { profile: "0", statsUser: "leo" } } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.featuredStats.userId, USERS.leo.id);
  assert.equal(captured.body.featuredStats.streams, 27);
  assert.equal(captured.body.featuredStats.durationMs, 5400000);
  assert.match(captured.body.featuredStats.day, /^\d{2}\/\d{2}\/\d{4}$|^\d{4}-\d{2}-\d{2}$/);
  assert.equal(typeof captured.body.featuredStats.generatedAt, "string");
});

test("group-live preserves the old payload when statsUser is omitted", async () => {
  globalThis.fetch = async () => jsonResponse({ items: [] });
  const { res, captured } = createResponseCapture();

  await groupLiveHandler({ query: { profile: "0" } } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal("featuredStats" in captured.body, false);
});

test("group-live returns partial members when the endpoint deadline expires", {
  timeout: 4_000,
}, async () => {
  globalThis.fetch = () => new Promise<Response>(() => {});
  const { res, captured } = createResponseCapture();
  const startedAt = Date.now();

  await groupLiveHandler({ query: { profile: "0" } } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.members.length, configuredUserCount);
  assert.equal(Date.now() - startedAt < 2_500, true);
  assert.equal(captured.body.members.every((member: any) => member.nowPlaying === null), true);
  assert.equal(
    captured.body.members.every((member: any) =>
      member.warnings.includes("live_deadline_exceeded")
    ),
    true
  );
});

test("group-activity hydrates track-only stream rows and keeps empty users partial", async () => {
  const streamRequestsByUser = new Map<string, number>();

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const streamsMatch = url.pathname.match(/\/users\/([^/]+)\/streams$/);

    if (streamsMatch) {
      const userId = decodeURIComponent(streamsMatch[1]);
      streamRequestsByUser.set(userId, (streamRequestsByUser.get(userId) ?? 0) + 1);
      assert.equal(url.searchParams.get("limit"), "1");

      if (userId === USERS.savio.id) {
        return jsonResponse({
          items: [{
            id: "savio-stream",
            trackId: "track-love-controller",
            trackName: "Love Controller",
            endTime: "2026-06-07T17:52:00.000Z",
          }],
        });
      }

      return jsonResponse({ items: [] });
    }

    if (url.pathname.endsWith("/tracks/track-love-controller")) {
      return jsonResponse({
        item: {
          id: "track-love-controller",
          name: "Love Controller",
          artists: [{ id: "artist-demi", name: "Demi Lovato" }],
          albums: [{
            id: "album-deep",
            name: "It's Not That Deep",
            image: "https://img.test/love-controller.jpg",
            artists: [{ id: "artist-demi", name: "Demi Lovato" }],
          }],
          externalIds: {
            spotify: ["spotify-love-controller"],
          },
        },
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const { res, captured } = createResponseCapture();
  await groupActivityHandler({ query: {} } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.members.length, configuredUserCount);

  const savio = captured.body.members.find((member: any) => member.key === "savio");
  assert.equal(savio.userId, USERS.savio.id);
  assert.equal(savio.activity.isNow, false);
  assert.equal(savio.activity.timestamp, "2026-06-07T17:52:00.000Z");
  assert.equal(savio.activity.track.name, "Love Controller");
  assert.equal(savio.activity.track.primaryArtistName, "Demi Lovato");
  assert.equal(savio.activity.track.image, "https://img.test/love-controller.jpg");

  const emptyMember = captured.body.members.find((member: any) => member.key === "leo");
  assert.equal(emptyMember.activity, null);
  assert.deepEqual(emptyMember.warnings, ["no_streams"]);
  assert.equal(streamRequestsByUser.size, configuredUserCount);
  assert.match(captured.headers["cache-control"], /s-maxage=180/);

  const second = createResponseCapture();
  await groupActivityHandler({ query: {} } as any, second.res);
  assert.equal(second.captured.statusCode, 200);
  assert.equal(
    [...streamRequestsByUser.values()].every((requestCount) => requestCount === 1),
    true
  );
});

test("group-activity returns a partial response when upstream requests time out", {
  timeout: 12_000,
}, async () => {
  globalThis.fetch = () => new Promise<Response>((resolve) => {
    setTimeout(() => resolve(jsonResponse({ error: "slow_upstream" }, 503)), 2_000);
  });

  const { res, captured } = createResponseCapture();
  const startedAt = Date.now();
  await groupActivityHandler({ query: {} } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.partial, true);
  assert.equal(captured.body.members.length, configuredUserCount);
  assert.equal(Date.now() - startedAt < 11_200, true);
  assert.equal(
    captured.body.members.every((member: any) =>
      member.activity === null && member.warnings.length > 0
    ),
    true
  );
});

test("latest-discovery returns the newest proven first listen", async () => {
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/streams/recent")) {
      return jsonResponse({
        items: [
          {
            id: "recent-new",
            endTime: "2026-06-08T18:00:00.000Z",
            trackId: "track-new",
            track: {
              id: "track-new",
              name: "New Discovery",
              artists: [{ id: "artist-new", name: "New Artist" }],
              albums: [{ id: "album-new", name: "New Album", image: "https://img.test/new.jpg" }],
            },
          },
          {
            id: "recent-old",
            endTime: "2026-06-07T18:00:00.000Z",
            trackId: "track-old",
            track: {
              id: "track-old",
              name: "Old Favorite",
              artists: [{ id: "artist-old", name: "Old Artist" }],
              albums: [{ id: "album-old", name: "Old Album", image: "https://img.test/old.jpg" }],
            },
          },
        ],
      });
    }

    if (url.pathname.endsWith("/streams/tracks/track-new")) {
      assert.equal(url.searchParams.get("order"), "asc");
      return jsonResponse({
        items: [{ id: "first-new", endTime: "2026-06-08T18:00:00.000Z" }],
      });
    }

    if (url.pathname.endsWith("/streams/tracks/track-old")) {
      return jsonResponse({
        items: [{ id: "first-old", endTime: "2024-01-01T12:00:00.000Z" }],
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const { res, captured } = createResponseCapture();
  await latestDiscoveryHandler({ query: { user: "leo" } } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.coverage.complete, true);
  assert.equal(captured.body.item.track.name, "New Discovery");
  assert.equal(captured.body.firstPlayedAt, "2026-06-08T18:00:00.000Z");
});

test("latest-discovery does not claim a discovery when proof is incomplete", async () => {
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/streams/recent")) {
      return jsonResponse({
        items: [{
          id: "recent-1",
          endTime: "2026-06-08T18:00:00.000Z",
          trackId: "track-1",
          track: { id: "track-1", name: "Unverified" },
        }],
      });
    }
    return jsonResponse({ error: "temporary_failure" }, 503);
  };

  const { res, captured } = createResponseCapture();
  await latestDiscoveryHandler({ query: { user: "leo" } } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.coverage.complete, false);
  assert.equal(captured.body.item, null);
  assert.equal(captured.body.firstPlayedAt, null);
});

test("top normalizes an upstream empty-range 400 into an empty successful payload", async () => {
  globalThis.fetch = async () => jsonResponse({ error: "empty_range" }, 400);
  const { res, captured } = createResponseCapture();

  await topHandler({
    query: {
      user: "leo",
      type: "tracks",
      period: "week",
      limit: "10",
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.deepEqual(captured.body.items, []);
  assert.deepEqual(captured.body.warnings, ["upstream_empty_range"]);
});

test("user-streams can resolve historical stream albums", async () => {
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/streams")) {
      return jsonResponse({
        items: [
          {
            id: "stream-1",
            albumId: "album-main",
            track: {
              id: "track-1",
              name: "History Song",
              artists: [{ id: "artist-1", name: "Main Artist" }],
              albums: [{ id: "single-1", name: "Wrong Single" }],
            },
          },
        ],
      });
    }

    if (url.pathname.endsWith("/albums/album-main")) {
      return jsonResponse({
        item: {
          id: "album-main",
          name: "Main Album",
          artists: [{ id: "artist-1", name: "Main Artist" }],
        },
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const { res, captured } = createResponseCapture();

  await userStreamsHandler({
    query: {
      user: "leo",
      limit: "1",
      resolveAlbums: "1",
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.items[0].track.albumId, "album-main");
  assert.equal(captured.body.items[0].track.albumName, "Main Album");
});

test("entity-streams can resolve historical stream albums when requested", async () => {
  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/streams/tracks/track-1")) {
      return jsonResponse({
        items: [
          {
            id: "stream-1",
            albumId: "album-main",
            track: {
              id: "track-1",
              name: "History Song",
              artists: [{ id: "artist-1", name: "Main Artist" }],
              albums: [{ id: "single-1", name: "Wrong Single" }],
            },
          },
        ],
      });
    }

    if (url.pathname.endsWith("/albums/album-main")) {
      return jsonResponse({
        item: {
          id: "album-main",
          name: "Main Album",
          artists: [{ id: "artist-1", name: "Main Artist" }],
        },
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const { res, captured } = createResponseCapture();

  await entityStreamsHandler({
    query: {
      user: "leo",
      type: "track",
      id: "track-1",
      limit: "1",
      resolveAlbums: "1",
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.items[0].track.albumId, "album-main");
  assert.equal(captured.body.items[0].track.albumName, "Main Album");
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
  assert.equal(captured.body.members.length, configuredUserCount);
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

test("normalizeTrack uses shared artist when album artist is a multi-artist credit", () => {
  const track = normalizeTrack({
    id: "golden",
    name: "Golden",
    artists: [
      { id: "audrey-nuna", name: "AUDREY NUNA" },
      { id: "rei-ami", name: "REI AMI" },
      { id: "huntrx", name: "HUNTR/X" },
      { id: "ejae", name: "EJAE" },
    ],
    albums: [
      {
        id: "kpop-demon-hunters",
        name: "KPop Demon Hunters",
        artists: [
          { id: "cast", name: "KPop Demon Hunters Cast" },
          { id: "huntrx-saja", name: "HUNTR/X & Saja Boys" },
        ],
      },
    ],
  });

  assert.equal(track.primaryArtistId, "huntrx");
  assert.equal(track.primaryArtistName, "HUNTR/X");
});

test("normalizeTrack matches compact album artist aliases like HUNTRX to HUNTR/X", () => {
  const track = normalizeTrack({
    id: "golden",
    name: "Golden",
    artists: [
      { id: "audrey-nuna", name: "AUDREY NUNA" },
      { id: "rei-ami", name: "REI AMI" },
      { id: "huntrx-track", name: "HUNTR/X" },
      { id: "ejae", name: "EJAE" },
    ],
    albums: [
      {
        id: "kpop-demon-hunters",
        name: "KPop Demon Hunters (Soundtrack from the Netflix Film)",
        artists: [
          { id: "saja-boys", name: "Saja Boys" },
          { id: "huntrx-album", name: "HUNTRX" },
        ],
      },
    ],
  });

  assert.equal(track.primaryArtistId, "huntrx-track");
  assert.equal(track.primaryArtistName, "HUNTR/X");
  assert.deepEqual(track.secondaryArtists.map((artist: any) => artist.name), ["AUDREY NUNA", "REI AMI", "EJAE"]);
});

test("normalizeTrack follows album credit order for multi-artist singles", () => {
  const track = normalizeTrack({
    id: "hand-that-feeds",
    name: "Hand That Feeds - From the Film Ballerina",
    artists: [
      { id: "amy-lee", name: "Amy Lee" },
      { id: "halsey", name: "Halsey" },
      { id: "evanescence", name: "Evanescence" },
    ],
    albums: [
      {
        id: "hand-that-feeds-single",
        name: "Hand That Feeds (From the Film Ballerina) - Single",
        artistName: "Halsey & Amy Lee",
      },
    ],
  });

  assert.equal(track.primaryArtistId, "halsey");
  assert.equal(track.primaryArtistName, "Halsey");
  assert.deepEqual(track.secondaryArtists.map((artist: any) => artist.name), ["Amy Lee", "Evanescence"]);
});

test("normalizeTrack hides Various Artists from artist fields", () => {
  const track = normalizeTrack({
    id: "track-1",
    name: "Goals",
    artists: [
      { id: "lisa", name: "LiSA" },
      { id: "rema", name: "Rema" },
      { id: "anitta", name: "Anitta" },
      { id: "various", name: "Various Artists" },
    ],
    albums: [
      {
        id: "album-1",
        name: "GOALS (FIFA World Cup 2026) - Single",
        artist: { id: "various", name: "Various Artists" },
        artists: [{ id: "various", name: "Various Artists" }],
      },
    ],
  });

  assert.deepEqual(track.artists.map((artist: any) => artist.name), ["LiSA", "Rema", "Anitta"]);
  assert.equal(track.primaryArtistName, "LiSA");
  assert.deepEqual(track.secondaryArtists.map((artist: any) => artist.name), ["Rema", "Anitta"]);
  assert.equal(track.album.artistName, null);
  assert.deepEqual(track.album.artists, []);
});

test("normalizeTopItem omits Various Artists top artist entries", () => {
  const topArtist = normalizeTopItem({
    position: 1,
    streams: 10,
    artist: { id: "various", name: "Various Artists" },
  }, "artists");

  assert.equal(topArtist, null);
});

test("multi-artist top tracks use album detail owner before first track artist", async () => {
  const urls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);

    if (url.pathname.endsWith("/albums/album-1")) {
      return jsonResponse({
        item: {
          id: "album-1",
          name: "EQUILIBRIVM",
          artists: [{ id: "anitta", name: "Anitta" }],
        },
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const [item] = await enrichTrackItemsWithAlbumOwners([
    {
      position: 1,
      streams: 10,
      track: {
        id: "track-1",
        name: "Meia Noite",
        artists: [
          { id: "los", name: "Los Brasileros" },
          { id: "anitta", name: "Anitta" },
        ],
        albums: [{ id: "album-1", name: "EQUILIBRIVM" }],
      },
    },
  ]);

  const track: any = normalizeTopItem(item, "tracks");
  assert.equal(track.primaryArtistName, "Anitta");
  assert.deepEqual(track.secondaryArtists.map((artist: any) => artist.name), ["Los Brasileros"]);
  assert.equal(urls.some((url) => url.pathname.endsWith("/api/v1/albums/album-1")), true);
});

test("multi-artist tracks can use Apple Music artistName when album owner is missing", async () => {
  const urls: URL[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    urls.push(url);

    if (url.hostname === "itunes.apple.com" && url.pathname === "/lookup") {
      return jsonResponse({
        resultCount: 1,
        results: [
          {
            wrapperType: "track",
            kind: "song",
            trackId: 999001,
            artistName: "Halsey & Amy Lee",
            trackName: "Hand That Feeds",
          },
        ],
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const [item] = await enrichTrackItemsWithAlbumOwners([
    {
      position: 1,
      streams: 10,
      track: {
        id: "track-apple-owner",
        appleMusicId: "999001",
        name: "Hand That Feeds - From the Film Ballerina",
        artists: [
          { id: "amy-lee", name: "Amy Lee" },
          { id: "halsey", name: "Halsey" },
          { id: "evanescence", name: "Evanescence" },
        ],
        albums: [{ id: "album-ownerless", name: "Hand That Feeds - Single" }],
      },
    },
  ]);

  const track: any = normalizeTopItem(item, "tracks");
  assert.equal(track.primaryArtistName, "Halsey");
  assert.deepEqual(track.secondaryArtists.map((artist: any) => artist.name), ["Amy Lee", "Evanescence"]);
  assert.equal(urls.some((url) => url.hostname === "itunes.apple.com" && url.searchParams.get("id") === "999001"), true);
  assert.equal(urls.some((url) => url.pathname.endsWith("/api/v1/albums/album-ownerless")), false);
});

test("ownerless albums infer primary artist from album tracks", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/albums/album-1")) {
      return jsonResponse({
        item: {
          id: "album-1",
          name: "Ownerless Album",
          artists: [],
        },
      });
    }

    if (url.pathname.endsWith("/albums/album-1/tracks")) {
      return jsonResponse({
        items: [
          { name: "A", artists: [{ id: "main", name: "Main Artist" }] },
          { name: "B", artists: [{ id: "main", name: "Main Artist" }] },
          {
            name: "C",
            artists: [
              { id: "guest", name: "Guest Artist" },
              { id: "main", name: "Main Artist" },
            ],
          },
        ],
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const [item] = await enrichAlbumItemsWithOwners([
    {
      position: 1,
      album: {
        id: "album-1",
        name: "Ownerless Album",
        artists: [],
      },
    },
  ]);

  const album = normalizeTopItem(item, "albums") as any;
  assert.equal(album.artistName, "Main Artist");
  assert.equal(album.primaryArtistName, "Main Artist");
});

test("replay exposes real total duration from stats", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/streams/stats")) {
      return jsonResponse({
        items: {
          count: 42,
          durationMs: 12_345_678,
        },
      });
    }

    if (url.pathname.endsWith("/top/artists")) return jsonResponse({ items: [] });
    if (url.pathname.endsWith("/top/tracks")) return jsonResponse({ items: [] });
    if (url.pathname.endsWith("/top/albums")) return jsonResponse({ items: [] });

    return jsonResponse({ error: "not_found" }, 404);
  };

  const { res, captured } = createResponseCapture();

  await replayHandler({
    query: {
      user: "leo",
      period: "month",
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.totalSongs, 42);
  assert.equal(captured.body.totalDurationMs, 12_345_678);
  assert.equal(captured.body.durationMs, 12_345_678);
  assert.equal(captured.body.minutes, 205);
});

test("stream album evidence replaces top track album before normalization", async () => {
  const requestedPaths: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requestedPaths.push(url.pathname);

    if (url.pathname.endsWith("/users/user-1/streams/albums/album-main")) {
      return jsonResponse({
        items: [
          {
            trackId: "track-1",
            albumId: "album-main",
            trackName: "Song From Album",
          },
        ],
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const [item] = await enrichTrackItemsWithAlbumOwners([
    {
      track: {
        id: "track-1",
        name: "Song From Single",
        artists: [{ id: "artist-1", name: "Main Artist" }],
        albums: [{ id: "single-1", name: "Wrong Single", image: "https://img.test/single.jpg" }],
      },
    },
  ], {
    userId: "user-1",
    after: 1000,
    albumItems: [
      {
        album: {
          id: "album-main",
          name: "Main Album",
          image: "https://img.test/main.jpg",
          artists: [{ id: "artist-1", name: "Main Artist" }],
        },
      },
    ],
  });

  const track = normalizeTopItem(item, "tracks") as any;
  assert.equal(track.albumId, "album-main");
  assert.equal(track.albumName, "Main Album");
  assert.equal(track.album.primaryArtistName, "Main Artist");
  assert.equal(requestedPaths.includes("/api/v1/users/user-1/streams/albums/album-main"), true);
});

test("track stream evidence can replace top track album without top album match", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/users/user-1/streams/tracks/track-1")) {
      return jsonResponse({
        items: [
          { trackId: "track-1", albumId: "album-main" },
          { trackId: "track-1", albumId: "album-main" },
          { trackId: "track-1", albumId: "single-1" },
        ],
      });
    }

    if (url.pathname.endsWith("/albums/album-main")) {
      return jsonResponse({
        item: {
          id: "album-main",
          name: "Main Album",
          artists: [{ id: "artist-1", name: "Main Artist" }],
        },
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const [item] = await enrichTrackItemsWithAlbumOwners([
    {
      track: {
        id: "track-1",
        name: "Song From Single",
        artists: [{ id: "artist-1", name: "Main Artist" }],
        albums: [{ id: "single-1", name: "Wrong Single" }],
      },
    },
  ], {
    userId: "user-1",
    after: 1000,
    albumItems: [],
  });

  const track = normalizeTopItem(item, "tracks") as any;
  assert.equal(track.albumId, "album-main");
  assert.equal(track.albumName, "Main Album");
});

test("latest track stream evidence can prefer current album over historical majority", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/users/user-1/streams/tracks/track-1")) {
      return jsonResponse({
        items: [
          { trackId: "track-1", albumId: "album-main" },
          { trackId: "track-1", albumId: "single-1" },
          { trackId: "track-1", albumId: "single-1" },
        ],
      });
    }

    if (url.pathname.endsWith("/albums/album-main")) {
      return jsonResponse({
        item: {
          id: "album-main",
          name: "Main Album",
          artists: [{ id: "artist-1", name: "Main Artist" }],
        },
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const [item] = await enrichTrackItemsWithAlbumOwners([
    {
      track: {
        id: "track-1",
        name: "Song From Single",
        artists: [{ id: "artist-1", name: "Main Artist" }],
        albums: [{ id: "single-1", name: "Wrong Single" }],
      },
    },
  ], {
    userId: "user-1",
    useTrackStreamEvidence: true,
    trackStreamEvidenceStrategy: "latest",
  });

  const track = normalizeTopItem(item, "tracks") as any;
  assert.equal(track.albumId, "album-main");
  assert.equal(track.albumName, "Main Album");
});

test("stream row album id replaces recent track album with album detail", async () => {
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));

    if (url.pathname.endsWith("/albums/album-main")) {
      return jsonResponse({
        item: {
          id: "album-main",
          name: "Main Album",
          artists: [{ id: "artist-1", name: "Main Artist" }],
        },
      });
    }

    return jsonResponse({ error: "not_found" }, 404);
  };

  const [item] = await enrichTrackItemsWithAlbumOwners([
    {
      albumId: "album-main",
      track: {
        id: "track-1",
        name: "Song From Single",
        artists: [{ id: "artist-1", name: "Main Artist" }],
        albums: [{ id: "single-1", name: "Wrong Single" }],
      },
    },
  ], { cacheProfile: "live" });

  const track = normalizeTopItem(item, "tracks") as any;
  assert.equal(track.albumId, "album-main");
  assert.equal(track.albumName, "Main Album");
  assert.equal(track.album.primaryArtistName, "Main Artist");
});
