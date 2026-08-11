import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as schema from "./schema";

export type DB = BetterSQLite3Database<typeof schema>;

export interface OpenDbResult {
  db: DB;
  raw: Database.Database;
}

/** 打开数据库：WAL 模式 + 自动迁移 + FTS5 虚拟表（幂等） */
export function openDb(dataDir: string, migrationsFolder: string, fileName = "news.db"): OpenDbResult {
  if (dataDir !== ":memory:" && !existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const path = dataDir === ":memory:" ? ":memory:" : join(dataDir, fileName);
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("synchronous = NORMAL");
  raw.pragma("wal_autocheckpoint = 100");
  raw.pragma("foreign_keys = ON");
  raw.pragma("busy_timeout = 5000");

  const db = drizzle(raw, { schema });
  migrate(db, { migrationsFolder });
  ensureFts(raw);
  if (path !== ":memory:") raw.pragma("wal_checkpoint(PASSIVE)");
  return { db, raw };
}

/** FTS5 全文索引（中文按二元组预分词，写入时由应用层处理） */
function ensureFts(raw: Database.Database): void {
  raw.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS articles_fts USING fts5(uid UNINDEXED, search_text);
    CREATE VIRTUAL TABLE IF NOT EXISTS claims_fts USING fts5(cid UNINDEXED, search_text);
  `);
}

export { schema };
