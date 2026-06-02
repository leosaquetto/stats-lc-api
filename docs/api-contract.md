# API Contract Notes

## Platform and Catalog Fields

### `member.platform`
Represents the **primary platform of the user** in this app context.

- Source: profile/service/import/settings signals, with optional manual fallback.
- Shape: `{ primary, confidence, source, sourceKey, rawValue }`.

### `nowPlaying.platformCandidate`
Represents the **platform candidate from the stream item**, when available.

- It is item-level context (what the stream payload suggests), not the user's global primary platform.

### `track.catalogAvailability`
Represents **catalog availability** for the track.

- Shape: `{ spotify: boolean, appleMusic: boolean }`.
- Meaning: whether the track appears available in each catalog from normalized IDs.
- It does **not** indicate playback origin.

## Important Rule

`externalIds` are used for catalog/discovery mapping only.

- `externalIds` **must not** be used alone to infer playback source/platform origin.

Album selection for user-scoped track payloads has its own durable rule in [`docs/track-album-resolution.md`](./track-album-resolution.md). In short: user stream album evidence wins over public track catalog metadata.

## stats.fm Resilience

`statsfmFetch(path, { force })` remains the only upstream entrypoint and keeps the same public success/error shape consumed by the handlers.

- Responses are cached in memory per normalized `path`.
- Temporal `streams/stats` and `streams/dates` queries with `after`/`before` are internally decomposed into monthly blocks in the Sao Paulo timezone, then recomposed before reaching the handlers.
- Monthly blocks use differentiated fresh TTLs:
  - current month: 5 minutes
  - previous month: 12 hours
  - older months: 7 days
- `force=1` still means "try to refresh", but now respects a short per-path cooldown to avoid burst bypasses.
- Simultaneous requests to the same `path` are deduplicated onto one upstream request.
- Upstream calls use timeout protection and at most 1 retry only for `500`, `502`, `503`, `504`, timeout, and network errors.
- `429`, `400`, `401`, `403`, and `404` do not retry automatically.
- When the upstream fails and there is a recent successful cached value still inside the stale window, handlers may serve that stale value without changing their public payload shape.
- Cardinality lookups use the raw upstream `streams/stats` response for the requested range and are not reconstructed from monthly blocks.
- Cache/debug metadata is intentionally kept out of normal endpoint payloads and is exposed only via `/api/health` and optional debug surfaces.
- Live now-playing calls may opt into an internal `cacheProfile: "live"` with a shorter fresh/stale window. This is still handled inside `statsfmFetch` and does not change normal endpoint payloads.
- Public handlers should stay thin wrappers around shared internal service helpers:
  - `lib/user-stats-service.ts` for stats and date ranges.
  - `lib/user-streams-service.ts` for recent, user, and entity stream lists.
  - `lib/user-tops-service.ts` for top artists/tracks/albums/genres and normalized top payloads.
- Keep the public endpoint contract stable even when consolidating internals; the goal is one upstream/normalization path per data family, not fewer app-facing routes.

## Public Endpoint Reference

All endpoints are `GET` handlers. `user` accepts configured aliases from `lib/users.ts` or raw stats.fm IDs/custom IDs. `force=1` asks the backend to refresh through `statsfmFetch`, but it still respects cooldown, cache, retry, and stale fallback policy.

### Core group and profile endpoints

| Endpoint | Query | Purpose | Response highlights |
| --- | --- | --- | --- |
| `/api/group` | optional `force=1`, `debug=1` | Full group dashboard payload. | `members`, `rankings.today|week|month`, each member's `profile`, `platform`, `catalogSummary`, `nowPlaying`, `recent`, `stats`, `tops`, and per-section `errors`. Debug includes Sao Paulo range anchors and sanitized upstream/cache details. |
| `/api/group-live` | optional `force=1`, `debug=1` | Lightweight Home/now-playing polling surface. | `ok`, `source`, `generatedAt`, and `members`. Each member includes `key`, `id`, minimal `profile`, `platform`, and `nowPlaying`. It intentionally omits stats, tops, leaderboard data, and cache metadata. |
| `/api/user` | `user=<user>`, optional `force=1`, `debug=1` | One user profile summary. | `profile`, resolved `platform`, `legacy` upstream result, and sanitized `raw` only when `debug=1`. |
| `/api/health` | none | Operational snapshot for agents and debugging. | `ok`, `service`, `time`, and `statsfm` cache/retry/metric snapshot. Cache/debug metadata belongs here, not in normal payloads. |

### User stats, recents, and tops

