# History Backup

This document describes the adaptive weekly backup of full stats.fm stream
history.

## Policy

- The backup reads only `/users/:id/streams` and `/streams/stats`.
- `/streams/recent` is never stored, polled, or used to prove backup coverage.
- GitHub Actions runs every Sunday at `05:17 UTC`.
- Users are processed sequentially to keep upstream load predictable.
- The current month is upserted every week with status `open`.
- Closed months are only served locally after they reach `complete`.
- A dormant user's pending reconciliation window remains open and grows until
  their full history advances.

## Adaptive Window

Each user has persistent maintenance state:

- latest event observed in full `/streams` history;
- pending reconciliation start;
- last check;
- last monthly count change;
- observed import and sync flags.

The first weekly run reconstructs this state from stored events. The pending
window starts in the month of the latest known historical activity.

Every Sunday the maintenance checks monthly counts from the pending month
through the current month:

1. A new month, changed count, incomplete status, or current month is
   reconciled from full `/streams`.
2. When the latest full-history event advances, every month in the absence
   window is downloaded again.
3. After successful reconciliation, the window advances to the month of the
   latest event while preserving two earlier months.
4. A `hasImported=false` to `hasImported=true` transition starts a complete
   backfill from `2016-01`.

The window can grow indefinitely while a user does not synchronize. Opening a
public profile is not treated as synchronization.

## Monthly Statuses

- `open`: current month; rows are upserted weekly but coverage is incomplete.
- `awaiting_sync`: closed month not yet proven by a later full-history event.
- `complete`: closed month, all pages fetched, and stored count equals expected
  count after synchronization advanced beyond the month.
- `partial`: expected rows or pages are missing.
- `needs_review`: stored count exceeds the current upstream monthly count.
- `pending`, `running`, `failed`: operational states for active or failed work.

An empty month after the latest known event remains `awaiting_sync`. If history
later advances beyond it, the month is fetched again and can become `complete`
only after remaining empty or after delayed streams are stored.

## Required Secret

Set one of these GitHub Actions secrets:

- `DATABASE_URL`
- `POSTGRES_URL`

They should point to the same Neon/Postgres project used by the API.

## Commands

Run the same maintenance used by the Sunday workflow:

```bash
npm run history:maintain-weekly -- --user=all
```

Estimate monthly volume without saving streams:

```bash
npm run history:estimate -- --user=leo --from=2016-01 --to=2026-05
```

Backfill or reconcile manually:

```bash
npm run history:backfill -- --user=leo --from=2024-01 --to=2024-12
npm run history:reconcile -- --user=leo --month=2024-09
```

Inspect stored coverage:

```bash
npm run history:status -- --user=leo
```

`history:backup-previous-month` remains available as a manual compatibility
command, but it is no longer the scheduled maintenance policy.

## Local API Path

`/api/user-streams` may read Postgres only when:

- `after` and `before` exactly cover one or more closed calendar months;
- every requested month is marked `complete`;
- the request is not forced.

`open`, `awaiting_sync`, `partial`, `needs_review`, missing coverage, current
month, and arbitrary date ranges continue to use stats.fm. The response exposes
`source` and optional `coverage` metadata without changing normalized `items`.

## Notes

- Rows are deduped by a stable source hash derived from user, timestamp, track,
  album, and duration.
- Upserts make weekly reruns idempotent.
- Existing events and month records are preserved during state migration.
- The first weekly execution re-evaluates empty months that were previously
  marked complete without synchronization proof.
