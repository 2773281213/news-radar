import type Database from "better-sqlite3";
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import {
  articles,
  claimEvidence,
  claims,
  eventArticles,
  events,
  eventVersions,
  sourceFamilies,
  sources,
} from "../db/schema";
import type {
  Citation,
  ClaimDTO,
  ClaimRationale,
  ClaimStatus,
  CoverageDTO,
  DisputeGroup,
  EventDetailDTO,
  EventListItem,
  EventSummaryDTO,
  EvidenceDTO,
  FeaturedReportDTO,
  SourceCategory,
  TimelineItem,
} from "../../shared/types";
import { CATEGORY_LABELS, PARTY_LABELS } from "../../shared/constants";
import { shortId } from "../lib/hash";
import { nowIso } from "../lib/time";
import { ftsTokenize } from "../lib/textsim";
import { stripHtml, textExcerpt } from "../lib/sanitize";
import type { ArticleWithSource } from "./article-store";
import type { ClusterEventInput } from "../pipeline/cluster";
import type { VerificationEvidence } from "../pipeline/verify";

export type EventRow = typeof events.$inferSelect;
export type ClaimRow = typeof claims.$inferSelect;

export interface EventSnapshotFence {
  version: number;
  lastUpdateAt: string;
}

export interface EventDetailBundle {
  event: EventRow;
  detail: EventDetailDTO;
  articles: ArticleWithSource[];
}

export interface BriefingEventDetail {
  summary: EventSummaryDTO;
  citations: Citation[];
  delta: EventDetailDTO["delta"];
}

export interface NewClaimInput {
  eventId: string;
  text: string;
  textNorm: string;
  type: string;
  claimedBy?: string | null;
  claimedByKind?: string | null;
  party?: string | null;
  subjectNumber?: number | null;
  numberUnit?: string | null;
  asOf?: string | null;
  occurredAt?: string | null;
  publishedAt?: string | null;
  firstSeenAt?: string;
  status?: ClaimStatus;
}

export interface EventListQuery {
  tab?: string;
  topic?: string;
  country?: string;
  minImportance?: number;
  since?: string;
  ids?: string[];
  reviewedOnly?: boolean;
  publishableOnly?: boolean;
  limit?: number;
  offset?: number;
}

/** 事件、Claim Graph 与版本快照的数据访问层 */
export class EventStore {
  constructor(
    private db: DB,
    private raw: Database.Database
  ) {}

  async get(id: string): Promise<EventRow | null> {
    return (await this.db.select().from(events).where(eq(events.id, id)).limit(1))[0] ?? null;
  }

  async recentCandidates(sinceIso: string, limit = 250): Promise<ClusterEventInput[]> {
    return this.db
      .select({
        id: events.id,
        title: events.title,
        oneLiner: events.oneLiner,
        status: events.status,
        trackMode: events.trackMode,
        topics: events.topics,
        countries: events.countries,
        entities: events.entities,
        firstAt: events.firstAt,
        lastUpdateAt: events.lastUpdateAt,
      })
      .from(events)
      .where(gte(events.lastUpdateAt, sinceIso))
      .orderBy(desc(events.lastUpdateAt))
      .limit(Math.min(Math.max(limit, 1), 1000));
  }

