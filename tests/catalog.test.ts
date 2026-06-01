import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import type { VercelResponse } from "@vercel/node";
import albumTracksHandler from "../lib/api-handlers/album-tracks.ts";
import artistCatalogHandler from "../lib/api-handlers/artist-catalog.ts";
import entityHandler from "../lib/api-handlers/entity.ts";
import entityListenersHandler from "../lib/api-handlers/entity-listeners.ts";
import entityStreamsHandler from "../lib/api-handlers/entity-streams.ts";
import lyricsHandler from "../lib/api-handlers/lyrics.ts";
import searchHandler from "../lib/api-handlers/search.ts";
import userFriendsHandler from "../lib/api-handlers/user-friends.ts";
import userStreamsHandler from "../lib/api-handlers/user-streams.ts";
import {
  normalizeAlbum,
  normalizeArtist,
  normalizeRecentItem,
  normalizeTopItem,
  normalizeTrack,
} from "../lib/normalize.ts";
import { __resetStatsfmStateForTests } from "../lib/statsfm.ts";

const originalFetch = globalThis.fetch;
const originalGeniusToken = process.env.GENIUS_ACCESS_TOKEN;

const referenceFixtures = {
  track: {
    albums: [{ id: 165784, image: "https://img.test/album.jpg", name: "Norman Fucking Rockwell!" }],
    artists: [{ id: 12886, name: "Lana Del Rey", image: "https://img.test/artist.jpg" }],
    durationMs: 577199,
    explicit: true,
    externalIds: {
      spotify: ["3hwQhakFwm9soLEBnSDH17"],
      appleMusic: ["1474669067"],
    },
    id: 1592143,
    name: "Venice Bitch",
    spotifyPopularity: 81,
    spotifyPreview: "https://spotify.test/preview.mp3",
    appleMusicPreview: "https://apple.test/preview.m4a",
  },
  artist: {
    externalIds: {
      spotify: ["7FNnA9vBm6EKceENgCGRMb"],
      appleMusic: ["597214610"],
    },
    followers: 81234567,
    genres: ["pop", "art pop"],
    id: 12886,
    image: "https://img.test/lana.jpg",
    name: "Lana Del Rey",
    spotifyPopularity: 88,
  },
  album: {
    name: "Norman Fucking Rockwell!",
    image: "https://img.test/nfr.jpg",
    label: "Polydor Records/Interscope Records",
    spotifyPopularity: 81,
    totalTracks: 14,
    releaseDate: 1567123200000,
    genres: ["Alternative", "Music"],
    artists: [{ id: 12886, name: "Lana Del Rey" }],
    externalIds: {
      spotify: ["5XpEKORZ4y6OrCZSKsi46A"],
      appleMusic: ["1474669063"],
    },
    type: "album",
    id: 165784,
  },
  topArtist: {
    position: 1,
    streams: 427,
    playedMs: 71693525,
    indicator: null,
    artist: {
      id: 12886,
      name: "Lana Del Rey",
      genres: ["pop"],
      followers: 81234567,
    },
  },
  topAlbum: {
    position: 1,
    streams: 246,
    playedMs: 112042754,
    indicator: "NONE",
    album: {
      id: 165784,
      name: "Norman Fucking Rockwell!",
      label: "Polydor Records/Interscope Records",
    },
  },
  listener: {
    position: 1,
    streams: 246,
    playedMs: 112042754,
    indicator: "NONE",
    user: {
      id: "000997.3647cff9cc2b42359d6ca7f79a0f2c91.0428",
      displayName: "leo saquetto",
    },
  },
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalGeniusToken === undefined) {
    delete process.env.GENIUS_ACCESS_TOKEN;
  } else {
    process.env.GENIUS_ACCESS_TOKEN = originalGeniusToken;
  }
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

