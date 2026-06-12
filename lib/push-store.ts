import { neon } from "@neondatabase/serverless";

export type StoredPushSubscription = {
  userId: string;
  endpoint: string;
  expirationTime: number | null;
  keys: {
    p256dh: string;
    auth: string;
  };
};

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const sql = databaseUrl ? neon(databaseUrl) : null;
const memorySubscriptions = new Map<string, StoredPushSubscription>();
const memoryDeliveries = new Set<string>();
let schemaReady: Promise<void> | null = null;

const ensureSchema = async () => {
  if (!sql) return;
  schemaReady ||= (async () => {
    await sql`
      create table if not exists push_subscriptions (
        endpoint text primary key,
        user_id text not null,
        subscription jsonb not null,
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      )
    `;
    await sql`create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id)`;
    await sql`
      create table if not exists push_deliveries (
        id text primary key,
        orbit_id text not null,
        event text not null,
        user_id text not null,
        created_at timestamptz not null default now()
      )
    `;
    await sql`create index if not exists push_deliveries_orbit_idx on push_deliveries (orbit_id, event)`;
  })();
  await schemaReady;
};

const rowToSubscription = (row: any): StoredPushSubscription => ({
  userId: row.user_id,
  endpoint: row.subscription?.endpoint || row.endpoint,
  expirationTime: row.subscription?.expirationTime ?? null,
  keys: {
    p256dh: row.subscription?.keys?.p256dh || "",
    auth: row.subscription?.keys?.auth || "",
  },
});

export const usingDurablePushStore = () => !!sql;

export const pushStore = {
  async upsert(subscription: StoredPushSubscription) {
    if (!sql) {
      memorySubscriptions.set(subscription.endpoint, subscription);
      return subscription;
    }

    await ensureSchema();
    await sql`
      insert into push_subscriptions (endpoint, user_id, subscription)
      values (${subscription.endpoint}, ${subscription.userId}, ${JSON.stringify(subscription)}::jsonb)
      on conflict (endpoint) do update set
        user_id = excluded.user_id,
        subscription = excluded.subscription,
        updated_at = now()
    `;
    return subscription;
  },

  async remove(endpoint: string) {
    if (!sql) {
      return memorySubscriptions.delete(endpoint);
    }

    await ensureSchema();
    const rows = await sql`delete from push_subscriptions where endpoint = ${endpoint} returning endpoint`;
    return rows.length > 0;
  },

  async listByUser(userId: string): Promise<StoredPushSubscription[]> {
    if (!sql) {
      return [...memorySubscriptions.values()].filter((subscription) => subscription.userId === userId);
    }

    await ensureSchema();
    const rows = await sql`select * from push_subscriptions where user_id = ${userId}`;
    return rows.map(rowToSubscription);
  },

  async claimDelivery(orbitId: string, event: string, userId: string) {
    const id = `${orbitId}:${event}:${userId}`;
    if (!sql) {
      if (memoryDeliveries.has(id)) return false;
      memoryDeliveries.add(id);
      return true;
    }

    await ensureSchema();
    const rows = await sql`
      insert into push_deliveries (id, orbit_id, event, user_id)
      values (${id}, ${orbitId}, ${event}, ${userId})
      on conflict (id) do nothing
      returning id
    `;
    return rows.length > 0;
  },
};