  /** 主动搜索只需要事件 ID，避免为调度器计算列表页文章与 Claim 统计。 */
  recentBreakingEventIds(sinceIso: string, limit = 2): string[] {
    const rows = this.raw.prepare(`
      SELECT id
      FROM events
      WHERE last_update_at >= ?
        AND (track_mode = 'breaking' OR importance >= 70)
      ORDER BY importance DESC, heat DESC, last_update_at DESC
      LIMIT ?
    `).all(sinceIso, Math.min(Math.max(limit, 1), 20)) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  async create(input: {
    title: string;
    firstAt: string;
    countries: string[];
    topics: string[];
    entities: { slug: string; count: number }[];
    importance?: number;
    trackMode?: string;
  }): Promise<EventRow> {
    const at = nowIso();
    const id = `evt_${shortId(`${input.title}\n${input.firstAt}`, 20)}`;
    await this.db
      .insert(events)
      .values({
        id,
        title: input.title,
        status: "developing",
        trackMode: input.trackMode || "normal",
        importance: input.importance ?? 30,
        heat: 1,
        prevHeat: 0,
        topics: input.topics,
        countries: input.countries,
        entities: input.entities,
        firstAt: input.firstAt,
        lastUpdateAt: at,
        version: 1,
        dirty: true,
      })
      .onConflictDoNothing();
    const row = await this.get(id);
    if (!row) throw new Error("事件创建失败");
    return row;
  }

  /** 插入由聚类器生成的完整事件对象 */
  async insertEvent(row: typeof events.$inferInsert): Promise<EventRow> {
    await this.db.insert(events).values(row).onConflictDoNothing();
    const saved = await this.get(row.id);
    if (!saved) throw new Error("事件创建失败");
    return saved;
  }

  /** 应用聚类器给出的增量字段 */
  async applyEventUpdate(eventId: string, patch: Partial<typeof events.$inferInsert>): Promise<void> {
    await this.db.update(events).set(patch).where(eq(events.id, eventId));
  }

  async attachArticle(eventId: string, articleId: string, role: string, familyKey: string | null): Promise<void> {
    const at = nowIso();
    await this.db
      .insert(eventArticles)
      .values({ eventId, articleId, addedAt: at, role, familyKey })
      .onConflictDoNothing();
    await this.db.update(articles).set({ eventId, status: "analyzed" }).where(eq(articles.id, articleId));
    await this.db
      .update(events)
      .set({ lastUpdateAt: at, dirty: true })
      .where(eq(events.id, eventId));
  }

  async touch(
    eventId: string,
    patch: Partial<Pick<EventRow, "title" | "oneLiner" | "status" | "trackMode" | "importance" | "heat" | "prevHeat" | "topics" | "countries" | "entities" | "lastVerifiedAt">>
  ): Promise<string> {
    const at = nowIso();
    await this.db
      .update(events)
      .set({ ...patch, lastUpdateAt: at, dirty: true })
      .where(eq(events.id, eventId));
    return at;
  }

  async eventArticles(eventId: string): Promise<ArticleWithSource[]> {
    const rows = await this.db
      .select({
        article: articles,
        sourceName: sources.name,
        sourceCategory: sources.category,
        sourceFamilyId: sources.familyId,
        sourceIsParty: sources.isParty,
        sourcePartyOf: sources.partyOf,
        sourceIsPrimary: sources.isPrimary,
        sourceVerifStatus: sources.verifStatus,
        sourceHealth: sources.health,
      })
      .from(eventArticles)
      .innerJoin(articles, eq(eventArticles.articleId, articles.id))
      .innerJoin(sources, eq(articles.sourceId, sources.id))
      .where(eq(eventArticles.eventId, eventId))
      .orderBy(articles.publishedAt, articles.firstSeenAt);
    return rows.map((row) => ({
      ...row.article,
      sourceName: row.sourceName,
      sourceCategory: row.sourceCategory,
      sourceFamilyId: row.sourceFamilyId,
      sourceIsParty: row.sourceIsParty,
      sourcePartyOf: row.sourcePartyOf,
      sourceIsPrimary: row.sourceIsPrimary,
      sourceVerifStatus: row.sourceVerifStatus,
      sourceHealth: row.sourceHealth,
    }));
  }

  async claims(eventId: string): Promise<ClaimRow[]> {
    return this.db.select().from(claims).where(eq(claims.eventId, eventId)).orderBy(claims.firstSeenAt);
  }

  async addClaim(input: NewClaimInput): Promise<ClaimRow> {
    const id = `clm_${shortId(`${input.eventId}\n${input.textNorm}`, 20)}`;
    await this.db
      .insert(claims)
      .values({
        id,
        eventId: input.eventId,
        text: input.text,
        textNorm: input.textNorm,
        type: input.type,
        claimedBy: input.claimedBy ?? null,
        claimedByKind: input.claimedByKind ?? null,
        party: input.party ?? null,
        subjectNumber: input.subjectNumber ?? null,
        numberUnit: input.numberUnit ?? null,
        asOf: input.asOf ?? null,
        occurredAt: input.occurredAt ?? null,
        publishedAt: input.publishedAt ?? null,
        firstSeenAt: input.firstSeenAt || nowIso(),
        status: input.status || "reported",
      })
      .onConflictDoNothing();
    const row = (await this.db.select().from(claims).where(eq(claims.id, id)).limit(1))[0];
    if (!row) throw new Error("Claim 创建失败");
    return row;
  }

  async addEvidence(input: {
    claimId: string;
    articleId: string;
    stance: string;
    familyKey: string | null;
    hasPrimary: boolean;
    note?: string | null;
  }): Promise<void> {
    await this.db
      .insert(claimEvidence)
      .values({ ...input, note: input.note ?? null, createdAt: nowIso() })
      .onConflictDoUpdate({
        target: [claimEvidence.claimId, claimEvidence.articleId],
        set: {
          stance: input.stance,
          familyKey: input.familyKey,
          hasPrimary: input.hasPrimary,
          note: input.note ?? null,
        },
      });
  }

  /** 抽取器生成的 Claim 幂等写入；同一规范主张再次出现时保留最新时间字段 */
  async upsertClaim(row: typeof claims.$inferInsert): Promise<ClaimRow> {
    await this.db
      .insert(claims)
      .values(row)
      .onConflictDoUpdate({
        target: claims.id,
        set: {
          text: row.text,
          textNorm: row.textNorm,
          claimedBy: row.claimedBy ?? null,
          claimedByKind: row.claimedByKind ?? null,
          party: row.party ?? null,
          subjectNumber: row.subjectNumber ?? null,
          numberUnit: row.numberUnit ?? null,
          asOf: row.asOf ?? null,
          occurredAt: row.occurredAt ?? null,
          publishedAt: row.publishedAt ?? null,
        },
      });
    const saved = (await this.db.select().from(claims).where(eq(claims.id, row.id)).limit(1))[0];
    if (!saved) throw new Error("Claim 写入失败");
    const tokenized = ftsTokenize(`${saved.text}\n${saved.claimedBy || ""}\n${saved.party || ""}`);
    const tx = this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM claims_fts WHERE cid = ?").run(saved.id);
      this.raw.prepare("INSERT INTO claims_fts(cid, search_text) VALUES (?, ?)").run(saved.id, tokenized);
    });
    tx();
    return saved;
  }

  async upsertEvidence(row: typeof claimEvidence.$inferInsert): Promise<void> {
    await this.db
      .insert(claimEvidence)
      .values(row)
      .onConflictDoUpdate({
        target: [claimEvidence.claimId, claimEvidence.articleId],
        set: {
          stance: row.stance,
          familyKey: row.familyKey ?? null,
          hasPrimary: row.hasPrimary ?? false,
          note: row.note ?? null,
        },
      });
  }

  /** 生成核验器需要的证据视图，并保留来源家族与转载关系 */
  async verificationEvidence(claimId: string): Promise<VerificationEvidence[]> {
    const rows = await this.db
      .select({
        evidence: claimEvidence,
        article: articles,
        source: sources,
        familyKind: sourceFamilies.kind,
      })
      .from(claimEvidence)
      .innerJoin(articles, eq(claimEvidence.articleId, articles.id))
      .innerJoin(sources, eq(articles.sourceId, sources.id))
      .leftJoin(sourceFamilies, eq(sources.familyId, sourceFamilies.id))
      .where(eq(claimEvidence.claimId, claimId));
    return rows.map((row) => ({
      articleId: row.article.id,
      stance: row.evidence.stance as VerificationEvidence["stance"],
      familyKey: row.evidence.familyKey,
      hasPrimary: row.evidence.hasPrimary,
      isParty: row.source.isParty,
      party: row.source.partyOf,
      sourceId: row.source.id,
      sourceFamilyId: row.source.familyId,
      sourceFamilyKind: row.familyKind,
      wireFamily: row.article.wireFamily,
      reprintOf: row.article.reprintOf,
      url: row.article.url,
    }));
  }

  async setClaimStatus(
    claimId: string,
    status: ClaimStatus,
    rationale: ClaimRationale,
    supersededBy?: string | null
  ): Promise<void> {
    await this.db
      .update(claims)
      .set({
        status,
        rationale,
        lastCheckedAt: nowIso(),
        ...(supersededBy !== undefined ? { supersededBy } : {}),
      })
      .where(eq(claims.id, claimId));
  }

  async dirty(limit = 100): Promise<EventRow[]> {
    return this.db
      .select()
      .from(events)
      .where(eq(events.dirty, true))
      .orderBy(desc(events.importance), desc(events.lastUpdateAt))
      .limit(Math.min(Math.max(limit, 1), 500));
  }

  async clearDirty(eventId: string): Promise<void> {
    await this.db.update(events).set({ dirty: false }).where(eq(events.id, eventId));
  }

  async updateMetrics(
    eventId: string,
    patch: Pick<EventRow, "importance" | "heat" | "trackMode">
  ): Promise<void> {
    const current = await this.get(eventId);
    if (!current) return;
    await this.db
      .update(events)
      .set({ importance: patch.importance, prevHeat: current.heat, heat: patch.heat, trackMode: patch.trackMode })
      .where(eq(events.id, eventId));
  }

  /** 保存摘要前创建旧版本快照，并计算可读增删改 */
  async saveSummary(
    eventId: string,
    summary: EventSummaryDTO,
    engine: "ai" | "extractive",
    expected?: EventSnapshotFence
  ): Promise<boolean> {
    const at = nowIso();
    const tx = this.raw.transaction((): boolean => {
      const row = this.raw.prepare(`
        SELECT version, summary, summary_engine, last_update_at FROM events WHERE id = ?
      `).get(eventId) as { version: number; summary: string | null; summary_engine: string; last_update_at: string } | undefined;
      if (!row) throw new Error("事件不存在");
      if (expected && (row.version !== expected.version || row.last_update_at !== expected.lastUpdateAt)) return false;

      const oldSummary = normalizeEventSummary(row.summary);
      if (oldSummary && JSON.stringify(oldSummary) === JSON.stringify(summary) && row.summary_engine === engine) {
        const result = this.raw.prepare(`
          UPDATE events SET one_liner = ?, last_summary_at = ?, last_verified_at = ?, dirty = 0
          WHERE id = ? AND version = ? AND last_update_at = ?
        `).run(summary.oneLiner, at, at, eventId, row.version, row.last_update_at);
        return result.changes === 1;
      }

      const changes = diffSummary(oldSummary, summary);
      this.raw.prepare(`
        INSERT INTO event_versions(event_id, version, created_at, summary, changes)
        VALUES (?, ?, ?, ?, ?)
      `).run(eventId, row.version, at, row.summary, JSON.stringify(changes));
      const result = this.raw.prepare(`
        UPDATE events SET one_liner = ?, summary = ?, summary_engine = ?, version = ?,
          last_summary_at = ?, last_verified_at = ?, dirty = 0
        WHERE id = ? AND version = ? AND last_update_at = ?
      `).run(
        summary.oneLiner,
        JSON.stringify(summary),
        engine,
        row.version + 1,
        at,
        at,
        eventId,
        row.version,
        row.last_update_at
      );
      if (result.changes !== 1) throw new Error("事件在摘要写入前已更新");
      return true;
    });
    return tx();
  }

  list(query: EventListQuery = {}): EventListItem[] {
    const limit = Math.min(Math.max(query.limit || 50, 1), 200);
    const offset = Math.max(query.offset || 0, 0);
    const where: string[] = ["1=1"];
    const args: unknown[] = [];
    if (query.since) {
      where.push("e.last_update_at >= ?");
      args.push(query.since);
    }
    if (query.minImportance !== undefined) {
      where.push("e.importance >= ?");
      args.push(query.minImportance);
    }
    if (query.topic) {
      where.push("e.topics LIKE ?");
      args.push(`%\"${escapeLike(query.topic)}\"%`);
    }
    if (query.country) {
      where.push("e.countries LIKE ?");
      args.push(`%\"${escapeLike(query.country)}\"%`);
    }
    if (query.ids) {
      const ids = [...new Set(query.ids)].slice(0, 500);
      if (ids.length === 0) return [];
      where.push(`e.id IN (${ids.map(() => "?").join(",")})`);
      args.push(...ids);
    }
    if (query.reviewedOnly) {
      where.push("EXISTS (SELECT 1 FROM workflow_cases wc WHERE wc.event_id = e.id AND wc.status IN ('remanded', 'approved', 'dispatched', 'completed'))");
    }
    if (query.publishableOnly) {
      where.push("EXISTS (SELECT 1 FROM workflow_cases wc WHERE wc.event_id = e.id AND wc.status = 'completed' AND wc.publishable = 1 AND wc.completed_at IS NOT NULL)");
    }
    switch (query.tab) {
      case "breaking":
        where.push("(e.track_mode = 'breaking' OR e.importance >= 70)");
        break;
      case "domestic":
        where.push("e.countries LIKE '%\"cn\"%'");
        break;
      case "intl":
        where.push("e.countries NOT LIKE '%\"cn\"%'");
        break;
      case "diplomacy":
        where.push("(e.topics LIKE '%diplomacy%' OR e.topics LIKE '%defense%' OR e.topics LIKE '%conflict%')");
        break;
      case "economy":
        where.push("(e.topics LIKE '%economy%' OR e.topics LIKE '%policy%' OR e.topics LIKE '%finance%' OR e.topics LIKE '%energy%')");
        break;
    }

    const stmt = this.raw.prepare(`
      WITH selected_events AS (
        SELECT e.*
        FROM events e
        WHERE ${where.join(" AND ")}
        ORDER BY e.importance DESC, e.heat DESC, e.last_update_at DESC
        LIMIT ? OFFSET ?
      )
      SELECT e.*,
             (SELECT COUNT(*)
                FROM event_articles ea
               WHERE ea.event_id = e.id) AS article_count,
             (SELECT COUNT(*)
                FROM claims c
               WHERE c.event_id = e.id AND c.status = 'corroborated') AS confirmed_count,
             (SELECT COUNT(*)
                FROM claims c
               WHERE c.event_id = e.id AND c.status IN ('reported', 'unverified', 'partially_corroborated')) AS unverified_count,
             (SELECT COUNT(*)
                FROM claims c
               WHERE c.event_id = e.id AND c.status = 'disputed') AS disputed_count,
             (SELECT COUNT(DISTINCT COALESCE(NULLIF(a.wire_family, ''), NULLIF(a.reprint_of, ''), NULLIF(s.family_id, ''), 'source:' || s.id))
                FROM event_articles ea
                JOIN articles a ON a.id = ea.article_id
                JOIN sources s ON s.id = a.source_id
               WHERE ea.event_id = e.id) AS independent_source_count,
             (SELECT COUNT(DISTINCT s.category)
                FROM event_articles ea
                JOIN articles a ON a.id = ea.article_id
                JOIN sources s ON s.id = a.source_id
               WHERE ea.event_id = e.id) AS category_count
      FROM selected_events e
      ORDER BY e.importance DESC, e.heat DESC, e.last_update_at DESC
    `);
    const rows = stmt.all(...args, limit, offset) as Record<string, unknown>[];
    const items = rows.map(mapEventListRow);
    const trails = this.listSourceTrails(items.map((item) => item.id));
    return items.map((item) => ({ ...item, sourceTrail: trails.get(item.id) || [] }));
  }

  /** 每个事件保留最多四个独立来源家族的代表链接，供列表页直接追溯。 */
  private listSourceTrails(eventIds: readonly string[]): Map<string, Citation[]> {
    const ids = [...new Set(eventIds)].slice(0, 200);
    const output = new Map<string, Citation[]>();
    if (ids.length === 0) return output;
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.raw.prepare(`
      WITH family_ranked AS (
        SELECT ea.event_id,
               a.id AS article_id,
               a.title,
               a.url,
               a.source_id,
               a.lang,
               a.published_at,
               a.first_seen_at,
               a.is_reprint,
               s.name AS source_name,
               s.category AS source_category,
               s.is_party,
               s.party_of,
               s.is_primary,
               s.verif_status,
               s.health,
               ROW_NUMBER() OVER (
                 PARTITION BY ea.event_id,
                   COALESCE(NULLIF(a.wire_family, ''), NULLIF(a.reprint_of, ''), NULLIF(s.family_id, ''), 'source:' || s.id)
                 ORDER BY
                   CASE s.verif_status WHEN 'verified' THEN 2 WHEN 'pending' THEN 1 ELSE 0 END DESC,
                   CASE s.health WHEN 'ok' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END DESC,
                   s.is_party ASC,
                   CASE s.category
                     WHEN 'factcheck' THEN 12 WHEN 'intl_org' THEN 11 WHEN 'data' THEN 10 WHEN 'wire' THEN 9
                     WHEN 'gov_cn' THEN 8 WHEN 'gov_intl' THEN 8 WHEN 'official_media_cn' THEN 7
                     WHEN 'intl_media' THEN 7 WHEN 'market_media_cn' THEN 6 WHEN 'local_media' THEN 5
                     WHEN 'party_media' THEN 2 ELSE 1
                   END DESC,
                   s.is_primary DESC, a.is_reprint ASC, COALESCE(a.published_at, a.first_seen_at) DESC, a.id ASC
               ) AS family_rank
        FROM event_articles ea
        JOIN articles a ON a.id = ea.article_id
        JOIN sources s ON s.id = a.source_id
        WHERE ea.event_id IN (${placeholders})
      ), event_ranked AS (
        SELECT *, ROW_NUMBER() OVER (
          PARTITION BY event_id
          ORDER BY
            CASE verif_status WHEN 'verified' THEN 2 WHEN 'pending' THEN 1 ELSE 0 END DESC,
            CASE health WHEN 'ok' THEN 2 WHEN 'degraded' THEN 1 ELSE 0 END DESC,
            is_party ASC,
            CASE source_category
              WHEN 'factcheck' THEN 12 WHEN 'intl_org' THEN 11 WHEN 'data' THEN 10 WHEN 'wire' THEN 9
              WHEN 'gov_cn' THEN 8 WHEN 'gov_intl' THEN 8 WHEN 'official_media_cn' THEN 7
              WHEN 'intl_media' THEN 7 WHEN 'market_media_cn' THEN 6 WHEN 'local_media' THEN 5
              WHEN 'party_media' THEN 2 ELSE 1
            END DESC,
            is_primary DESC, is_reprint ASC, COALESCE(published_at, first_seen_at) DESC, article_id ASC
        ) AS event_rank
        FROM family_ranked
        WHERE family_rank = 1
      )
      SELECT * FROM event_ranked
      WHERE event_rank <= 4
      ORDER BY event_id, event_rank
    `).all(...ids) as Record<string, unknown>[];
    for (const row of rows) {
      const eventId = String(row.event_id);
      const grouped = output.get(eventId) || [];
      grouped.push({
        articleId: String(row.article_id),
        title: String(row.title),
        url: String(row.url),
        sourceId: String(row.source_id),
        sourceName: String(row.source_name),
        sourceCategory: String(row.source_category) as SourceCategory,
        lang: row.lang ? String(row.lang) : null,
        publishedAt: row.published_at ? String(row.published_at) : null,
        isParty: Boolean(Number(row.is_party)),
        partyOf: row.party_of ? String(row.party_of) : null,
      });
      output.set(eventId, grouped);
    }
    return output;
  }

  async detail(id: string): Promise<EventDetailDTO | null> {
    return (await this.detailWithArticles(id))?.detail ?? null;
  }

  /** 简报专用批量快照，避免最多 60 个事件逐一读取详情。 */
  async briefingDetails(eventIds: readonly string[]): Promise<Map<string, BriefingEventDetail>> {
    const ids = [...new Set(eventIds)].slice(0, 400);
    const output = new Map<string, BriefingEventDetail>();
    if (ids.length === 0) return output;

    const eventRows = await this.db.select().from(events).where(inArray(events.id, ids));
    if (eventRows.length === 0) return output;
    const loadedIds = eventRows.map((event) => event.id);
    const eventById = new Map(eventRows.map((event) => [event.id, event]));

    const joinedArticles = await this.db
      .select({
        eventId: eventArticles.eventId,
        article: articles,
        sourceName: sources.name,
        sourceCategory: sources.category,
        sourceFamilyId: sources.familyId,
        sourceIsParty: sources.isParty,
        sourcePartyOf: sources.partyOf,
        sourceIsPrimary: sources.isPrimary,
        sourceVerifStatus: sources.verifStatus,
        sourceHealth: sources.health,
      })
      .from(eventArticles)
      .innerJoin(articles, eq(eventArticles.articleId, articles.id))
      .innerJoin(sources, eq(articles.sourceId, sources.id))
      .where(inArray(eventArticles.eventId, loadedIds))
      .orderBy(eventArticles.eventId, articles.publishedAt, articles.firstSeenAt);
    const articlesByEvent = new Map<string, ArticleWithSource[]>();
    for (const row of joinedArticles) {
      const grouped = articlesByEvent.get(row.eventId) || [];
      grouped.push({
        ...row.article,
        sourceName: row.sourceName,
        sourceCategory: row.sourceCategory,
        sourceFamilyId: row.sourceFamilyId,
        sourceIsParty: row.sourceIsParty,
        sourcePartyOf: row.sourcePartyOf,
        sourceIsPrimary: row.sourceIsPrimary,
        sourceVerifStatus: row.sourceVerifStatus,
        sourceHealth: row.sourceHealth,
      });
      articlesByEvent.set(row.eventId, grouped);
    }

    const claimRows = await this.db
      .select()
      .from(claims)
      .where(inArray(claims.eventId, loadedIds))
      .orderBy(claims.eventId, claims.firstSeenAt);
    const claimDtos = await this.claimDtos(claimRows);
    const claimsByEvent = new Map<string, ClaimDTO[]>();
    for (const claim of claimDtos) {
      const grouped = claimsByEvent.get(claim.eventId) || [];
      grouped.push(claim);
      claimsByEvent.set(claim.eventId, grouped);
    }

    const versionRows = await this.db
      .select()
      .from(eventVersions)
      .where(inArray(eventVersions.eventId, loadedIds))
      .orderBy(eventVersions.eventId, desc(eventVersions.version));
    const latestVersionByEvent = new Map<string, typeof eventVersions.$inferSelect>();
    for (const version of versionRows) {
      const event = eventById.get(version.eventId);
      if (!event || version.version > event.version || latestVersionByEvent.has(version.eventId)) continue;
      latestVersionByEvent.set(version.eventId, version);
    }

    for (const event of eventRows) {
      const articleRows = articlesByEvent.get(event.id) || [];
      const eventClaims = claimsByEvent.get(event.id) || [];
      const latestVersion = latestVersionByEvent.get(event.id);
      const changes = parseJson<{ added: string[]; changed: string[]; removed: string[] }>(latestVersion?.changes, {
        added: [],
        changed: [],
        removed: [],
      });
      output.set(event.id, {
        summary: normalizeEventSummary(event.summary) || fallbackSummary(eventClaims, articleRows),
        citations: uniqueCitations(articleRows.map(toCitation)),
        delta: latestVersion
          ? { sinceVersion: latestVersion.version, added: changes.added, changed: changes.changed, removed: changes.removed }
          : null,
      });
    }
    return output;
  }

  /** 内部流水线快照：一次装载详情及其完整文章，避免调用方重复 JOIN。 */
  async detailWithArticles(id: string): Promise<EventDetailBundle | null> {
    const event = await this.get(id);
    if (!event) return null;
    const articleRows = await this.eventArticles(id);
    const claimRows = await this.claims(id);
    const claimDtos = await this.claimDtos(claimRows);
    const citations = uniqueCitations(articleRows.map(toCitation));
    const coverage = coverageFromArticles(articleRows);
    const summary = normalizeEventSummary(event.summary) || fallbackSummary(claimDtos, articleRows);
    const timeline = buildTimeline(claimDtos, articleRows);
    const lastVersion = (
      await this.db
        .select()
        .from(eventVersions)
        .where(and(eq(eventVersions.eventId, id), lte(eventVersions.version, event.version)))
        .orderBy(desc(eventVersions.version))
        .limit(1)
    )[0];
    const changes = parseJson<{ added: string[]; changed: string[]; removed: string[] }>(lastVersion?.changes, {
      added: [],
      changed: [],
      removed: [],
    });
    const counts = countClaimStatuses(claimDtos);

    const detail: EventDetailDTO = {
      id: event.id,
      title: event.title,
      oneLiner: event.oneLiner,
      status: event.status as EventDetailDTO["status"],
      trackMode: event.trackMode as EventDetailDTO["trackMode"],
      importance: event.importance,
      heat: event.heat,
      heatTrend: event.heat > event.prevHeat ? "up" : event.heat < event.prevHeat ? "down" : "flat",
      firstAt: event.firstAt,
      lastUpdateAt: event.lastUpdateAt,
      countries: event.countries || [],
      topics: event.topics || [],
      articleCount: articleRows.length,
      independentSourceCount: coverage.independentFamilies,
      confirmedCount: counts.corroborated,
      unverifiedCount: unverifiedClaimCount(counts),
      disputedCount: counts.disputed,
      coverageGapCount: coverage.gaps.length,
      sourceTrail: citations.slice(0, 4),
      version: event.version,
      lastVerifiedAt: event.lastVerifiedAt,
      summary,
      claims: claimDtos,
      timeline,
      coverage,
      delta: lastVersion
        ? { sinceVersion: lastVersion.version, added: changes.added, changed: changes.changed, removed: changes.removed }
        : null,
      citations,
      featuredReport: selectFeaturedReport(articleRows, claimDtos),
      summaryEngine: event.summaryEngine as "ai" | "extractive",
    };
    return { event, detail, articles: articleRows };
  }

  /** 批量物化 Claim 证据，避免详情页按 Claim 数量发出 N+1 查询。 */
  private async claimDtos(claimRows: readonly ClaimRow[]): Promise<ClaimDTO[]> {
    if (claimRows.length === 0) return [];
    const evidenceByClaim = new Map<string, EvidenceDTO[]>();
    const claimIds = [...new Set(claimRows.map((claim) => claim.id))];
    const chunkSize = 400;

    for (let offset = 0; offset < claimIds.length; offset += chunkSize) {
      const rows = await this.db
        .select({
          claimId: claimEvidence.claimId,
          articleId: articles.id,
          stance: claimEvidence.stance,
          familyKey: claimEvidence.familyKey,
          hasPrimary: claimEvidence.hasPrimary,
          note: claimEvidence.note,
          articleTitle: articles.title,
          articleUrl: articles.url,
          articleLang: articles.lang,
          articlePublishedAt: articles.publishedAt,
          sourceId: sources.id,
          sourceName: sources.name,
          sourceCategory: sources.category,
          sourceIsParty: sources.isParty,
          sourcePartyOf: sources.partyOf,
        })
        .from(claimEvidence)
        .innerJoin(articles, eq(claimEvidence.articleId, articles.id))
        .innerJoin(sources, eq(articles.sourceId, sources.id))
        .where(inArray(claimEvidence.claimId, claimIds.slice(offset, offset + chunkSize)))
        .orderBy(claimEvidence.claimId, claimEvidence.articleId);

      for (const row of rows) {
        const evidence = evidenceByClaim.get(row.claimId) || [];
        evidence.push({
          articleId: row.articleId,
          stance: row.stance as EvidenceDTO["stance"],
          familyKey: row.familyKey,
          hasPrimary: row.hasPrimary,
          note: row.note,
          citation: {
            articleId: row.articleId,
            title: row.articleTitle,
            url: row.articleUrl,
            sourceId: row.sourceId,
            sourceName: row.sourceName,
            sourceCategory: row.sourceCategory as SourceCategory,
            lang: row.articleLang,
            publishedAt: row.articlePublishedAt,
            isParty: row.sourceIsParty,
            partyOf: row.sourcePartyOf,
          },
        });
        evidenceByClaim.set(row.claimId, evidence);
      }
    }

    return claimRows.map((claim) => this.claimDto(claim, evidenceByClaim.get(claim.id) || []));
  }

  private claimDto(claim: ClaimRow, evidence: EvidenceDTO[]): ClaimDTO {
    return {
      id: claim.id,
      eventId: claim.eventId,
      text: claim.text,
      type: claim.type as ClaimDTO["type"],
      claimedBy: claim.claimedBy,
      party: claim.party,
      subjectNumber: claim.subjectNumber,
      numberUnit: claim.numberUnit,
      asOf: claim.asOf,
      occurredAt: claim.occurredAt,
      publishedAt: claim.publishedAt,
      firstSeenAt: claim.firstSeenAt,
      status: claim.status as ClaimStatus,
      rationale: parseJson<ClaimRationale | null>(claim.rationale, null),
      lastCheckedAt: claim.lastCheckedAt,
      evidence,
    };
  }

  /** 事件标题/概览的轻量搜索；文章与 Claim 使用各自 FTS5 索引 */
  searchEvents(query: string, limit = 50, reviewedOnly = false): EventListItem[] {
    const terms = query.toLocaleLowerCase().split(/[\s，,；;]+/).map((term) => term.trim()).filter(Boolean);
    if (terms.length === 0) return [];
    return this.list({ reviewedOnly, limit: 200 })
      .filter((event) => {
        const text = `${event.title}\n${event.oneLiner || ""}\n${event.topics.join(" ")}`.toLocaleLowerCase();
        return terms.every((term) => text.includes(term));
      })
      .slice(0, Math.min(Math.max(limit, 1), 100));
  }

  async searchClaims(query: string, limit = 50, reviewedOnly = false): Promise<ClaimDTO[]> {
    const tokens = [...new Set(ftsTokenize(query).split(/\s+/).filter(Boolean))].slice(0, 16);
    if (tokens.length === 0) return [];
    const match = tokens.map((token) => `"${token.replace(/"/g, '""')}"`).join(" OR ");
    const ids = this.raw
      .prepare(`
        SELECT f.cid
        FROM claims_fts f
        JOIN claims c ON c.id = f.cid
        WHERE claims_fts MATCH ?
          ${reviewedOnly ? "AND EXISTS (SELECT 1 FROM workflow_cases wc WHERE wc.event_id = c.event_id AND wc.status IN ('remanded', 'approved', 'dispatched', 'completed'))" : ""}
        ORDER BY bm25(claims_fts)
        LIMIT ?
      `)
      .all(match, Math.min(Math.max(limit, 1), 100)) as Array<{ cid: string }>;
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(claims).where(inArray(claims.id, ids.map((row) => row.cid)));
    const order = new Map(ids.map((row, index) => [row.cid, index]));
    const dtos = await this.claimDtos(rows);
    return dtos.sort((a, b) => (order.get(a.id) ?? 999) - (order.get(b.id) ?? 999));
  }

  async count(): Promise<number> {
    const row = (await this.db.select({ n: sql<number>`count(*)` }).from(events))[0];
    return Number(row?.n || 0);
  }

  async countSince(since: string): Promise<number> {
    const row = (
      await this.db.select({ n: sql<number>`count(*)` }).from(events).where(gte(events.firstAt, since))
    )[0];
    return Number(row?.n || 0);
  }

  async claimCount(): Promise<number> {
    const row = (await this.db.select({ n: sql<number>`count(*)` }).from(claims))[0];
    return Number(row?.n || 0);
  }

  async claimStatusCount(status: ClaimStatus): Promise<number> {
    const row = (await this.db.select({ n: sql<number>`count(*)` }).from(claims).where(eq(claims.status, status)))[0];
    return Number(row?.n || 0);
  }
}

