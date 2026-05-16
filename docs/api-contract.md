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
- `force=1` still means "try to refresh", but now respects a short per-path cooldown to avoid burst bypasses.
- Simultaneous requests to the same `path` are deduplicated onto one upstream request.
- Upstream calls use timeout protection and at most 1 retry only for `500`, `502`, `503`, `504`, timeout, and network errors.
- `429`, `400`, `401`, `403`, and `404` do not retry automatically.
- When the upstream fails and there is a recent successful cached value still inside the stale window, handlers may serve that stale value without changing their public payload shape.
- Cache/debug metadata is intentionally kept out of normal endpoint payloads and is exposed only via `/api/health` and optional debug surfaces.
