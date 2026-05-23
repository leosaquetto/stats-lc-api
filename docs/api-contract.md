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

## Additional Public Endpoints

- `/api/group-live`
  - Lightweight group live surface for Home/now-playing polling.
  - Exposes `ok`, `source`, `generatedAt`, and `members`.
  - Each member includes `key`, `id`, minimal `profile`, `platform`, and `nowPlaying`.
  - Does not include stats, tops, leaderboard data, or cache metadata.
- `/api/entity-group-stats`
  - Aggregates one entity stat lookup across all configured group users.
  - Query: `type=track|artist|album` and `id=<entity id>`, with optional `force=1`.
  - Exposes `members[].{key,id,count,durationMs,minutes}`.
  - Partial user-level upstream failures are contained per member instead of failing the whole response.
- `/api/stats-cardinality`
  - Exposes `streams`, `durationMs`, `minutes`, `hours`, and `cardinality.{artists,tracks,albums}` for a `user` + `after` range, with optional `before` and `force=1`.
- `/api/stats-dates`
  - Exposes stable zero-filled `hours`, `months`, `weekDays`, and `monthDays` bucket maps for a `user` + `after` range, with optional `before` and `force=1`.
- `/api/entity`
  - Query: `type=track|artist|album` and `id=<entity id>`, with optional `force=1`.
  - Returns a normalized `entity` object for stats.fm track, artist, or album detail pages.
- `/api/entity-streams`
  - Query: `type=track|artist|album`, `id=<entity id>`, `user=<user>`, optional `limit`, `offset`, `after`, `before`, and `force=1`.
  - Returns normalized stream rows for a user's plays of that entity.
- `/api/entity-listeners`
  - Query: `type=track|artist|album`, `id=<entity id>`, optional `friends=1`, `limit`, `offset`, and `force=1`.
  - Returns top listener rows with `position`, `streams`, `playedMs`, `indicator`, and normalized user summary.
- `/api/album-tracks`
  - Query: `id=<album id>`, with optional `force=1`.
  - Returns normalized tracks for an album page.
- `/api/artist-catalog`
  - Query: `id=<artist id>` and `section=tracks|top-tracks|albums|top-albums|related`, with optional `limit`, `offset`, and `force=1`.
  - Returns normalized tracks, albums, or related artists for artist page sections.
- `/api/user-friends`
  - Query: `user=<user>`, with optional `force=1`.
  - Returns normalized friends plus a best-effort `count`; count lookup failure is isolated under `errors.count`.
- `/api/user-streams`
  - Query: `user=<user>`, optional `limit`, `offset`, `after`, `before`, and `force=1`.
  - Returns normalized stream rows for the user stream/recent-streams pages.
- `/api/search`
  - Query: `q=<query>` or `query=<query>`, optional `type=track,artist,album,user`, `limit`, and `force=1`.
  - Returns typed normalized search results.
- `/api/compare`
  - Query: `users=<csv>` with 2 to 5 aliases or stats.fm IDs/custom IDs, optional `period=4w|6m|all|month|week`, explicit `after`/`before` epoch ms, `limit`, and `force=1`.
  - Explicit `after`/`before` takes priority over `period`; presets are calculated in the Sao Paulo timezone.
  - Returns `users`, `summaryByUser`, `common.tracks|artists|albums|genres`, `timeByUser`, `firstStreamsByUser`, `lastStreamsByUser`, and per-user partial `errors`.
  - Common rows are computed locally by matching entity `id` first and `externalIds.spotify/appleMusic` as fallback; rows expose original per-user ranks and `sharedByCount`.

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
- Add a query option to `/api/compare` such as `commonMode=all|any` or `minSharedBy=2`, so the backend can pre-filter common rows for two-user and group comparisons.
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

Primary artist selection prefers the album owner when it matches a track artist, then explicit primary/main artist markers from the raw payload, then the first track artist. Normalized albums also expose `primaryArtist`, `primaryArtistId`, and `primaryArtistName`.
