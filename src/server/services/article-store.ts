import type Database from "better-sqlite3";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { articleVersions, articles, sources } from "../db/schema";
import type { ArticleDTO, Citation, SourceCategory } from "../../shared/types";
import { ftsTokenize } from "../lib/textsim";
import { nowIso } from "../lib/time";

export type ArticleRow = typeof articles.$inferSelect;
export type NewArticle = typeof articles.$inferInsert;
export type RecentArticleCandidate = Pick<
  ArticleRow,
  | "id"
  | "sourceId"
  | "url"
  | "canonicalUrl"
  | "normalizedUrl"
  | "guid"
  | "title"
  | "titleNorm"
  | "bodyText"
  | "excerpt"
  | "contentHash"
  | "simhash"
  | "publishedAt"
  | "firstSeenAt"
  | "srcUpdatedAt"
  | "isReprint"
  | "reprintOf"
  | "wireFamily"
>;

export interface ArticleWithSource extends ArticleRow {
  sourceName: string;
  sourceCategory: string;
  sourceFamilyId: string | null;
  sourceIsParty: boolean;
  sourcePartyOf: string | null;
  sourceIsPrimary: boolean;
  sourceVerifStatus: string;
  sourceHealth: string;
}

/** 文章持久化与全文索引；内容去重算法位于 pipeline/dedupe.ts */
export class ArticleStore {
  constructor(
    private db: DB,
    private raw: Database.Database
  ) {}

  async get(id: string): Promise<ArticleRow | null> {
    return (await this.db.select().from(articles).where(eq(articles.id, id)).limit(1))[0] ?? null;
  }

  async byNormalizedUrl(normalizedUrl: string): Promise<ArticleRow | null> {
    return (await this.db.select().from(articles).where(eq(articles.normalizedUrl, normalizedUrl)).limit(1))[0] ?? null;
  }

  async byContentHash(contentHash: string): Promise<ArticleRow[]> {
    if (!contentHash) return [];
    return this.db.select().from(articles).where(eq(articles.contentHash, contentHash)).limit(20);
  }

  /** 最近文章候选集，用于 SimHash 与标题相似度比对 */
  async recentCandidates(sinceIso: string, limit = 800): Promise<RecentArticleCandidate[]> {
    return this.db
      .select({
        id: articles.id,
        sourceId: articles.sourceId,
        url: articles.url,
        canonicalUrl: articles.canonicalUrl,
        normalizedUrl: articles.normalizedUrl,
        guid: articles.guid,
        title: articles.title,
        titleNorm: articles.titleNorm,
        bodyText: articles.bodyText,
        excerpt: articles.excerpt,
        contentHash: articles.contentHash,
        simhash: articles.simhash,
        publishedAt: articles.publishedAt,
        firstSeenAt: articles.firstSeenAt,
        srcUpdatedAt: articles.srcUpdatedAt,
        isReprint: articles.isReprint,
        reprintOf: articles.reprintOf,
        wireFamily: articles.wireFamily,
      })
      .from(articles)
      .where(gte(articles.firstSeenAt, sinceIso))
      .orderBy(desc(articles.firstSeenAt))
      .limit(Math.min(Math.max(limit, 1), 2000));
  }

  /** 原子插入文章；若规范 URL 已存在则返回现有文章 */
  async insert(row: NewArticle): Promise<{ article: ArticleRow; inserted: boolean }> {
    const existing = await this.byNormalizedUrl(row.normalizedUrl);
    if (existing) return { article: existing, inserted: false };

    try {
      await this.db.insert(articles).values(row);
      await this.db.insert(articleVersions).values({
        articleId: row.id,
        seenAt: row.firstSeenAt,
        title: row.title,
        contentHash: row.contentHash ?? null,
        note: "initial",
      });
      this.upsertFts(row.id, `${row.title}\n${row.excerpt || ""}\n${row.bodyText || ""}`);
      const inserted = await this.get(row.id);
      if (!inserted) throw new Error("文章写入后无法读取");
      return { article: inserted, inserted: true };
    } catch (error) {
      // 并发采集相同 URL 时唯一索引可能先由另一任务写入
      const raced = await this.byNormalizedUrl(row.normalizedUrl);
      if (raced) return { article: raced, inserted: false };
      throw error;
    }
  }