function mapEventListRow(row: Record<string, unknown>): EventListItem {
  const heat = Number(row.heat || 0);
  const prevHeat = Number(row.prev_heat || 0);
  const categoryCount = Number(row.category_count || 0);
  return {
    id: String(row.id),
    title: String(row.title),
    oneLiner: row.one_liner ? String(row.one_liner) : null,
    status: String(row.status) as EventListItem["status"],
    trackMode: String(row.track_mode) as EventListItem["trackMode"],
    importance: Number(row.importance || 0),
    heat,
    heatTrend: heat > prevHeat ? "up" : heat < prevHeat ? "down" : "flat",
    firstAt: String(row.first_at),
    lastUpdateAt: String(row.last_update_at),
    countries: parseJson<string[]>(row.countries, []),
    topics: parseJson<string[]>(row.topics, []),
    articleCount: Number(row.article_count || 0),
    independentSourceCount: Number(row.independent_source_count || 0),
    confirmedCount: Number(row.confirmed_count || 0),
    unverifiedCount: Number(row.unverified_count || 0),
    disputedCount: Number(row.disputed_count || 0),
    // 重大事件的理想覆盖桶为六类；这里只是列表页快速近似，详情页给出精确缺口
    coverageGapCount: Math.max(0, 6 - categoryCount),
    sourceTrail: [],
  };
}