test("entity returns normalized track detail", async () => {
  let capturedUrl: URL | null = null;

  globalThis.fetch = async (input: string | URL | Request) => {
    capturedUrl = new URL(String(input));
    return jsonResponse({
      item: {
        id: 1592143,
        name: "Venice Bitch",
        spotifyPreview: "https://spotify.test/preview.mp3",
        appleMusicPreview: "https://apple.test/preview.m4a",
        artists: [{ id: 12886, name: "Lana Del Rey" }],
      },
    });
  };

  const { res, captured } = createResponseCapture();

  await entityHandler({ query: { type: "track", id: "1592143" } } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(capturedUrl?.pathname, "/api/v1/tracks/1592143");
  assert.equal(captured.body.entity.spotifyPreview, "https://spotify.test/preview.mp3");
  assert.equal(captured.body.entity.primaryArtistName, "Lana Del Rey");
});

test("entity-streams proxies user entity history with pagination", async () => {
  let capturedUrl: URL | null = null;

  globalThis.fetch = async (input: string | URL | Request) => {
    capturedUrl = new URL(String(input));
    return jsonResponse({
      items: [
        {
          id: "stream-1",
          trackId: 1592143,
          trackName: "Venice Bitch",
          playedMs: 577199,
        },
      ],
    });
  };

  const { res, captured } = createResponseCapture();

  await entityStreamsHandler({
    query: {
      type: "track",
      id: "1592143",
      user: "leo",
      limit: "10",
      offset: "20",
      after: "1000",
    },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(
    capturedUrl?.pathname,
    "/api/v1/users/000997.3647cff9cc2b42359d6ca7f79a0f2c91.0428/streams/tracks/1592143"
  );
  assert.equal(capturedUrl?.searchParams.get("limit"), "10");
  assert.equal(capturedUrl?.searchParams.get("offset"), "20");
  assert.equal(captured.body.items[0].trackId, 1592143);
  assert.equal(captured.body.items[0].trackName, "Venice Bitch");
});

test("entity-listeners returns normalized listener rows", async () => {
  let capturedUrl: URL | null = null;

  globalThis.fetch = async (input: string | URL | Request) => {
    capturedUrl = new URL(String(input));
    return jsonResponse({
      items: [
        {
          position: 1,
          streams: 246,
          playedMs: 112042754,
          indicator: "NONE",
          user: {
            id: "leo",
            customId: "leosaquetto",
            displayName: "leo saquetto",
            profile: { pronouns: "he/him" },
          },
        },
      ],
    });
  };

  const { res, captured } = createResponseCapture();

  await entityListenersHandler({
    query: { type: "track", id: "1592143", friends: "1" },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(capturedUrl?.pathname, "/api/v1/tracks/1592143/top/listeners");
  assert.equal(capturedUrl?.searchParams.get("friends"), "true");
  assert.equal(captured.body.items[0].playedMs, 112042754);
  assert.equal(captured.body.items[0].user.profile.pronouns, "he/him");
});

test("album-tracks returns normalized track list", async () => {
  globalThis.fetch = async () =>
    jsonResponse({
      items: [
        {
          id: 1592143,
          name: "Venice Bitch",
          albums: [{ id: 165784, name: "Norman Fucking Rockwell!", label: "Polydor" }],
        },
      ],
    });

  const { res, captured } = createResponseCapture();

  await albumTracksHandler({ query: { id: "165784" } } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.items[0].album.label, "Polydor");
});

test("artist-catalog supports top albums and related artists", async () => {
  const urls: URL[] = [];

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);

    if (url.pathname.endsWith("/related")) {
      return jsonResponse({ items: [{ id: 1, name: "Related Artist", followers: 10 }] });
    }

    return jsonResponse({
      items: [
        {
          album: {
            id: 165784,
            name: "Norman Fucking Rockwell!",
            label: "Polydor",
          },
        },
      ],
    });
  };

  const first = createResponseCapture();
  await artistCatalogHandler({
    query: { id: "12886", section: "top-albums", limit: "5" },
  } as any, first.res);

  const second = createResponseCapture();
  await artistCatalogHandler({
    query: { id: "12886", section: "related" },
  } as any, second.res);

  assert.equal(first.captured.statusCode, 200);
  assert.equal(urls[0].pathname, "/api/v1/artists/12886/albums/top");
  assert.equal(urls[0].searchParams.get("limit"), "5");
  assert.equal(first.captured.body.items[0].label, "Polydor");
  assert.equal(second.captured.body.items[0].followers, 10);
});

test("user-friends returns friends plus count without failing on count errors", async () => {
  const urls: URL[] = [];

  globalThis.fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);

    if (url.pathname.endsWith("/friends/count")) {
      return jsonResponse({ error: "private" }, 403);
    }

    return jsonResponse({
      items: [
        {
          id: "friend-1",
          customId: "friend",
          displayName: "Friend",
          privacySettings: { friends: true },
        },
      ],
    });
  };

  const { res, captured } = createResponseCapture();

  await userFriendsHandler({ query: { user: "leo" } } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(urls.some((url) => url.pathname.endsWith("/friends")), true);
  assert.equal(urls.some((url) => url.pathname.endsWith("/friends/count")), true);
  assert.equal(captured.body.count, 1);
  assert.equal(captured.body.items[0].privacySettings.friends, true);
  assert.equal(captured.body.errors.count.status, 403);
});

test("user-streams proxies general stream history", async () => {
  let capturedUrl: URL | null = null;

  globalThis.fetch = async (input: string | URL | Request) => {
    capturedUrl = new URL(String(input));
    return jsonResponse({
      items: [{ id: "stream-1", trackId: "track-1", trackName: "Song" }],
    });
  };

  const { res, captured } = createResponseCapture();

  await userStreamsHandler({
    query: { user: "leo", limit: "25", before: "2000" },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(
    capturedUrl?.pathname,
    "/api/v1/users/000997.3647cff9cc2b42359d6ca7f79a0f2c91.0428/streams"
  );
  assert.equal(capturedUrl?.searchParams.get("before"), "2000");
  assert.equal(captured.body.items[0].trackName, "Song");
});

test("search proxies q/type and normalizes typed results", async () => {
  let capturedUrl: URL | null = null;

  globalThis.fetch = async (input: string | URL | Request) => {
    capturedUrl = new URL(String(input));
    return jsonResponse({
      items: [
        { type: "artist", item: { id: 12886, name: "Lana Del Rey", genres: ["Pop"] } },
      ],
    });
  };

  const { res, captured } = createResponseCapture();

  await searchHandler({
    query: { q: "lana", type: "artist", limit: "3" },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(capturedUrl?.pathname, "/api/v1/search");
  assert.equal(capturedUrl?.searchParams.get("query"), "lana");
  assert.equal(capturedUrl?.searchParams.get("type"), "artist");
  assert.deepEqual(captured.body.items[0].item.genres, ["Pop"]);
});

test("lyrics can scrape modern Genius lyrics containers when requested", async () => {
  process.env.GENIUS_ACCESS_TOKEN = "test-token";
  let authorization = "";
  const urls: string[] = [];

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    const url = String(_input);
    urls.push(url);

    if (url.includes("genius.com/Lana-del-rey-venice-bitch-lyrics")) {
      return new Response(`
        <main>
          <div id="lyrics-root">
            <div data-lyrics-container="true">
              White lines, pretty baby<br>
              Tattoos
              <span data-exclude-from-selection="true">Embed</span>
            </div>
            <div data-lyrics-container="true">
              Don't make me sad<br>
              Don't make me cry
            </div>
          </div>
        </main>
      `, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    }

    if (url.includes("api.genius.com/songs/123")) {
      return jsonResponse({
        meta: { status: 200 },
        response: {
          song: {
            writer_artists: [
              { id: 12886, name: "Lana Del Rey" },
              { id: "rick", name: "Rick Nowels" },
            ],
          },
        },
      });
    }

    authorization = String((init?.headers as any)?.Authorization || "");
    return jsonResponse({
      meta: { status: 200 },
      response: {
        hits: [
          {
            result: {
              id: 123,
              title: "Venice Bitch",
              full_title: "Venice Bitch by Lana Del Rey",
              url: "https://genius.com/Lana-del-rey-venice-bitch-lyrics",
              path: "/Lana-del-rey-venice-bitch-lyrics",
              lyrics_state: "complete",
              primary_artist: { name: "Lana Del Rey" },
              song_art_image_thumbnail_url: "https://img.test/thumb.jpg",
            },
          },
        ],
      },
    });
  };

  const { res, captured } = createResponseCapture();

  await lyricsHandler({
    query: { title: "Venice Bitch", artist: "Lana Del Rey", includeLyrics: "1" },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.ok, true);
  assert.equal(captured.body.hasLyrics, true);
  assert.equal(captured.body.match.url, "https://genius.com/Lana-del-rey-venice-bitch-lyrics");
  assert.equal(captured.body.lyrics, "White lines, pretty baby\nTattoos\nDon't make me sad\nDon't make me cry");
  assert.deepEqual(captured.body.writers, ["Lana Del Rey", "Rick Nowels"]);
  assert.equal(authorization, "Bearer test-token");
  assert.equal(urls.length, 3);
});

test("lyrics match ignores remaster suffixes in track titles", async () => {
  process.env.GENIUS_ACCESS_TOKEN = "test-token";

  globalThis.fetch = async () => jsonResponse({
    meta: { status: 200 },
    response: {
      hits: [
        {
          result: {
            id: 2907,
            title: "Dirty Diana",
            full_title: "Dirty Diana by Michael Jackson",
            url: "https://genius.com/Michael-jackson-dirty-diana-lyrics",
            path: "/Michael-jackson-dirty-diana-lyrics",
            lyrics_state: "complete",
            primary_artist: { name: "Michael Jackson" },
          },
        },
      ],
    },
  });

  const { res, captured } = createResponseCapture();

  await lyricsHandler({
    query: { title: "Dirty Diana - 2012 Remaster", artist: "Michael Jackson" },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.hasLyrics, true);
  assert.equal(captured.body.match.id, 2907);
  assert.equal(captured.body.match.title, "Dirty Diana");
  assert.equal(captured.body.match.score, 1);
});

test("lyrics match retries without parenthetical featured artists", async () => {
  process.env.GENIUS_ACCESS_TOKEN = "test-token";
  const queries: string[] = [];

  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    queries.push(url.searchParams.get("q") || "");

    if (queries.length === 1) {
      return jsonResponse({ meta: { status: 200 }, response: { hits: [] } });
    }

    return jsonResponse({
      meta: { status: 200 },
      response: {
        hits: [
          {
            result: {
              id: 10780463,
              title: "GET UP BITCH! shake ya ass",
              full_title: "GET UP BITCH! shake ya ass by Victoria & Anitta",
              url: "https://genius.com/Victoria-and-anitta-get-up-bitch-shake-ya-ass-lyrics",
              path: "/Victoria-and-anitta-get-up-bitch-shake-ya-ass-lyrics",
              lyrics_state: "complete",
              primary_artist: { name: "Victoria" },
            },
          },
        ],
      },
    });
  };

  const { res, captured } = createResponseCapture();

  await lyricsHandler({
    query: { title: "GET UP BITCH! shake ya ass (with Victoria & Anitta)", artist: "Victoria" },
  } as any, res);

  assert.equal(captured.statusCode, 200);
  assert.equal(captured.body.hasLyrics, true);
  assert.equal(captured.body.match.id, 10780463);
  assert.deepEqual(queries, [
    "GET UP BITCH! shake ya ass (with Victoria & Anitta) Victoria",
    "GET UP BITCH! shake ya ass Victoria",
  ]);
});

test("reference-shaped fixtures preserve labels and fields in normalizers", () => {
  const track = normalizeTrack(referenceFixtures.track);
  const artist = normalizeArtist(referenceFixtures.artist);
  const album = normalizeAlbum(referenceFixtures.album);
  const topArtist = normalizeTopItem(referenceFixtures.topArtist, "artists");
  const topAlbum = normalizeTopItem(referenceFixtures.topAlbum, "albums");
  const listener = normalizeRecentItem(referenceFixtures.listener);

  assert.equal(track.spotifyPreview?.startsWith("https://"), true);
  assert.equal(track.appleMusicPreview?.startsWith("https://"), true);
  assert.equal(artist.followers !== null, true);
  assert.equal(Array.isArray(artist.genres), true);
  assert.equal(album.label !== null, true);
  assert.equal(album.releaseDate !== null, true);
  assert.equal(topArtist.position, 1);
  assert.equal(topAlbum.playedMs !== null, true);
  assert.equal(listener.position, 1);
  assert.equal(listener.indicator, "NONE");
});
