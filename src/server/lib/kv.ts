import { eq, lt, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { kvStore } from "../db/schema";

/** SQLite 支撑的简单 KV：缓存、调度标记、robots 缓存、AI 预算计数 */
export class KV {
  constructor(private db: DB) {}

  async get(key: string): Promise<string | null> {
    const row = (await this.db.select().from(kvStore).where(eq(kvStore.k, key)).limit(1))[0];
    if (!row) return null;
    if (row.expiresAt && row.expiresAt < new Date().toISOString()) {
      await this.delete(key);
      return null;
    }
    return row.v;
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    const expiresAt = ttlSec ? new Date(Date.now() + ttlSec * 1000).toISOString() : null;
    await this.db
      .insert(kvStore)
      .values({ k: key, v: value, expiresAt })
      .onConflictDoUpdate({ target: kvStore.k, set: { v: value, expiresAt } });
  }

  async delete(key: string): Promise<void> {
    await this.db.delete(kvStore).where(eq(kvStore.k, key));
  }

  async getJson<T>(key: string): Promise<T | null> {
    const v = await this.get(key);
    if (v === null) return null;
    try {
      return JSON.parse(v) as T;
    } catch {
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSec?: number): Promise<void> {
    await this.set(key, JSON.stringify(value), ttlSec);
  }

  /** 原子自增（每日预算计数等） */
  async incr(key: string, ttlSec?: number): Promise<number> {
    const cur = Number((await this.get(key)) || "0");
    const next = cur + 1;
    await this.set(key, String(next), ttlSec);
    return next;
  }

  /** 清理过期键 */
  async cleanup(): Promise<void> {
    await this.db.delete(kvStore).where(lt(kvStore.expiresAt, sql`${new Date().toISOString()}`));
  }
}