| Endpoint | Query | Purpose | Response highlights |
| --- | --- | --- | --- |
| `/api/recent` | `user=<user>`, optional `limit` default `50`, `offset` default `0`, `force=1` | Recent streams for a user. | Normalized stream `items` from `/streams/recent`. |
| `/api/stats` | `user=<user>`, `after=<epoch ms>`, optional `before=<epoch ms>`, `force=1` | Basic listening totals for a range. | `streams`, `durationMs`, `minutes`, and `hours`. |
| `/api/stats-cardinality` | `user=<user>`, `after=<epoch ms>`, optional `before=<epoch ms>`, `force=1` | Listening totals plus unique entity counts. | `streams`, `durationMs`, `minutes`, `hours`, and `cardinality.{artists,tracks,albums}`. Uses raw upstream stats for the requested range instead of reconstructing cardinality from monthly blocks. |
| `/api/stats-dates` | `user=<user>`, `after=<epoch ms>`, optional `before=<epoch ms>`, `force=1` | Time distribution buckets for charts. | Stable zero-filled `hours`, `months`, `weekDays`, and `monthDays` maps. |
| `/api/top` | `user=<user>`, optional `type=artists|tracks|albums` default `tracks`, `period=today|week|month|all` default `week`, `after=<epoch ms>`, `limit` default `20`, `force=1` | Normalized top artists/tracks/albums. | `items` normalized by `type`; explicit `after` overrides the period-derived range. |
| `/api/replay` | `userId=<user id>` or `user=<user>`, optional `period=today|week|month|year|all` default `today`, `period=lifetime` accepted as an alias for `all`, `force=1` | Single payload for the Replay section. | `period`, `totalSongs`, `totalDurationMs`, `durationMs`, `minutes`, `hours`, `topArtists` top 20, `topTracks` top 30, and `topAlbums` top 15. Top-list failures are isolated under optional `errors`; stats failure fails the request. |

Track and album-bearing responses include `dominantColor` when artwork sampling succeeds. This is calculated server-side from the artwork URL and cached in-process by URL so the app can render the LeoHeader/vinyl/progress accent without doing canvas work on the client. Clients should keep their local color extraction only as a fallback for old payloads or temporary sampling failures.
| `/api/lyrics` | `title=<track title>`, optional `artist=<artist name>`, `includeLyrics=1`, `includeWriters=1` | Genius lyrics availability match. | Uses the server-side `GENIUS_ACCESS_TOKEN` to search Genius and returns `hasLyrics` plus `match.{title,artist,url,confidence}`. With `includeLyrics=1`, it also attempts best-effort page extraction from Genius' modern `data-lyrics-container` blocks and returns `lyrics` when available. With `includeWriters=1`, it fetches Genius song metadata and returns `writers` as an array of writer names. It never exposes the Genius token. |
| `/api/user-streams` | `user=<user>`, optional `limit`, `offset`, `after`, `before`, `force=1` | Stream history page data. | Normalized stream `items` for `/users/:id/streams`. |
| `/api/user-friends` | `user=<user>`, optional `force=1` | Friends page data. | Normalized friend `items` plus best-effort `count`; count lookup failure is isolated under `errors.count`. |

`/api/lyrics` returns `hasLyrics: false` with `reason: "not_configured"` when `GENIUS_ACCESS_TOKEN` is missing, so clients can hide lyrics UI without treating that as a hard API failure. Full lyrics extraction depends on Genius page HTML and can return `lyrics: null` with reasons such as `lyrics_upstream_403` if the page blocks server-side access.
After changing `GENIUS_ACCESS_TOKEN` in Vercel, redeploy the API so serverless functions receive the updated runtime environment.

### Entity and catalog endpoints

| Endpoint | Query | Purpose | Response highlights |
| --- | --- | --- | --- |
| `/api/entity` | `type=track|artist|album`, `id=<entity id>`, optional `force=1` | Entity detail page data. | Normalized `entity` object for stats.fm track, artist, or album detail pages. |
| `/api/entity-stats` | `user=<user>`, `type=track|artist|album`, `id=<entity id>`, optional `after`, `before`, `force=1` | One user's aggregated stats for one entity, optionally scoped to a timestamp range. | `count`, `durationMs`, and `minutes`. |
| `/api/entity-group-stats` | `type=track|artist|album`, `id=<entity id>`, optional `force=1` | Group-wide stats for one entity. | `generatedAt` and `members[].{key,id,count,durationMs,minutes}`. Partial user-level upstream failures are contained per member instead of failing the whole response. |
| `/api/entity-streams` | `type=track|artist|album`, `id=<entity id>`, `user=<user>`, optional `limit`, `offset`, `after`, `before`, `force=1` | A user's play history for one entity. | Normalized stream `items`. |
| `/api/entity-listeners` | `type=track|artist|album`, `id=<entity id>`, optional `friends=1`, `limit`, `offset`, `force=1` | Entity top listener ranking. | Rows with `position`, `streams`, `playedMs`, `indicator`, and normalized user summary. |
| `/api/album-tracks` | `id=<album id>`, optional `force=1` | Album track list. | Normalized track `items`. |
| `/api/artist-catalog` | `id=<artist id>`, `section=tracks|top-tracks|albums|top-albums|related`, optional `limit`, `offset`, `force=1` | Artist page catalog sections. | Normalized tracks, albums, or related artists depending on `section`. |