  /** 原文有修改时保存版本并更新正文，不覆盖历史版本 */
  async updateContent(
    id: string,
    patch: Pick<NewArticle, "title" | "titleNorm" | "bodyText" | "excerpt" | "contentHash" | "srcUpdatedAt">
  ): Promise<boolean> {
    const old = await this.get(id);
    if (!old) return false;
    if (old.contentHash === patch.contentHash && old.title === patch.title) return false;
    const seenAt = nowIso();
    await this.db.insert(articleVersions).values({
      articleId: id,
      seenAt,
      title: patch.title,
      contentHash: patch.contentHash ?? null,
      note: "modified",
    });
    await this.db
      .update(articles)
      .set({ ...patch, lastCrawledAt: seenAt })
      .where(eq(articles.id, id));
    this.upsertFts(id, `${patch.title}\n${patch.excerpt || ""}\n${patch.bodyText || ""}`);
    return true;
  }

  async markReprint(id: string, originalId: string | null, wireFamily: string | null): Promise<void> {
    await this.db
      .update(articles)
      .set({ isReprint: true, reprintOf: originalId, wireFamily })
      .where(eq(articles.id, id));
  }

  /** 为转载根稿补写统一证据家族，不改变其“原稿”身份 */
  async setWireFamily(id: string, wireFamily: string): Promise<void> {
    await this.db.update(articles).set({ wireFamily }).where(eq(articles.id, id));
  }

  async assignEvent(id: string, eventId: string): Promise<void> {
    await this.db.update(articles).set({ eventId, status: "analyzed" }).where(eq(articles.id, id));
  }

  async markAnalyzed(id: string): Promise<void> {
    await this.db.update(articles).set({ status: "analyzed" }).where(eq(articles.id, id));
  }

  async unprocessed(limit = 200): Promise<ArticleRow[]> {
    return this.db
      .select()
      .from(articles)
      .where(eq(articles.status, "new"))
      .orderBy(articles.firstSeenAt)
      .limit(Math.min(Math.max(limit, 1), 1000));
  }

