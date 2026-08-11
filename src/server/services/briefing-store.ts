import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { briefings } from "../db/schema";
import type { BriefingDTO, BriefingType } from "../../shared/types";
import { shortId } from "../lib/hash";

/** 简报版本与导出数据访问层 */
export class BriefingStore {
  constructor(private db: DB) {}

  async save(briefing: Omit<BriefingDTO, "id">): Promise<BriefingDTO> {
    const id = `brf_${shortId(`${briefing.type}:${briefing.periodKey}`, 20)}`;
    const previous = await this.latest(briefing.type);
    await this.db
      .insert(briefings)
      .values({
        id,
        type: briefing.type,
        periodKey: briefing.periodKey,
        createdAt: briefing.createdAt,
        cutoffAt: briefing.cutoffAt,
        tz: briefing.tz,
        content: JSON.stringify({
          title: briefing.title,
          oneMinuteRead: briefing.oneMinuteRead,
          sections: briefing.sections,
        }),
        contentMd: briefing.contentMd ?? null,
        prevId: previous?.id && previous.id !== id ? previous.id : null,
        delta: briefing.delta ? JSON.stringify(briefing.delta) : null,
        engine: briefing.engine,
      })
      .onConflictDoUpdate({
        target: [briefings.type, briefings.periodKey],
        set: {
          createdAt: briefing.createdAt,
          cutoffAt: briefing.cutoffAt,
          tz: briefing.tz,
          content: JSON.stringify({
            title: briefing.title,
            oneMinuteRead: briefing.oneMinuteRead,
            sections: briefing.sections,
          }),
          contentMd: briefing.contentMd ?? null,
          delta: briefing.delta ? JSON.stringify(briefing.delta) : null,
          engine: briefing.engine,
        },
      });
    return { id, ...briefing };
  }

  async get(id: string): Promise<BriefingDTO | null> {
    const row = (await this.db.select().from(briefings).where(eq(briefings.id, id)).limit(1))[0];
    return row ? mapBriefing(row) : null;
  }

  async latest(type?: BriefingType): Promise<BriefingDTO | null> {
    const query = type
      ? this.db.select().from(briefings).where(eq(briefings.type, type)).orderBy(desc(briefings.createdAt)).limit(1)
      : this.db.select().from(briefings).orderBy(desc(briefings.createdAt)).limit(1);
    const row = (await query)[0];
    return row ? mapBriefing(row) : null;
  }

  async list(type?: BriefingType, limit = 30): Promise<BriefingDTO[]> {
    const cap = Math.min(Math.max(limit, 1), 100);
    const query = type
      ? this.db.select().from(briefings).where(eq(briefings.type, type)).orderBy(desc(briefings.createdAt)).limit(cap)
      : this.db.select().from(briefings).orderBy(desc(briefings.createdAt)).limit(cap);
    return (await query).map(mapBriefing);
  }

  async count(): Promise<number> {
    const row = (await this.db.select({ n: sql<number>`count(*)` }).from(briefings))[0];
    return Number(row?.n || 0);
  }
}

function mapBriefing(row: typeof briefings.$inferSelect): BriefingDTO {
  const content = parseJson<{ title: string; oneMinuteRead: string[]; sections: BriefingDTO["sections"] }>(row.content, {
    title: "新闻简报",
    oneMinuteRead: [],
    sections: [],
  });
  return {
    id: row.id,
    type: row.type as BriefingType,
    periodKey: row.periodKey,
    createdAt: row.createdAt,
    cutoffAt: row.cutoffAt,
    tz: row.tz,
    title: content.title,
    oneMinuteRead: content.oneMinuteRead || [],
    sections: content.sections || [],
    delta: parseJson<BriefingDTO["delta"]>(row.delta, null),
    contentMd: row.contentMd ?? undefined,
    engine: row.engine as "ai" | "extractive",
  };
}

function parseJson<T>(raw: unknown, fallback: T): T {
  if (!raw) return fallback;
  if (typeof raw !== "string") return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