### Discovery and comparison endpoints

| Endpoint | Query | Purpose | Response highlights |
| --- | --- | --- | --- |
| `/api/search` | `q=<query>` or `query=<query>`, optional `type=track,artist,album,user`, `limit`, `force=1` | Typed search facade. | `items[]` shaped as `{ type, item }`, with normalized track/artist/album/user payloads when recognized. |
| `/api/compare` | `users=<csv>` with 2 to 5 aliases or stats.fm IDs/custom IDs, optional `period=4w|6m|all|month|week`, explicit `after`/`before` epoch ms, `limit` default `250` max `500`, `commonMode=any|all`, `minSharedBy=2..userCount`, `force=1` | Rich comparison across users. | `users`, `summaryByUser`, `commonFilter`, `common.tracks|artists|albums|genres`, `timeByUser`, `firstStreamsByUser`, `lastStreamsByUser`, and per-user partial `errors`. Explicit `after` takes priority over `period`; presets are calculated in the Sao Paulo timezone. Common rows match entity `id` first and `externalIds.spotify/appleMusic` as catalog fallback, expose original per-user ranks, `score`, and `sharedByCount`. By default common rows are shared by at least 2 users; `commonMode=all` requires every requested user, and `minSharedBy` can set an explicit threshold. |

### Orbits endpoints

| Endpoint | Query/body | Purpose | Response highlights |
| --- | --- | --- | --- |
| `/api/orbits` | `GET user=<id>&box=received|sent|all`; `POST { fromUserId, toUserId, track, message? }` | List or create music suggestions between circle members. | Orbit rows include normalized `track`, `status`, timestamps, `targetPlatform`, `listenUrl`, and `listenCountSinceSent`. List reads return stored data immediately; listen audits are refreshed explicitly through `check-listens`. Creation validates known distinct circle members and a usable track identity. Uses Postgres/Neon when `DATABASE_URL` or `POSTGRES_URL` is configured, otherwise falls back to in-memory storage. |
| `/api/orbits/summary` | `user=<id>` | Count orbit activity for one user. | `received`, `sent`, `sentListened`, and `unread`. |
| `/api/orbits/:id/seen` | none | Mark an orbit as seen. | Returns updated `orbit`. |
| `/api/orbits/:id/opened` | none | Mark the listen link as opened. | Returns updated `orbit`. |
| `/api/orbits/:id/dismiss` | none | Dismiss/archive an orbit. | Returns updated `orbit`. |
| `/api/orbits/:id/delete-sent` | none | Hide an orbit from the sender's sent list. | Sets `sender_deleted_at`; recipient can still see it. |
| `/api/orbits/:id/delete-received` | none | Hide an orbit from the recipient's inbox. | Sets `recipient_deleted_at`; sender can still see it. |
| `/api/orbits/:id/check-listens` | none | Refresh listen count after the orbit was sent. | Uses user entity streams without `force=1` and returns updated `orbit`. Clients should call it progressively only for visible stale sent items instead of blocking list reads. |

### Common response conventions

- Success payloads include `ok: true` and usually include the resolved upstream `endpoint`.
- Missing or invalid required params return `ok: false` with stable error strings such as `missing_user`, `missing_user_or_after`, `missing_type_or_id`, `missing_params`, `invalid_type`, `invalid_period`, `missing_users`, `too_many_users`, or `invalid_range`.
- Normal endpoint payloads should not expose `statsfmFetch` cache/cooldown/stale metadata. Use `/api/health` or explicit debug surfaces.
- `debug=1` is intentionally limited to selected endpoints and sanitizes sensitive keys matching token, authorization, cookie, secret, or session.

## Reference App Route Matrix

- `/:id` and `/user/:id/[[...deeplink]]` -> existing `/api/user`, `/api/group`, `/api/group-live`, `/api/top`, `/api/stats`, and the new detail/list endpoints as needed.
- `/:id/friends` and `/user/:id/friends` -> `/api/user-friends`.
- `/:id/streams`, `/:id/recentStreams`, `/:id/recent-streams`, and `/user/:id/streams` -> `/api/user-streams` or existing `/api/recent` for recent-only polling.
- `/:id/artists`, `/:id/albums`, and `/:id/tracks` -> existing `/api/top` with `type=artists|albums|tracks`, plus larger `limit` values when needed.
- `/:id/genres` -> existing upstream-backed top genres are not exposed yet; add only if the app needs the page.
- `/track/[id]`, `/artist/[id]`, and `/album/[id]` -> `/api/entity`.
- `/track/[id]/streams`, `/artist/[id]/streams`, and `/album/[id]/streams` -> `/api/entity-streams`.
- Album track lists -> `/api/album-tracks`.
- Artist tracks, albums, top tracks, top albums, and related artists -> `/api/artist-catalog`.
- Entity top listeners -> `/api/entity-listeners`.
- `/search` -> `/api/search`.
- Dynamic compare screens -> `/api/compare`.

