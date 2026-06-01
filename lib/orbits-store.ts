import { neon } from "@neondatabase/serverless";

export type OrbitStatus = "sent" | "seen" | "opened" | "listened" | "dismissed";
export type OrbitBox = "received" | "sent" | "all";

export type Orbit = {
  id: string;
  fromUserId: string;
  toUserId: string;
  track: any;
  message?: string;
  status: OrbitStatus;
  createdAt: string;
  seenAt?: string;
  openedAt?: string;
  firstListenedAt?: string;
  listenCountSinceSent: number;
  lastCheckedAt?: string;
  targetPlatform?: string;
  listenUrl?: string;
  senderDeletedAt?: string;
  recipientDeletedAt?: string;
};

const memoryOrbits = new Map<string, Orbit>();
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const sql = databaseUrl ? neon(databaseUrl) : null;
let schemaReady: Promise<void> | null = null;

const rowToOrbit = (row: any): Orbit => ({
  id: row.id,
  fromUserId: row.from_user_id,
  toUserId: row.to_user_id,
  track: row.track,
  message: row.message || undefined,
  status: row.status,
  createdAt: row.created_at,
  seenAt: row.seen_at || undefined,
  openedAt: row.opened_at || undefined,
  firstListenedAt: row.first_listened_at || undefined,
  listenCountSinceSent: Number(row.listen_count_since_sent || 0),
  lastCheckedAt: row.last_checked_at || undefined,
  targetPlatform: row.target_platform || undefined,
  listenUrl: row.listen_url || undefined,
  senderDeletedAt: row.sender_deleted_at || undefined,
  recipientDeletedAt: row.recipient_deleted_at || undefined,
});

const ensureSchema = async () => {
  if (!sql) return;
  schemaReady ||= (async () => {
    await sql`
      create table if not exists orbits (
        id text primary key,
        from_user_id text not null,
        to_user_id text not null,
        track_id text,
        track jsonb not null,
        message text,
        status text not null default 'sent',
        target_platform text,
        listen_url text,
        listen_count_since_sent integer not null default 0,
        created_at timestamptz not null default now(),
        seen_at timestamptz,
        opened_at timestamptz,
        first_listened_at timestamptz,
        last_checked_at timestamptz,
        sender_deleted_at timestamptz,
        recipient_deleted_at timestamptz
      )
    `;
    await sql`create index if not exists orbits_to_user_idx on orbits (to_user_id, created_at desc)`;
    await sql`create index if not exists orbits_from_user_idx on orbits (from_user_id, created_at desc)`;
    await sql`create index if not exists orbits_track_idx on orbits (track_id)`;
  })();
  await schemaReady;
};

export const usingDurableOrbitStore = () => !!sql;

export const orbitStore = {
  async list(userId: string, box: OrbitBox): Promise<Orbit[]> {
    if (!sql) {
      return [...memoryOrbits.values()]
        .filter((orbit) => {
          if (box === "sent") return orbit.fromUserId === userId && !orbit.senderDeletedAt;
          if (box === "all") return (orbit.fromUserId === userId && !orbit.senderDeletedAt) || (orbit.toUserId === userId && !orbit.recipientDeletedAt);
          return orbit.toUserId === userId && !orbit.recipientDeletedAt;
        })
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    }

    await ensureSchema();
    const rows = box === "sent"
      ? await sql`select * from orbits where from_user_id = ${userId} and sender_deleted_at is null order by created_at desc`
      : box === "all"
        ? await sql`select * from orbits where (from_user_id = ${userId} and sender_deleted_at is null) or (to_user_id = ${userId} and recipient_deleted_at is null) order by created_at desc`
        : await sql`select * from orbits where to_user_id = ${userId} and recipient_deleted_at is null order by created_at desc`;
    return rows.map(rowToOrbit);
  },

  async get(id: string): Promise<Orbit | null> {
    if (!sql) return memoryOrbits.get(id) || null;
    await ensureSchema();
    const rows = await sql`select * from orbits where id = ${id} limit 1`;
    return rows[0] ? rowToOrbit(rows[0]) : null;
  },

  async create(orbit: Orbit): Promise<Orbit> {
    if (!sql) {
      memoryOrbits.set(orbit.id, orbit);
      return orbit;
    }
    await ensureSchema();
    const rows = await sql`
      insert into orbits (
        id, from_user_id, to_user_id, track_id, track, message, status,
        target_platform, listen_url, listen_count_since_sent, created_at
      ) values (
        ${orbit.id}, ${orbit.fromUserId}, ${orbit.toUserId}, ${orbit.track?.id || null},
        ${JSON.stringify(orbit.track)}::jsonb, ${orbit.message || null}, ${orbit.status},
        ${orbit.targetPlatform || null}, ${orbit.listenUrl || null}, ${orbit.listenCountSinceSent},
        ${orbit.createdAt}
      )
      returning *
    `;
    return rowToOrbit(rows[0]);
  },

  async save(orbit: Orbit): Promise<Orbit> {
    if (!sql) {
      memoryOrbits.set(orbit.id, orbit);
      return orbit;
    }
    await ensureSchema();
    const rows = await sql`
      update orbits set
        status = ${orbit.status},
        seen_at = ${orbit.seenAt || null},
        opened_at = ${orbit.openedAt || null},
        first_listened_at = ${orbit.firstListenedAt || null},
        listen_count_since_sent = ${orbit.listenCountSinceSent},
        last_checked_at = ${orbit.lastCheckedAt || null},
        sender_deleted_at = ${orbit.senderDeletedAt || null},
        recipient_deleted_at = ${orbit.recipientDeletedAt || null}
      where id = ${orbit.id}
      returning *
    `;
    return rows[0] ? rowToOrbit(rows[0]) : orbit;
  },

  async summary(userId: string) {
    const [sent, received] = await Promise.all([
      this.list(userId, "sent"),
      this.list(userId, "received"),
    ]);
    return {
      received: received.length,
      sent: sent.length,
      sentListened: sent.filter((orbit) => orbit.listenCountSinceSent > 0 || orbit.status === "listened").length,
      unread: received.filter((orbit) => !orbit.seenAt).length,
    };
  },
};
