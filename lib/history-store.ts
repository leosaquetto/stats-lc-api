import { neon } from "@neondatabase/serverless";

export type HistoryMonthStatus =
  | "pending"
  | "running"
  | "open"
  | "awaiting_sync"
  | "complete"
  | "partial"
  | "failed"
  | "needs_review";

export type StreamHistoryEvent = {
  sourceHash: string;
  userKey: string;
  userId: string;
  platform?: string | null;
  playedAt: string;
  playedAtMs: number;
  trackId?: string | null;
  albumId?: string | null;
  artistId?: string | null;
  playedMs: number;
  raw: any;
};

export type StreamMonthBackup = {
  userKey: string;
  userId: string;
  year: number;
  month: number;
  afterMs: number;
  beforeMs: number;
  expectedCount: number;
  storedCount: number;
  status: HistoryMonthStatus;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
};

export type HistoryStoredStream = StreamHistoryEvent & {
  ingestedAt?: string | null;
  updatedAt?: string | null;
};

export type HistoryUserState = {
  userKey: string;
  userId: string;
  pendingFromMs: number;
  lastEventAtMs: number | null;
  lastCheckedAt: string | null;
  lastCountChangedAt: string | null;
  hasImported: boolean | null;
  syncEnabled: boolean | null;
  createdAt?: string | null;
  updatedAt?: string | null;
};

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const sql = databaseUrl ? neon(databaseUrl) : null;
let schemaReady: Promise<void> | null = null;

const rowToMonthBackup = (row: any): StreamMonthBackup => ({
  userKey: row.user_key,
  userId: row.user_id,
  year: Number(row.year),
  month: Number(row.month),
  afterMs: Number(row.after_ms),
  beforeMs: Number(row.before_ms),
  expectedCount: Number(row.expected_count || 0),
  storedCount: Number(row.stored_count || 0),
  status: row.status,
  error: row.error || null,
  startedAt: row.started_at || null,
  completedAt: row.completed_at || null,
});

const rowToStreamEvent = (row: any): HistoryStoredStream => ({
  sourceHash: row.source_hash,
  userKey: row.user_key,
  userId: row.user_id,
  platform: row.platform || null,
  playedAt: row.played_at instanceof Date ? row.played_at.toISOString() : row.played_at,
  playedAtMs: Number(row.played_at_ms),
  trackId: row.track_id || null,
  albumId: row.album_id || null,
  artistId: row.artist_id || null,
  playedMs: Number(row.played_ms || 0),
  raw: row.raw,
  ingestedAt: row.ingested_at || null,
  updatedAt: row.updated_at || null,
});

const rowToUserState = (row: any): HistoryUserState => ({
  userKey: row.user_key,
  userId: row.user_id,
  pendingFromMs: Number(row.pending_from_ms),
  lastEventAtMs: row.last_event_at_ms == null ? null : Number(row.last_event_at_ms),
  lastCheckedAt: row.last_checked_at || null,
  lastCountChangedAt: row.last_count_changed_at || null,
  hasImported: row.has_imported == null ? null : Boolean(row.has_imported),
  syncEnabled: row.sync_enabled == null ? null : Boolean(row.sync_enabled),
  createdAt: row.created_at || null,
  updatedAt: row.updated_at || null,
});

