import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { fetchLog, sourceFamilies, sources } from "../db/schema";
import type { SourceHealthSummary, SourceDTO } from "../../shared/types";
import { nowIso } from "../lib/time";

export type SourceRow = typeof sources.$inferSelect;

export interface SourceWithFamilyKind {
  source: SourceRow;
  familyKind: string | null;
}

export interface FetchOutcome {
  ok: boolean;
  httpStatus: number | null;
  found: number;
  added: number;
  error: string | null;
  ms: number;
}

/** 来源注册表的数据访问层：调度、健康状态和采集日志统一由这里维护 */
export class SourceStore {
  constructor(private db: DB) {}

  async get(id: string): Promise<SourceRow | null> {
    return (await this.db.select().from(sources).where(eq(sources.id, id)).limit(1))[0] ?? null;
  }

  async familyKind(familyId: string | null): Promise<string | null> {
    if (!familyId) return null;
    const row = (await this.db.select().from(sourceFamilies).where(eq(sourceFamilies.id, familyId)).limit(1))[0];
    return row?.kind ?? null;
  }

  /** 批量读取待处理文章的来源与家族类型，避免逐文章查询。 */
  async getManyWithFamilyKind(ids: readonly string[]): Promise<SourceWithFamilyKind[]> {
    const uniqueIds = [...new Set(ids)];
    if (uniqueIds.length === 0) return [];
    const output: SourceWithFamilyKind[] = [];
    const chunkSize = 400;
    for (let offset = 0; offset < uniqueIds.length; offset += chunkSize) {
      const rows = await this.db
        .select({ source: sources, familyKind: sourceFamilies.kind })
        .from(sources)
        .leftJoin(sourceFamilies, eq(sources.familyId, sourceFamilies.id))
        .where(inArray(sources.id, uniqueIds.slice(offset, offset + chunkSize)));
      output.push(...rows);
    }
    return output;
  }

  async list(includeDisabled = true): Promise<SourceRow[]> {
    const rows = await this.db.select().from(sources).orderBy(sources.category, sources.name);
    return includeDisabled ? rows : rows.filter((row) => row.enabled);
  }

  /**
   * 选出到期来源。失败来源采用指数退避：interval × 2^fails，上限 6 小时。
   * breaking 事件的主动搜索由事件调度器单独处理，不会绕过来源级退避。
   */
  async due(limit = 50, at = new Date()): Promise<SourceRow[]> {
    const rows = await this.list(false);
    const now = at.getTime();
    return rows
      .filter((row) => {
        if (row.backoffUntil && Date.parse(row.backoffUntil) > now) return false;
        if (!row.lastFetchAt) return true;
        const failMultiplier = Math.pow(2, Math.min(row.consecFails, 6));
        const waitMs = Math.min(row.intervalMin * failMultiplier, 360) * 60_000;
        return Date.parse(row.lastFetchAt) + waitMs <= now;
      })
      .sort((a, b) => {
        const atA = a.lastFetchAt ? Date.parse(a.lastFetchAt) : 0;
        const atB = b.lastFetchAt ? Date.parse(b.lastFetchAt) : 0;
        return atA - atB;
      })
      .slice(0, limit);
  }

  async recordFetch(source: SourceRow, startedAt: string, outcome: FetchOutcome): Promise<void> {
    const at = nowIso();
    const fails = outcome.ok ? 0 : source.consecFails + 1;
    const backoffMin = outcome.ok ? 0 : Math.min(source.intervalMin * Math.pow(2, Math.min(fails, 6)), 360);
    const backoffUntil = backoffMin ? new Date(Date.now() + backoffMin * 60_000).toISOString() : null;
    const health = outcome.ok ? "ok" : fails >= 5 ? "failing" : "degraded";

    this.db.transaction((tx) => {
      tx
        .update(sources)
        .set({
          lastFetchAt: at,
          lastSuccessAt: outcome.ok ? at : source.lastSuccessAt,
          consecFails: fails,
          backoffUntil,
          health,
          updatedAt: at,
        })
        .where(eq(sources.id, source.id))
        .run();

      tx.insert(fetchLog).values({
        sourceId: source.id,
        startedAt,
        ok: outcome.ok,
        httpStatus: outcome.httpStatus,
        found: outcome.found,
        added: outcome.added,
        error: outcome.error?.slice(0, 1000) ?? null,
        ms: outcome.ms,
      }).run();
    });
  }