function unverifiedClaimCount(counts: Record<string, number>): number {
  return (counts.reported || 0) + (counts.unverified || 0) + (counts.partially_corroborated || 0);
}

function coverageFromArticles(rows: ArticleWithSource[]): CoverageDTO {
  const counts: Record<string, number> = {};
  const families = new Set<string>();
  for (const row of rows) {
    counts[row.sourceCategory] = (counts[row.sourceCategory] || 0) + 1;
    families.add(row.wireFamily || row.reprintOf || row.sourceFamilyId || `source:${row.sourceId}`);
  }
  const buckets: Array<{ label: string; hit: boolean }> = [
    { label: "相关方A原始说法", hit: rows.some((r) => r.sourceIsParty && r.sourceIsPrimary) },
    { label: "相关方B原始说法", hit: new Set(rows.filter((r) => r.sourceIsParty).map((r) => r.sourcePartyOf)).size >= 2 },
    { label: "独立通讯社或综合媒体", hit: rows.some((r) => ["wire", "intl_media", "market_media_cn"].includes(r.sourceCategory) && !r.sourceIsParty) },
    { label: "事发地当地或民间来源", hit: rows.some((r) => ["local_media", "social", "social_cn"].includes(r.sourceCategory)) },
    { label: "国际组织、文件或技术数据", hit: rows.some((r) => ["intl_org", "data", "gov_cn", "gov_intl"].includes(r.sourceCategory) && r.sourceIsPrimary) },
    { label: "经验证记者、专家或现场来源", hit: rows.some((r) => ["social", "social_cn"].includes(r.sourceCategory)) },
  ];
  return {
    present: buckets.filter((b) => b.hit).map((b) => b.label),
    gaps: buckets.filter((b) => !b.hit).map((b) => b.label),
    byCategory: counts,
    independentFamilies: families.size,
  };
}