const ensureSchema = async () => {
  if (!sql) return;
  schemaReady ||= (async () => {
    await sql`
      create table if not exists stream_events (
        source_hash text primary key,
        user_key text not null,
        user_id text not null,
        platform text,
        played_at timestamptz not null,
        played_at_ms bigint not null,
        track_id text,
        album_id text,
        artist_id text,
        played_ms integer not null default 0,
        raw jsonb not null,
        ingested_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await sql`
      create table if not exists stream_month_backups (
        user_key text not null,
        user_id text not null,
        year integer not null,
        month integer not null,
        after_ms bigint not null,
        before_ms bigint not null,
        expected_count integer not null default 0,
        stored_count integer not null default 0,
        status text not null default 'pending',
        error text,
        started_at timestamptz,
        completed_at timestamptz,
        updated_at timestamptz not null default now(),
        primary key (user_key, year, month)
      )
    `;
    await sql`
      create table if not exists stream_history_user_states (
        user_key text primary key,
        user_id text not null,
        pending_from_ms bigint not null,
        last_event_at_ms bigint,
        last_checked_at timestamptz,
        last_count_changed_at timestamptz,
        has_imported boolean,
        sync_enabled boolean,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await sql`create index if not exists stream_events_user_time_idx on stream_events (user_key, played_at desc)`;
    await sql`create index if not exists stream_events_track_idx on stream_events (track_id)`;
    await sql`create index if not exists stream_events_album_idx on stream_events (album_id)`;
    await sql`create index if not exists stream_month_backups_status_idx on stream_month_backups (status, year, month)`;
    await sql`create index if not exists stream_history_user_states_pending_idx on stream_history_user_states (pending_from_ms)`;
  })();
  await schemaReady;
};

function requireSql() {
  if (!sql) {
    throw new Error("DATABASE_URL or POSTGRES_URL is required for history backup storage");
  }
  return sql;
}

export const usingDurableHistoryStore = () => !!sql;

export const historyStore = {
  async ensureReady() {
    requireSql();
    await ensureSchema();
  },

  async upsertMonthStart(input: Omit<StreamMonthBackup, "storedCount" | "status"> & { status?: HistoryMonthStatus }) {
    const db = requireSql();
    await ensureSchema();
    const rows = await db`
      insert into stream_month_backups (
        user_key, user_id, year, month, after_ms, before_ms, expected_count,
        stored_count, status, error, started_at, completed_at
      ) values (
        ${input.userKey}, ${input.userId}, ${input.year}, ${input.month},
        ${input.afterMs}, ${input.beforeMs}, ${input.expectedCount},
        0, ${input.status || "running"}, ${input.error || null}, now(), null
      )
      on conflict (user_key, year, month) do update set
        user_id = excluded.user_id,
        after_ms = excluded.after_ms,
        before_ms = excluded.before_ms,
        expected_count = excluded.expected_count,
        status = excluded.status,
        error = null,
        started_at = now(),
        completed_at = null,
        updated_at = now()
      returning *
    `;
    return rowToMonthBackup(rows[0]);
  },

  async upsertEvents(events: StreamHistoryEvent[]) {
    if (events.length === 0) return 0;
    const db = requireSql();
    await ensureSchema();
    await db`
      insert into stream_events (
        source_hash, user_key, user_id, platform, played_at, played_at_ms,
        track_id, album_id, artist_id, played_ms, raw
      )
      select * from unnest(
        ${events.map((event) => event.sourceHash)}::text[],
        ${events.map((event) => event.userKey)}::text[],
        ${events.map((event) => event.userId)}::text[],
        ${events.map((event) => event.platform || null)}::text[],
        ${events.map((event) => event.playedAt)}::timestamptz[],
        ${events.map((event) => event.playedAtMs)}::bigint[],
        ${events.map((event) => event.trackId || null)}::text[],
        ${events.map((event) => event.albumId || null)}::text[],
        ${events.map((event) => event.artistId || null)}::text[],
        ${events.map((event) => event.playedMs)}::integer[],
        ${events.map((event) => JSON.stringify(event.raw))}::jsonb[]
      )
      on conflict (source_hash) do update set
        user_key = excluded.user_key,
        user_id = excluded.user_id,
        platform = excluded.platform,
        played_at = excluded.played_at,
        played_at_ms = excluded.played_at_ms,
        track_id = excluded.track_id,
        album_id = excluded.album_id,
        artist_id = excluded.artist_id,
        played_ms = excluded.played_ms,
        raw = excluded.raw,
        updated_at = now()
    `;
    return events.length;
  },

  async countEventsForMonth(userKey: string, afterMs: number, beforeMs: number) {
    const db = requireSql();
    await ensureSchema();
    const rows = await db`
      select count(*)::integer as count
      from stream_events
      where user_key = ${userKey}
        and played_at_ms >= ${afterMs}
        and played_at_ms < ${beforeMs}
    `;
    return Number(rows[0]?.count || 0);
  },

  async finishMonth(input: {
    userKey: string;
    year: number;
    month: number;
    expectedCount: number;
    storedCount: number;
    status: HistoryMonthStatus;
    error?: string | null;
  }) {
    const db = requireSql();
    await ensureSchema();
    const rows = await db`
      update stream_month_backups set
        expected_count = ${input.expectedCount},
        stored_count = ${input.storedCount},
        status = ${input.status},
        error = ${input.error || null},
        completed_at = case when ${input.status} in ('complete', 'partial', 'failed', 'needs_review') then now() else null end,
        updated_at = now()
      where user_key = ${input.userKey}
        and year = ${input.year}
        and month = ${input.month}
      returning *
    `;
    return rows[0] ? rowToMonthBackup(rows[0]) : null;
  },

  async listMonths(userKey?: string) {
    const db = requireSql();
    await ensureSchema();
    const rows = userKey
      ? await db`select * from stream_month_backups where user_key = ${userKey} order by year, month`
      : await db`select * from stream_month_backups order by user_key, year, month`;
    return rows.map(rowToMonthBackup);
  },

  async getLatestEventMs(userKey: string) {
    const db = requireSql();
    await ensureSchema();
    const rows = await db`
      select max(played_at_ms)::bigint as latest_ms
      from stream_events
      where user_key = ${userKey}
    `;
    return rows[0]?.latest_ms == null ? null : Number(rows[0].latest_ms);
  },

  async getUserState(userKey: string) {
    const db = requireSql();
    await ensureSchema();
    const rows = await db`
      select *
      from stream_history_user_states
      where user_key = ${userKey}
      limit 1
    `;
    return rows[0] ? rowToUserState(rows[0]) : null;
  },

  async upsertUserState(input: Omit<HistoryUserState, "createdAt" | "updatedAt">) {
    const db = requireSql();
    await ensureSchema();
    const rows = await db`
      insert into stream_history_user_states (
        user_key, user_id, pending_from_ms, last_event_at_ms,
        last_checked_at, last_count_changed_at, has_imported, sync_enabled
      ) values (
        ${input.userKey}, ${input.userId}, ${input.pendingFromMs}, ${input.lastEventAtMs},
        ${input.lastCheckedAt}, ${input.lastCountChangedAt}, ${input.hasImported}, ${input.syncEnabled}
      )
      on conflict (user_key) do update set
        user_id = excluded.user_id,
        pending_from_ms = excluded.pending_from_ms,
        last_event_at_ms = excluded.last_event_at_ms,
        last_checked_at = excluded.last_checked_at,
        last_count_changed_at = excluded.last_count_changed_at,
        has_imported = excluded.has_imported,
        sync_enabled = excluded.sync_enabled,
        updated_at = now()
      returning *
    `;
    return rowToUserState(rows[0]);
  },

  async listCompleteMonths(userKey: string, afterMs: number, beforeMs: number) {
    const db = requireSql();
    await ensureSchema();
    const rows = await db`
      select *
      from stream_month_backups
      where user_key = ${userKey}
        and status = 'complete'
        and after_ms >= ${afterMs}
        and before_ms <= ${beforeMs}
      order by year, month
    `;
    return rows.map(rowToMonthBackup);
  },

  async listEvents(input: {
    userKey: string;
    afterMs: number;
    beforeMs: number;
    limit?: number;
    offset?: number;
    order?: "asc" | "desc";
  }) {
    const db = requireSql();
    await ensureSchema();
    const limit = Math.max(1, Math.min(10000, Number(input.limit || 100)));
    const offset = Math.max(0, Number(input.offset || 0));
    const rows = input.order === "asc"
      ? await db`
          select *
          from stream_events
          where user_key = ${input.userKey}
            and played_at_ms >= ${input.afterMs}
            and played_at_ms < ${input.beforeMs}
          order by played_at asc, source_hash asc
          limit ${limit}
          offset ${offset}
        `
      : await db`
          select *
          from stream_events
          where user_key = ${input.userKey}
            and played_at_ms >= ${input.afterMs}
            and played_at_ms < ${input.beforeMs}
          order by played_at desc, source_hash desc
          limit ${limit}
          offset ${offset}
        `;
    return rows.map(rowToStreamEvent);
  },
};
