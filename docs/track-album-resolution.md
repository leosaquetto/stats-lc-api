# Track Album Resolution Rule

This document records a non-negotiable normalization rule for stats-lc-api.

## Problem

stats.fm can expose different album data for the same track depending on the surface:

- Public track/catalog metadata can point to a single, EP, video, or otherwise incorrect album.
- User stream history can contain the album that was actually listened to.
- Album stream pages can show a track under the correct user-history album even when the public track page does not.

Because of this, the API must not trust only `track.album`, `track.albums[0]`, or public `/tracks/:id` metadata when returning user-facing track payloads.

## Rule

For user-scoped track payloads, prefer the album from the user's listening history over the public catalog-assigned album.

The correct album evidence order is:

1. Stream row `albumId`, when present.
2. `/users/:userId/streams/tracks/:trackId` evidence for the requested user/range.
3. `/users/:userId/streams/albums/:albumId` evidence from candidate albums in the same user/range.
4. Existing album detail/owner enrichment.
5. Album track-list catalog evidence from `/albums/:albumId/tracks`, matched by track ID, Spotify/Apple Music ID, then canonical title.
6. Public track catalog album as fallback only.

Once the real album is found, apply it before normalization so `albumId`, `albumName`, `album.artistName`, `album.primaryArtistName`, `primaryArtistName`, and secondary artist selection all derive from the corrected album.

## Surfaces That Must Keep This

These surfaces must preserve album correction:

- `/api/group-live` for live now/reproduzindo agora.
- `/api/user-streams?resolveAlbums=1` for timeline/history.
- `/api/recent?resolveAlbums=1` for recent history.
- `/api/entity-streams?resolveAlbums=1` for track/entity history modals.
- `/api/top?type=tracks` for top tracks.
- `/api/replay` for replay track lists.
- `/api/compare` for compared top tracks.

If a future optimization touches any of these paths, it must verify album correction still applies.

## Performance Guidance

Live now should stay lightweight:

- First use the `albumId` already present on the recent stream row.
- Clamp recent upstream results to the single row used by `nowPlaying`; stats.fm may return more items than requested.
- Only use track-stream evidence when the direct stream album is missing or insufficient.
- For live/recent surfaces, track-stream evidence must prefer the latest stream row, not the historical majority. The user is asking "what is this current/recent play?", so a single/video album that won historically must not override the most recent album evidence.
- Polling clients that already have `/api/group` profile data should call `/api/group-live?profile=0` so live refresh does not wait on user profile lookups.
- Avoid broad album scans in live polling.

Home/group initial load should not enrich every recent row:

- `/api/group` may enrich only the first recent item because that item powers `nowPlaying` and the primary vinyl.
- Full user-visible history/timeline correction belongs to `/api/user-streams?resolveAlbums=1`, `/api/recent?resolveAlbums=1`, and `/api/entity-streams?resolveAlbums=1`.
- Do not make initial Home rendering wait for expensive album resolution on recent rows that are not immediately shown as the current play.

History/timeline can opt in with `resolveAlbums=1`:

- Use this for user-visible history where wrong album IDs are noticeable.
- Keep it explicit so bulk background history fetches can make a conscious performance choice.

Top/replay/compare should use user/range evidence because these surfaces influence artist ownership and ranking display. For aggregate surfaces, historical/range majority can still be the right signal.

## Regression Examples

Known examples that motivated this rule:

- Track `355354351` / "Choka Choka" can be assigned to a single publicly, but user history can place it under album `66372189` / `EQUILIBRIVM`.
- Track `1293521` / "Lucky" can be assigned to a video/single publicly, but user history can place it under album `55979903` / `Oops!... I Did It Again (25th Anniversary Edition)`.
- Track `315834932` / "Afterlife" can appear as soundtrack/single metadata publicly, but the album track list for `66177205` / `Sanctuary` proves the album-owned catalog row.

The exact IDs may change with upstream data, but the rule must remain: user stream album evidence wins over public track catalog metadata.

## Implementation Pointers

Current central logic lives in:

- `lib/track-album-enrichment.ts`
- `lib/user-streams-service.ts`
- `lib/user-tops-service.ts`

Current regression coverage lives in:

- `tests/stats-extra.test.ts`