function fallbackSummary(claims_: ClaimDTO[], articleRows: ArticleWithSource[]): EventSummaryDTO {
  const confirmed = claims_
    .filter((c) => c.status === "corroborated")
    .map((c) => ({ text: c.text, claimId: c.id, citations: uniqueCitations(c.evidence.flatMap((e) => (e.citation ? [e.citation] : []))) }));
  const unverified = claims_
    .filter((c) => ["reported", "unverified", "partially_corroborated"].includes(c.status))
    .map((c) => ({ text: c.text, claimId: c.id, citations: uniqueCitations(c.evidence.flatMap((e) => (e.citation ? [e.citation] : []))) }));
  const partyMap = new Map<string, ClaimDTO[]>();
  for (const c of claims_.filter((x) => x.type === "statement" || x.party)) {
    const key = c.party || "media";
    partyMap.set(key, [...(partyMap.get(key) || []), c]);
  }
  const statements = [...partyMap.entries()].map(([party, list]) => ({
    party,
    partyLabel: PARTY_LABELS[party] || party,
    items: list.map((c) => ({
      text: c.text,
      status: c.status,
      claimId: c.id,
      citations: uniqueCitations(c.evidence.flatMap((e) => (e.citation ? [e.citation] : []))),
    })),
  }));
  return {
    oneLiner: confirmed[0]?.text || unverified[0]?.text || articleRows[0]?.excerpt || "正在聚合与核验相关报道。",
    confirmed,
    statements,
    unverified,
    disputed: buildDisputes(claims_),
    whyItMatters: null,
  };
}