  async withSources(ids: string[]): Promise<ArticleWithSource[]> {
    if (ids.length === 0) return [];
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
      .from(articles)
      .innerJoin(sources, eq(articles.sourceId, sources.id))
      .where(inArray(articles.id, ids));
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

  async recent(hours = 24, limit = 100, reviewedOnly = false): Promise<ArticleWithSource[]> {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
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
      .from(articles)
      .innerJoin(sources, eq(articles.sourceId, sources.id))
      .where(and(
        gte(articles.firstSeenAt, since),
        reviewedOnly
          ? sql`EXISTS (
              SELECT 1 FROM workflow_cases wc
              WHERE wc.event_id = ${articles.eventId}
                AND wc.status IN ('remanded', 'approved', 'dispatched', 'completed')
            )`
          : undefined
      ))
      .orderBy(desc(articles.publishedAt), desc(articles.firstSeenAt))
      .limit(Math.min(Math.max(limit, 1), 500));
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

  /** FTS5 搜索；查询先经过与入库一致的中文二元组分词 */
  search(query: string, limit = 50, reviewedOnly = false): ArticleWithSource[] {
    const tokens = [...new Set(ftsTokenize(query).split(/\s+/).filter(Boolean))].slice(0, 16);
    if (tokens.length === 0) return [];
    const match = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" OR ");
    const stmt = this.raw.prepare(`
      SELECT a.*, s.name AS source_name, s.category AS source_category,
             s.family_id AS source_family_id, s.is_party AS source_is_party,
             s.party_of AS source_party_of, s.is_primary AS source_is_primary,
             s.verif_status AS source_verif_status, s.health AS source_health
      FROM articles_fts f
      JOIN articles a ON a.id = f.uid
      JOIN sources s ON s.id = a.source_id
      WHERE articles_fts MATCH ?
        ${reviewedOnly ? "AND EXISTS (SELECT 1 FROM workflow_cases wc WHERE wc.event_id = a.event_id AND wc.status IN ('remanded', 'approved', 'dispatched', 'completed'))" : ""}
      ORDER BY bm25(articles_fts), COALESCE(a.published_at, a.first_seen_at) DESC
      LIMIT ?
    `);
    const rows = stmt.all(match, Math.min(Math.max(limit, 1), 200)) as Record<string, unknown>[];
    return rows.map(mapRawArticleWithSource);
  }

  private upsertFts(id: string, text: string): void {
    const tokenized = ftsTokenize(text).slice(0, 500_000);
    const tx = this.raw.transaction(() => {
      this.raw.prepare("DELETE FROM articles_fts WHERE uid = ?").run(id);
      this.raw.prepare("INSERT INTO articles_fts(uid, search_text) VALUES (?, ?)").run(id, tokenized);
    });
    tx();
  }

  async count(): Promise<number> {
    const row = (await this.db.select({ n: sql<number>`count(*)` }).from(articles))[0];
    return Number(row?.n || 0);
  }

  async countSince(since: string): Promise<number> {
    const row = (await this.db.select({ n: sql<number>`count(*)` }).from(articles).where(gte(articles.firstSeenAt, since)))[0];
    return Number(row?.n || 0);
  }

  async lastIngestAt(): Promise<string | null> {
    const row = (await this.db.select({ at: sql<string | null>`max(${articles.firstSeenAt})` }).from(articles))[0];
    return row?.at ?? null;
  }

  toDTO(row: ArticleWithSource): ArticleDTO {
    return {
      id: row.id,
      sourceId: row.sourceId,
      sourceName: row.sourceName,
      sourceCategory: row.sourceCategory as SourceCategory,
      url: row.url,
      title: row.title,
      lang: row.lang,
      publishedAt: row.publishedAt,
      firstSeenAt: row.firstSeenAt,
      excerpt: row.excerpt,
      isReprint: row.isReprint,
      wireFamily: row.wireFamily,
      paywalled: row.paywalled,
      eventId: row.eventId,
    };
  }

  citation(row: ArticleWithSource): Citation {
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
}

function mapRawArticleWithSource(row: Record<string, unknown>): ArticleWithSource {
  const bool = (v: unknown) => Boolean(Number(v));
  let extra: Record<string, unknown> | null = null;
  try {
    extra = row.extra ? JSON.parse(String(row.extra)) : null;
  } catch {
    extra = null;
  }
  return {
    id: String(row.id),
    sourceId: String(row.source_id),
    url: String(row.url),
    canonicalUrl: row.canonical_url ? String(row.canonical_url) : null,
    normalizedUrl: String(row.normalized_url),
    guid: row.guid ? String(row.guid) : null,
    title: String(row.title),
    titleNorm: String(row.title_norm),
    author: row.author ? String(row.author) : null,
    lang: row.lang ? String(row.lang) : null,
    publishedAt: row.published_at ? String(row.published_at) : null,
    srcUpdatedAt: row.src_updated_at ? String(row.src_updated_at) : null,
    firstSeenAt: String(row.first_seen_at),
    lastCrawledAt: row.last_crawled_at ? String(row.last_crawled_at) : null,
    bodyText: row.body_text ? String(row.body_text) : null,
    excerpt: row.excerpt ? String(row.excerpt) : null,
    imageUrl: row.image_url ? String(row.image_url) : null,
    contentHash: row.content_hash ? String(row.content_hash) : null,
    simhash: row.simhash ? String(row.simhash) : null,
    isReprint: bool(row.is_reprint),
    reprintOf: row.reprint_of ? String(row.reprint_of) : null,
    wireFamily: row.wire_family ? String(row.wire_family) : null,
    paywalled: bool(row.paywalled),
    eventId: row.event_id ? String(row.event_id) : null,
    status: String(row.status),
    extra,
    sourceName: String(row.source_name),
    sourceCategory: String(row.source_category),
    sourceFamilyId: row.source_family_id ? String(row.source_family_id) : null,
    sourceIsParty: bool(row.source_is_party),
    sourcePartyOf: row.source_party_of ? String(row.source_party_of) : null,
    sourceIsPrimary: bool(row.source_is_primary),
    sourceVerifStatus: String(row.source_verif_status || "pending"),
    sourceHealth: String(row.source_health || "unknown"),
  };
}
