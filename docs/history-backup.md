# History Backup

This document describes the closed-month stream history backup.

## Policy

- The current month stays on the existing stats.fm + cache path.
- Closed months are archived into Postgres/Neon.
- The scheduled workflow backs up only the previous month for `leo`.
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

Backfill a range of closed months:

```bash
npm run history:backfill -- --user=leo --from=2024-01 --to=2024-12
```

Back up the previous closed month:

```bash
npm run history:backup-previous-month -- --user=leo
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
4. Let the monthly workflow maintain only the previous closed month.
5. Repeat manually for other configured users after `leo` is validated.

## Notes

- Rows are deduped by a stable source hash derived from user, timestamp, track, album, and duration.
- `stream_month_backups` records monthly status and makes retries safe.
- A partial month keeps saved rows and can be retried with `history:reconcile`.