function buildDisputes(claims_: ClaimDTO[]): DisputeGroup[] {
  const disputed = claims_.filter((c) => c.status === "disputed");
  const groups = new Map<string, ClaimDTO[]>();
  for (const claim of disputed) {
    const key = claim.numberUnit || claim.type || "相关说法";
    groups.set(key, [...(groups.get(key) || []), claim]);
  }
  return [...groups.entries()].map(([topic, list]) => ({
    topic,
    positions: list.map((c) => ({
      party: PARTY_LABELS[c.party || "other"] || c.claimedBy || "未注明",
      text: c.text,
      number: c.subjectNumber,
      asOf: c.asOf,
      citation: c.evidence.find((e) => e.citation)?.citation || null,
    })),
  }));
}

function buildTimeline(claims_: ClaimDTO[], articleRows: ArticleWithSource[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const claim of claims_) {
    const at = claim.occurredAt || claim.publishedAt || claim.firstSeenAt;
    out.push({
      at,
      kind: claim.type === "statement" ? "statement" : "occurrence",
      text: claim.text,
      citation: claim.evidence.find((e) => e.citation)?.citation || null,
    });
  }
  for (const article of articleRows) {
    if (!article.publishedAt) continue;
    out.push({ at: article.publishedAt, kind: "report", text: `${article.sourceName}发布相关报道`, citation: toCitation(article) });
  }
  out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  // 相同时间+文本去重，避免 Claim 与报道生成重复节点
  const seen = new Set<string>();
  return out.filter((item) => {
    const key = `${item.at}|${item.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function toCitation(row: ArticleWithSource): Citation {
  return {
    articleId: row.id,
    title: row.title,
    url: row.url,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    sourceCategory: row.sourceCategory as SourceCategory,
    lang: row.lang,
    publishedAt: row.publishedAt,
    isParty: row.sourceIsParty,
    partyOf: row.sourcePartyOf,
  };
}

const SOURCE_CREDIBILITY_WEIGHT: Partial<Record<SourceCategory, number>> = {
  factcheck: 28,
  intl_org: 26,
  data: 24,
  wire: 22,
  gov_cn: 20,
  gov_intl: 20,
  official_media_cn: 18,
  intl_media: 18,
  market_media_cn: 15,
  local_media: 13,
  party_media: 4,
  social_cn: 2,
  social: 2,
};

export function selectFeaturedReport(rows: ArticleWithSource[], claims_: ClaimDTO[]): FeaturedReportDTO | null {
  if (!rows.length) return null;
  const corroboratedArticleIds = new Set(
    claims_
      .filter((claim) => claim.status === "corroborated")
      .flatMap((claim) => claim.evidence.map((evidence) => evidence.articleId))
  );
  const ranked = rows.map((row) => {
    const category = row.sourceCategory as SourceCategory;
    const reasons: string[] = [];
    let score = SOURCE_CREDIBILITY_WEIGHT[category] || 0;
    if (corroboratedArticleIds.has(row.id)) {
      score += 50;
      reasons.push("关联已交叉确认主张");
    }
    if (row.sourceVerifStatus === "verified") {
      score += 24;
      reasons.push("来源身份已核验");
    }
    if (row.sourceHealth === "ok") {
      score += 16;
      reasons.push("来源当前可稳定访问");
    }
    if (!row.sourceIsParty) {
      score += 12;
      reasons.push("非事件相关方媒体");
    }
    if (row.sourceIsPrimary) {
      score += 12;
      reasons.push("包含第一手材料");
    }
    if (!row.isReprint) {
      score += 8;
      reasons.push("非转载稿");
    }
    if (row.paywalled) score -= 4;
    return { row, score, reasons };
  }).sort((a, b) => b.score - a.score
    || String(b.row.publishedAt || b.row.firstSeenAt).localeCompare(String(a.row.publishedAt || a.row.firstSeenAt))
    || a.row.id.localeCompare(b.row.id));
  const best = ranked[0];
  const rawExcerpt = stripHtml(best.row.excerpt || best.row.bodyText || best.row.title);
  return {
    citation: toCitation(best.row),
    excerpt: textExcerpt(rawExcerpt, 460),
    credibility: best.score >= 80 ? "high" : best.score >= 50 ? "medium" : "limited",
    reasons: best.reasons.slice(0, 5),
    isPrimary: best.row.sourceIsPrimary,
    isReprint: best.row.isReprint,
  };
}

function uniqueCitations(items: Citation[]): Citation[] {
  const map = new Map<string, Citation>();
  for (const c of items) map.set(c.articleId, c);
  return [...map.values()];
}

function diffSummary(oldValue: EventSummaryDTO | null, next: EventSummaryDTO): { added: string[]; changed: string[]; removed: string[] } {
  if (!oldValue) return { added: flattenSummary(next), changed: [], removed: [] };
  const before = new Set(flattenSummary(oldValue));
  const after = new Set(flattenSummary(next));
  const added = [...after].filter((x) => !before.has(x));
  const removed = [...before].filter((x) => !after.has(x));
  const changed = oldValue.oneLiner !== next.oneLiner ? [`一句话概览：${oldValue.oneLiner} → ${next.oneLiner}`] : [];
  return { added, changed, removed };
}

function flattenSummary(s: EventSummaryDTO): string[] {
  const confirmed = Array.isArray(s.confirmed) ? s.confirmed : [];
  const unverified = Array.isArray(s.unverified) ? s.unverified : [];
  const statements = Array.isArray(s.statements) ? s.statements : [];
  const disputed = Array.isArray(s.disputed) ? s.disputed : [];
  return [
    ...confirmed.map((x) => `已确认：${x.text}`),
    ...unverified.map((x) => `待核实：${x.text}`),
    ...statements.flatMap((g) => (Array.isArray(g.items) ? g.items : []).map((x) => `${g.partyLabel}：${x.text}`)),
    ...disputed.map((x) => `争议：${x.topic}`),
  ];
}

function countClaimStatuses(rows: ClaimDTO[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[row.status] = (out[row.status] || 0) + 1;
  return out;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

/** 兼容旧版 Drizzle JSON 列曾写入 JSON.stringify(summary) 形成的双层 JSON 字符串。 */
function normalizeEventSummary(value: unknown): EventSummaryDTO | null {
  let decoded = value;
  for (let depth = 0; depth < 3 && typeof decoded === "string"; depth += 1) {
    try {
      decoded = JSON.parse(decoded);
    } catch {
      return null;
    }
  }
  const raw = objectRecord(decoded);
  if (!raw) return null;

  const claimItems = (input: unknown): EventSummaryDTO["confirmed"] => recordArray(input).map((item) => ({
    text: typeof item.text === "string" ? item.text : "",
    claimId: typeof item.claimId === "string" ? item.claimId : "",
    citations: recordArray(item.citations) as unknown as Citation[],
  }));
  const statements = recordArray(raw.statements).map((group) => ({
    party: typeof group.party === "string" ? group.party : "unknown",
    partyLabel: typeof group.partyLabel === "string" ? group.partyLabel : "未知主体",
    items: recordArray(group.items).map((item) => ({
      text: typeof item.text === "string" ? item.text : "",
      status: (typeof item.status === "string" ? item.status : "reported") as ClaimStatus,
      claimId: typeof item.claimId === "string" ? item.claimId : "",
      citations: recordArray(item.citations) as unknown as Citation[],
    })),
  }));
  const disputed = recordArray(raw.disputed).map((group) => ({
    topic: typeof group.topic === "string" ? group.topic : "未命名争议",
    positions: recordArray(group.positions).map((position) => ({
      party: typeof position.party === "string" ? position.party : "unknown",
      text: typeof position.text === "string" ? position.text : "",
      number: typeof position.number === "number" ? position.number : null,
      asOf: typeof position.asOf === "string" ? position.asOf : null,
      citation: objectRecord(position.citation) as unknown as Citation | null,
    })),
  }));
  const why = objectRecord(raw.whyItMatters);
  return {
    oneLiner: typeof raw.oneLiner === "string" ? raw.oneLiner : "",
    confirmed: claimItems(raw.confirmed),
    statements,
    unverified: claimItems(raw.unverified),
    disputed,
    whyItMatters: why && typeof why.text === "string"
      ? { text: why.text, generatedBy: why.generatedBy === "ai" ? "ai" : "rule" }
      : null,
  };
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function recordArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(objectRecord).filter((item): item is Record<string, unknown> => item !== null)
    : [];
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "");
}