  /** 管理员手动重试会清除退避，但不伪造“成功”状态 */
  async clearBackoff(id: string): Promise<boolean> {
    const row = await this.get(id);
    if (!row) return false;
    await this.db
      .update(sources)
      .set({ backoffUntil: null, lastFetchAt: null, health: row.enabled ? "unknown" : "disabled", updatedAt: nowIso() })
      .where(eq(sources.id, id));
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    const row = await this.get(id);
    if (!row) return false;
    await this.db
      .update(sources)
      .set({ enabled, health: enabled ? "unknown" : "disabled", updatedAt: nowIso() })
      .where(eq(sources.id, id));
    return true;
  }

  async recentFetchLogs(limit = 100): Promise<Array<typeof fetchLog.$inferSelect & { sourceName: string | null }>> {
    const rows = await this.db
      .select({
        id: fetchLog.id,
        sourceId: fetchLog.sourceId,
        sourceName: sources.name,
        startedAt: fetchLog.startedAt,
        ok: fetchLog.ok,
        httpStatus: fetchLog.httpStatus,
        found: fetchLog.found,
        added: fetchLog.added,
        error: fetchLog.error,
        ms: fetchLog.ms,
      })
      .from(fetchLog)
      .leftJoin(sources, eq(fetchLog.sourceId, sources.id))
      .orderBy(desc(fetchLog.id))
      .limit(Math.min(Math.max(limit, 1), 500));
    return rows;
  }

  async healthSummary(): Promise<SourceHealthSummary> {
    const rows = await this.list(true);
    const summary: SourceHealthSummary = {
      total: rows.length,
      ok: 0,
      degraded: 0,
      failing: 0,
      disabled: 0,
      unknown: 0,
      byCategory: {},
    };
    for (const row of rows) {
      const status = row.enabled ? row.health : "disabled";
      if (status in summary && status !== "total" && status !== "byCategory") {
        (summary[status as keyof Omit<SourceHealthSummary, "total" | "byCategory">] as number)++;
      } else {
        summary.unknown++;
      }
      summary.byCategory[row.category] = (summary.byCategory[row.category] || 0) + 1;
    }
    return summary;
  }

  toDTO(row: SourceRow): SourceDTO {
    return {
      id: row.id,
      name: row.name,
      homepage: row.homepage,
      feedUrl: row.feedUrl,
      adapter: row.adapter as SourceDTO["adapter"],
      config: row.config,
      country: row.country,
      lang: row.lang,
      category: row.category as SourceDTO["category"],
      owner: row.owner,
      ownershipNote: row.ownershipNote,
      isParty: row.isParty,
      partyOf: row.partyOf,
      isPrimary: row.isPrimary,
      paywalled: row.paywalled,
      intervalMin: row.intervalMin,
      verifStatus: row.verifStatus as SourceDTO["verifStatus"],
      verifBasis: row.verifBasis,
      lastReviewedAt: row.lastReviewedAt,
      familyId: row.familyId,
      enabled: row.enabled,
      lastFetchAt: row.lastFetchAt,
      lastSuccessAt: row.lastSuccessAt,
      consecFails: row.consecFails,
      health: (row.enabled ? row.health : "disabled") as SourceDTO["health"],
      addedBy: row.addedBy,
      notes: row.notes,
    };
  }

  /** 按注册表维度快速计数（健康接口使用） */
  async count(): Promise<number> {
    const row = (await this.db.select({ n: sql<number>`count(*)` }).from(sources))[0];
    return Number(row?.n || 0);
  }
}
