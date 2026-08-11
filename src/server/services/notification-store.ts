import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { alerts, pushSubs, watchlists } from "../db/schema";
import type { AlertDTO, WatchlistDTO } from "../../shared/types";
import { randomId } from "../lib/hash";
import { nowIso } from "../lib/time";

/** 观察列表、站内提醒与 Web Push 订阅的数据访问层 */
export class NotificationStore {
  constructor(private db: DB) {}

  async addAlert(input: {
    level: AlertDTO["level"];
    eventId?: string | null;
    claimId?: string | null;
    title: string;
    body: string;
    reason: string;
    dedupeKey?: string | null;
  }): Promise<AlertDTO | null> {
    if (input.dedupeKey) {
      const existing = (
        await this.db.select().from(alerts).where(eq(alerts.dedupeKey, input.dedupeKey)).limit(1)
      )[0];
      if (existing) return null;
    }
    const result = await this.db
      .insert(alerts)
      .values({
        createdAt: nowIso(),
        level: input.level,
        eventId: input.eventId ?? null,
        claimId: input.claimId ?? null,
        title: input.title,
        body: input.body,
        reason: input.reason,
        sentChannels: [],
        dedupeKey: input.dedupeKey ?? null,
      })
      .onConflictDoNothing()
      .returning();
    return result[0] ? mapAlert(result[0]) : null;
  }

  async listAlerts(limit = 100, unreadOnly = false): Promise<AlertDTO[]> {
    const rows = await this.db.select().from(alerts).orderBy(desc(alerts.createdAt)).limit(Math.min(Math.max(limit, 1), 300));
    return rows.filter((row) => !unreadOnly || !row.readAt).map(mapAlert);
  }

  async markRead(id: number): Promise<boolean> {
    const result = await this.db.update(alerts).set({ readAt: nowIso() }).where(eq(alerts.id, id)).returning({ id: alerts.id });
    return result.length > 0;
  }

  async setSentChannels(id: number, channels: string[]): Promise<void> {
    await this.db.update(alerts).set({ sentChannels: channels }).where(eq(alerts.id, id));
  }

  async listWatchlists(): Promise<WatchlistDTO[]> {
    const rows = await this.db.select().from(watchlists).orderBy(watchlists.name);
    return rows.map(mapWatchlist);
  }

  async saveWatchlist(input: Partial<WatchlistDTO> & { name: string }): Promise<WatchlistDTO> {
    const id = input.id || `watch_${randomId(12)}`;
    const row = {
      id,
      name: input.name.slice(0, 100),
      keywords: (input.keywords || []).map((x) => x.trim()).filter(Boolean).slice(0, 50),
      entities: (input.entities || []).map((x) => x.trim()).filter(Boolean).slice(0, 50),
      minImportance: Math.min(Math.max(input.minImportance ?? 40, 0), 100),
      channels: (input.channels || ["web"]).filter((x) => ["web", "telegram", "email", "push"].includes(x)),
      enabled: input.enabled ?? true,
      createdAt: input.createdAt || nowIso(),
    };
    await this.db
      .insert(watchlists)
      .values(row)
      .onConflictDoUpdate({
        target: watchlists.id,
        set: {
          name: row.name,
          keywords: row.keywords,
          entities: row.entities,
          minImportance: row.minImportance,
          channels: row.channels,
          enabled: row.enabled,
        },
      });
    return row;
  }

  async deleteWatchlist(id: string): Promise<boolean> {
    const rows = await this.db.delete(watchlists).where(eq(watchlists.id, id)).returning({ id: watchlists.id });
    return rows.length > 0;
  }

  async savePushSubscription(input: { endpoint: string; keys: { p256dh: string; auth: string }; ua?: string | null }): Promise<void> {
    await this.db
      .insert(pushSubs)
      .values({ endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, ua: input.ua ?? null, createdAt: nowIso() })
      .onConflictDoUpdate({ target: pushSubs.endpoint, set: { p256dh: input.keys.p256dh, auth: input.keys.auth, ua: input.ua ?? null } });
  }

  async pushSubscriptions(): Promise<Array<typeof pushSubs.$inferSelect>> {
    return this.db.select().from(pushSubs);
  }

  async removePushEndpoint(endpoint: string): Promise<void> {
    await this.db.delete(pushSubs).where(eq(pushSubs.endpoint, endpoint));
  }

  async alertCount(): Promise<number> {
    const row = (await this.db.select({ n: sql<number>`count(*)` }).from(alerts))[0];
    return Number(row?.n || 0);
  }
}

function mapAlert(row: typeof alerts.$inferSelect): AlertDTO {
  return {
    id: row.id,
    createdAt: row.createdAt,
    level: row.level as AlertDTO["level"],
    eventId: row.eventId,
    title: row.title,
    body: row.body,
    reason: row.reason,
    readAt: row.readAt,
  };
}

function mapWatchlist(row: typeof watchlists.$inferSelect): WatchlistDTO {
  return {
    id: row.id,
    name: row.name,
    keywords: row.keywords || [],
    entities: row.entities || [],
    minImportance: row.minImportance,
    channels: row.channels || [],
    enabled: row.enabled,
    createdAt: row.createdAt,
  };
}
