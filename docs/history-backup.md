# History Backup

This document describes the closed-month stream history backup.

## Policy

- The current month stays on the existing stats.fm + cache path.
- Closed months are archived into Postgres/Neon.
- The scheduled workflow backs up only the previous closed month for every configured user.
- Older months are reconciled only by manual command.

## Required Secret

Set one of these GitHub Actions secrets:

- `DATABASE_URL`
- `POSTGRES_URL`

They should point to the same Neon/Postgres project used by the API.

## Commands

Estimate monthly volume without saving streams:

```bash
npm run history:estimate -- --user=leo --from=2016-01 --to=2026-05
```

Use `all` or a comma-separated list to run the same command for multiple users:

```bash
npm run history:estimate -- --user=all --from=2026-05 --to=2026-05
npm run history:estimate -- --user=gab,savio --from=2026-05 --to=2026-05
```

Backfill a range of closed months:

```bash
npm run history:backfill -- --user=leo --from=2024-01 --to=2024-12
```

Back up the previous closed month:

```bash
npm run history:backup-previous-month -- --user=all
```

Reconcile one old month manually:

```bash
npm run history:reconcile -- --user=leo --month=2024-09
```

Inspect stored coverage:

```bash
npm run history:status -- --user=leo
```

## Rollout

1. Run `history:estimate` for `leo`.
2. Backfill one small closed month and confirm `expectedCount === storedCount`.
3. Backfill all closed months for `leo`.
4. Run `history:estimate -- --user=all` for one closed month to check every account.
5. Backfill each remaining user in controlled ranges, preferably one user at a time.
6. Let the monthly workflow maintain only the previous closed month for all configured users.

## Local API Path

The first local read surface is internal:

- `historyStore.listCompleteMonths(userKey, afterMs, beforeMs)` checks coverage.
- `historyStore.listEvents(...)` reads paginated local stream rows.
- `fetchLocalHistoryStreams(...)` only returns data when the requested range exactly matches complete closed months.

Public API endpoints should keep using stats.fm for the current month and any partial range. When a closed-month range is fully covered locally, they can swap to `fetchLocalHistoryStreams` without changing response contracts.

## Notes

- Rows are deduped by a stable source hash derived from user, timestamp, track, album, and duration.
- `stream_month_backups` records monthly status and makes retries safe.
- A partial month keeps saved rows and can be retried with `history:reconcile`.