## Improvement Notes

### What is better than the old API surface

- The API no longer needs the frontend to compose many stats.fm calls for profile, entity pages, streams, friends, search, and compare screens. It now exposes focused backend endpoints for those app surfaces.
- Entity pages can be built from normalized API responses instead of raw stats.fm payloads:
  - `/api/entity` for track, artist, and album detail.
  - `/api/album-tracks` for album track lists.
  - `/api/artist-catalog` for artist tracks, albums, top albums, top tracks, and related artists.
  - `/api/entity-streams` and `/api/entity-listeners` for entity history and listener rows.
- User pages can now request friends and stream history directly through `/api/user-friends` and `/api/user-streams`, with aliases from `USERS` or raw stats.fm IDs/custom IDs.
- Search has a stable local contract through `/api/search`, so the app can consume typed normalized rows rather than coupling UI code to upstream result shapes.
- Compare screens can now be generated through `/api/compare` for dynamic users and dynamic ranges, instead of relying on the official app's opaque common-item calculation.
- Common items in `/api/compare` are matched by entity `id` first and `externalIds.spotify/appleMusic` as fallback. This catches shared catalog items even when upstream IDs differ or are missing on one side.
- Compare rows expose original per-user rank, streams, played time, and `sharedByCount`, so the UI can show why an item is considered common instead of hiding discrepant ranks behind a single vague order.
- For 3+ user comparisons, common rows do not require every user to share the item. The API returns `sharedByCount` and per-user presence so the frontend can filter "shared by all" or "shared by some".
- Partial failures are contained per section/user. For example, genres can fail while tracks, artists, albums, summaries, and time data still render.
- Normalized entities now preserve more fields the app needs: `label`, `releaseDate`, `genres`, `followers`, `spotifyPopularity`, previews, `playedMs`, `position`, and `indicator`.
- The new tests no longer depend on the temporary `TESTE/` folder; reference-shaped fixtures are inline and safe to keep after that folder is deleted.

### Current improvement opportunities

- Add a dedicated `/api/top-genres` endpoint if genre pages or genre-only widgets become first-class UI surfaces. Today genres are consumed by `/api/compare` through upstream `top/genres`, but there is no standalone public genre endpoint.
- Tune the `/api/compare` scoring formula with real user examples. The current score is transparent and better than a black-box rank, but it may need weights for rank proximity, minimum shared volume, and balance after UI review.
- Tune frontend usage of `/api/compare` with `commonMode=all|any` and `minSharedBy=2..userCount` so group comparison screens can choose strict or loose affinity without client-side filtering.
- Add `order`/cursor semantics to `/api/user-streams` and `/api/entity-streams` if the upstream supports stable pagination for "first" and "last" streams.
- Promote the temporary test loader setup into a repo-supported test command or tsconfig/build path. Right now local tests need a loader because source imports use `.js` while files are `.ts`.
- Add response-size guardrails for `/api/compare` when `limit` is high and user count is near the maximum, especially before exposing large ranges broadly in production.
- Consider a small debug-only section for `/api/compare` that reports upstream endpoints hit and section timing, while keeping cache/cooldown/stale metadata out of normal payloads.
- Add snapshot-style contract tests for `/api/compare` payload shape once the frontend locks the UI contract.

## Normalized Entity Fields

Normalized tracks keep their existing fields and additionally expose primary-artist helpers:

- `track.primaryArtist`
- `track.primaryArtistId`
- `track.primaryArtistName`
- `track.secondaryArtists`

Primary artist selection prefers the album owner when it matches a track artist, then explicit primary/main artist markers from the raw payload, then the first track artist. When multi-artist tracks arrive with an album object that has no owner, track-returning endpoints enrich the album from available top-album data or album detail before normalization. User-scoped top/replay/compare track lists can also use `/users/:id/streams/tracks/:trackId` and `/users/:id/streams/albums/:albumId` evidence to replace a catalog-assigned single/video album with the album actually present in that user's listening history for the requested period. Album-returning endpoints also enrich ownerless albums from album detail before normalization. Normalized albums expose `artist`, `artistId`, `artistName`, `primaryArtist`, `primaryArtistId`, and `primaryArtistName`.
