import type { Config } from "../config";
import { runAdapter } from "../adapters";
import type { FetchedItem } from "../adapters/types";
import { yieldToEventLoop } from "../lib/async";
import type { KV } from "../lib/kv";
import { hoursAgoIso, nowIso } from "../lib/time";
import { validatePublicUrl } from "../lib/ssrf";
import {
  applyReprintDecision,
  classifyDuplicate,
  deriveFamilyKey,
  detectReprintFamilyAsync,
  prepareArticle,
  type ArticleInsert,
} from "../pipeline/dedupe";
import {
  buildEventArticleInsert,
  buildEventInsert,
  buildEventUpdate,
  resolveEventAsync,
  type ClusterArticleInput,
  type ClusterEventInput,
} from "../pipeline/cluster";
import { buildClaimEvidenceInsert, extractClaims, toClaimInsert } from "../pipeline/claims";
import { evaluateClaimStatus, handleCasualtyNumberConflicts } from "../pipeline/verify";
import type { ArticleStore, ArticleRow, RecentArticleCandidate } from "./article-store";
import type { EventStore, EventRow } from "./event-store";
import type { SourceRow, SourceStore } from "./source-store";

const ARTICLE_CANDIDATE_LIMIT = 1500;
const EVENT_CANDIDATE_LIMIT = 500;

interface IngestionCandidatePool {
  articles: RecentArticleCandidate[] | null;
  events: ClusterEventInput[] | null;
  eventResolution: AsyncSerial;
}

interface ResolvedCandidatePool {
  articles: RecentArticleCandidate[];
  events: ClusterEventInput[];
  eventResolution: AsyncSerial;
}

interface CandidatePoolAccessor {
  load(): Promise<IngestionCandidatePool>;
  current(): IngestionCandidatePool | null;
}

export interface IngestResult {
  sourceId: string;
  ok: boolean;
  found: number;
  added: number;
  updated: number;
  skipped: number;
  eventIds: string[];
  error: string | null;
  ms: number;
}

/**
 * Scout + Resolver + Verification 的主处理流水线。
 * 单条坏数据只影响该条，不会终止整个来源；来源级结果仍如实记录。
 */
export class IngestionService {
  constructor(
    private config: Config,
    private kv: KV,
    private sourceStore: SourceStore,
    private articleStore: ArticleStore,
    private eventStore: EventStore
  ) {}

  async ingestSource(source: SourceRow, sharedCandidates?: CandidatePoolAccessor): Promise<IngestResult> {
    const startedAt = nowIso();
    const startMs = Date.now();
    let result: IngestResult = {
      sourceId: source.id,
      ok: false,
      found: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      eventIds: [],
      error: null,
      ms: 0,
    };

    try {
      const fetched = await runAdapter(
        source,
        this.kv,
        {
          userAgent: this.config.userAgent,
          timeoutMs: 25_000,
          maxBytes: 4 * 1024 * 1024,
          maxRedirects: 5,
        },
        this.config.rsshubBase
      );
      result.found = fetched.items.length;
      if (fetched.error) throw new Error(fetched.error);

      const candidatePool = sharedCandidates ?? this.createCandidatePoolAccessor();
      let resolvedPool: ResolvedCandidatePool | null = null;
      let pendingPool: Promise<ResolvedCandidatePool> | null = null;
      const loadCandidates = () => {
        pendingPool ??= this.resolveCandidatePool(candidatePool).then((pool) => {
          resolvedPool = pool;
          return pool;
        });
        return pendingPool;
      };
      const familyKind = await this.sourceStore.familyKind(source.familyId);

      for (const item of fetched.items.slice(0, 200)) {
        try {
          const processed = await this.processItem(
            source,
            familyKind,
            item,
            loadCandidates,
            startedAt
          );
          const currentPool = resolvedPool ?? candidatePool.current();
          if (processed.kind === "added") {
            result.added++;
            if (currentPool?.articles) rememberCandidate(currentPool.articles, processed.article, ARTICLE_CANDIDATE_LIMIT);
            if (processed.event && currentPool?.events) rememberCandidate(currentPool.events, processed.event, EVENT_CANDIDATE_LIMIT);
            if (processed.eventId) result.eventIds.push(processed.eventId);
          } else if (processed.kind === "updated") {
            result.updated++;
            if (currentPool?.articles) rememberCandidate(currentPool.articles, processed.article, ARTICLE_CANDIDATE_LIMIT);
            if (processed.event && currentPool?.events) rememberCandidate(currentPool.events, processed.event, EVENT_CANDIDATE_LIMIT);
            if (processed.eventId) result.eventIds.push(processed.eventId);
          } else {
            result.skipped++;
          }
        } catch (error) {
          if (error instanceof CandidatePoolUnavailableError) throw error;
          result.skipped++;
          console.warn(`[采集:${source.id}] 跳过异常条目: ${safeMessage(error)}`);
        }
        await yieldToEventLoop();
      }
      result.ok = true;
    } catch (error) {
      result.error = safeMessage(error);
    }

    result.eventIds = [...new Set(result.eventIds)];
    result.ms = Date.now() - startMs;
    await this.sourceStore.recordFetch(source, startedAt, {
      ok: result.ok,
      httpStatus: result.ok ? 200 : null,
      found: result.found,
      added: result.added,
      error: result.error,
      ms: result.ms,
    });
    return result;
  }

  /** Search Agent 等发现型入口：处理一批已取得的合法公开条目，不修改来源调度状态 */
  async ingestItems(source: SourceRow, items: FetchedItem[], seenAt = nowIso()): Promise<string[]> {
    const candidatePool = this.createCandidatePoolAccessor();
    let resolvedPool: ResolvedCandidatePool | null = null;
    let pendingPool: Promise<ResolvedCandidatePool> | null = null;
    const loadCandidates = () => {
      pendingPool ??= this.resolveCandidatePool(candidatePool).then((pool) => {
        resolvedPool = pool;
        return pool;
      });
      return pendingPool;
    };
    const familyKind = await this.sourceStore.familyKind(source.familyId);
    const eventIds: string[] = [];
    for (const item of items.slice(0, 200)) {
      try {
        const processed = await this.processItem(
          source,
          familyKind,
          item,
          loadCandidates,
          seenAt
        );
        const currentPool = resolvedPool ?? candidatePool.current();
        if (processed.kind === "added") {
          if (currentPool?.articles) rememberCandidate(currentPool.articles, processed.article, ARTICLE_CANDIDATE_LIMIT);
          if (processed.event && currentPool?.events) rememberCandidate(currentPool.events, processed.event, EVENT_CANDIDATE_LIMIT);
        } else if (processed.kind === "updated") {
          if (currentPool?.articles) rememberCandidate(currentPool.articles, processed.article, ARTICLE_CANDIDATE_LIMIT);
          if (processed.event && currentPool?.events) rememberCandidate(currentPool.events, processed.event, EVENT_CANDIDATE_LIMIT);
        }
        if ("eventId" in processed && processed.eventId) eventIds.push(processed.eventId);
      } catch (error) {
        if (error instanceof CandidatePoolUnavailableError) throw error;
        console.warn(`[发现:${source.id}] 跳过异常条目: ${safeMessage(error)}`);
      }
      await yieldToEventLoop();
    }
    return [...new Set(eventIds)];
  }

  /** 对数据库中尚未分析的文章补跑聚类与 Claim 提取 */
  async processPending(limit = 200): Promise<string[]> {
    const rows = await this.articleStore.unprocessed(limit);
    if (rows.length === 0) return [];
    const sourceRows = await this.sourceStore.getManyWithFamilyKind(rows.map((article) => article.sourceId));
    const sourcesById = new Map(sourceRows.map((row) => [row.source.id, row]));
    const recentEvents = await this.eventStore.recentCandidates(hoursAgoIso(14 * 24), EVENT_CANDIDATE_LIMIT);
    const eventResolution = new AsyncSerial();
    const touched: string[] = [];
    for (const article of rows) {
      try {
        const sourceRow = sourcesById.get(article.sourceId);
        if (!sourceRow) {
          await this.articleStore.markAnalyzed(article.id);
        } else {
          const eventId = await this.resolveAndVerify(
            article,
            sourceRow.source,
            sourceRow.familyKind,
            recentEvents,
            eventResolution
          );
          if (eventId) {
            touched.push(eventId);
            const event = await this.eventStore.get(eventId);
            if (event) rememberCandidate(recentEvents, event, EVENT_CANDIDATE_LIMIT);
          }
        }
      } catch (error) {
        console.warn(`[待处理:${article.id}] 跳过异常文章: ${safeMessage(error)}`);
      }
      await yieldToEventLoop();
    }
    return [...new Set(touched)];
  }

  /** 仅运行一批到期来源，调度器可频繁调用而不重复抓取 */
  async runDue(limit = 20): Promise<IngestResult[]> {
    const due = await this.sourceStore.due(limit);
    const sharedCandidates = this.createCandidatePoolAccessor();
    return mapConcurrent(due, this.config.fetchConcurrency, (source) => this.ingestSource(source, sharedCandidates));
  }

  /** 首篇确需分析的文章惰性装载一次共享候选集。 */
  private createCandidatePoolAccessor(): CandidatePoolAccessor {
    let current: IngestionCandidatePool | null = null;
    let pending: Promise<IngestionCandidatePool> | null = null;
    return {
      load: () => {
        pending ??= this.loadCandidatePool().then((pool) => {
          current = pool;
          return pool;
        });
        return pending;
      },
      current: () => current,
    };
  }

  /** 共享预载单侧失败时，每个来源只执行一次本地回退。 */
  private async resolveCandidatePool(accessor: CandidatePoolAccessor): Promise<ResolvedCandidatePool> {
    try {
      const pool = await accessor.load();
      const since = hoursAgoIso(14 * 24);
      const [articleFallback, eventFallback] = await Promise.all([
        pool.articles === null
          ? this.articleStore.recentCandidates(since, ARTICLE_CANDIDATE_LIMIT)
          : Promise.resolve<RecentArticleCandidate[] | undefined>(undefined),
        pool.events === null
          ? this.eventStore.recentCandidates(since, EVENT_CANDIDATE_LIMIT)
          : Promise.resolve<ClusterEventInput[] | undefined>(undefined),
      ]);

      // 并发来源可能同时开始回退；首个成功结果成为共享引用，后续结果只作兜底。
      if (pool.articles === null) pool.articles = articleFallback ?? [];
      if (pool.events === null) pool.events = eventFallback ?? [];
      return { articles: pool.articles, events: pool.events, eventResolution: pool.eventResolution };
    } catch (error) {
      throw new CandidatePoolUnavailableError(error);
    }
  }

  /** 首次加载时隔离文章和事件查询失败，供来源级回退分别补齐。 */
  private async loadCandidatePool(): Promise<IngestionCandidatePool> {
    const since = hoursAgoIso(14 * 24);
    const [articleResult, eventResult] = await Promise.allSettled([
      this.articleStore.recentCandidates(since, ARTICLE_CANDIDATE_LIMIT),
      this.eventStore.recentCandidates(since, EVENT_CANDIDATE_LIMIT),
    ]);
    return {
      articles: articleResult.status === "fulfilled" ? articleResult.value : null,
      events: eventResult.status === "fulfilled" ? eventResult.value : null,
      eventResolution: new AsyncSerial(),
    };
  }

  private async processItem(
    source: SourceRow,
    familyKind: string | null,
    item: FetchedItem,
    loadCandidates: () => Promise<ResolvedCandidatePool>,
    seenAt: string
  ): Promise<
    | { kind: "added"; article: ArticleRow; event: EventRow | null; eventId: string | null }
    | { kind: "updated"; article: ArticleRow; event: EventRow | null; eventId: string | null }
    | { kind: "skipped" }
  > {
    const urlCheck = validatePublicUrl(item.url);
    if (!urlCheck.ok) throw new Error(`条目 URL 被拒绝：${urlCheck.reason}`);

    const prepared = prepareArticle(source, item, { seenAt });
    const existing = await this.articleStore.byNormalizedUrl(prepared.normalizedUrl);
    if (existing) {
      const decision = classifyDuplicate(prepared, existing);
      if (decision.kind !== "update") return { kind: "skipped" };
      const changed = await this.articleStore.updateContent(existing.id, {
        title: prepared.title,
        titleNorm: prepared.titleNorm,
        bodyText: prepared.bodyText,
        excerpt: prepared.excerpt,
        contentHash: prepared.contentHash,
        srcUpdatedAt: prepared.srcUpdatedAt,
      });
      if (!changed) return { kind: "skipped" };
      const updated = (await this.articleStore.get(existing.id)) || existing;
      if (existing.eventId) return { kind: "updated", article: updated, event: null, eventId: existing.eventId };
      const candidates = await loadCandidates();
      const eventId = await this.resolveAndVerify(
        updated,
        source,
        familyKind,
        candidates.events,
        candidates.eventResolution
      );
      const event = eventId ? await this.eventStore.get(eventId) : null;
      return { kind: "updated", article: { ...updated, eventId }, event, eventId };
    }

    const candidates = await loadCandidates();
    const reprint = await detectReprintFamilyAsync(
      prepared,
      candidates.articles.map((article) => ({ article }))
    );
    const withReprint = applyReprintDecision(prepared, reprint);
    const inserted = await this.articleStore.insert(withReprint);
    if (!inserted.inserted) return { kind: "skipped" };
    if (reprint.rootFamilyPatch) {
      await this.articleStore.setWireFamily(reprint.rootFamilyPatch.articleId, reprint.rootFamilyPatch.wireFamily);
    }

    const eventId = await this.resolveAndVerify(
      inserted.article,
      source,
      familyKind,
      candidates.events,
      candidates.eventResolution
    );
    const event = eventId ? await this.eventStore.get(eventId) : null;
    return { kind: "added", article: { ...inserted.article, eventId }, event, eventId };
  }

  private async resolveAndVerify(
    article: ArticleRow,
    source: SourceRow,
    familyKind?: string | null,
    cachedEvents?: ClusterEventInput[],
    eventResolution?: AsyncSerial
  ): Promise<string | null> {
    const candidates = cachedEvents || (await this.eventStore.recentCandidates(hoursAgoIso(14 * 24), 500));
    const clusterArticle: ClusterArticleInput = {
      id: article.id,
      title: article.title,
      titleNorm: article.titleNorm,
      bodyText: article.bodyText,
      excerpt: article.excerpt,
      publishedAt: article.publishedAt,
      firstSeenAt: article.firstSeenAt,
      reprintOf: article.reprintOf,
    };

    const chooseEvent = async (): Promise<EventRow> => {
      let event: EventRow | null = null;
      // 转载稿优先沿用根稿事件，避免相似度因译文或标题改写而误拆分
      const root = article.reprintOf ? await this.articleStore.get(article.reprintOf) : null;
      if (root?.eventId) {
        const rootEvent = await this.eventStore.get(root.eventId);
        if (rootEvent) {
          const patch = buildEventUpdate(rootEvent, clusterArticle);
          await this.eventStore.applyEventUpdate(rootEvent.id, patch);
          event = { ...rootEvent, ...patch };
        }
      }
      // 根稿事件已删除时重新聚类，避免文章永久停留在未分析状态。
      if (!event) {
        const resolution = await resolveEventAsync(clusterArticle, candidates);
        if (resolution.action === "attach" && resolution.eventId) {
          const matched = await this.eventStore.get(resolution.eventId);
          if (!matched) throw new Error("聚类候选事件已不存在");
          const patch = buildEventUpdate(matched, clusterArticle);
          await this.eventStore.applyEventUpdate(matched.id, patch);
          event = { ...matched, ...patch };
        } else {
          event = await this.eventStore.insertEvent(buildEventInsert(clusterArticle));
        }
      }
      rememberCandidate(candidates, event, EVENT_CANDIDATE_LIMIT);
      return event;
    };
    const event = eventResolution ? await eventResolution.run(chooseEvent) : await chooseEvent();

    const familyKey = deriveFamilyKey(article, {
      id: source.id,
      familyId: source.familyId,
      familyKind: familyKind !== undefined ? familyKind : (await this.sourceStore.familyKind(source.familyId)),
    });
    const role = source.isParty ? "statement" : source.category === "data" ? "data" : "report";
    const link = buildEventArticleInsert(event.id, article.id, nowIso(), role, familyKey);
    await this.eventStore.attachArticle(link.eventId, link.articleId, link.role || role, link.familyKey ?? null);

    const extracted = extractClaims({
      eventId: event.id,
      articleId: article.id,
      title: article.title,
      bodyText: article.bodyText,
      excerpt: article.excerpt,
      publishedAt: article.publishedAt,
      firstSeenAt: article.firstSeenAt,
      source: {
        id: source.id,
        name: source.name,
        category: source.category,
        adapter: source.adapter,
        isParty: source.isParty,
        partyOf: source.partyOf,
        isPrimary: source.isPrimary,
      },
      familyKey,
      maxClaims: 16,
    });

    for (const claim of extracted) {
      await this.eventStore.upsertClaim(toClaimInsert(claim));
      await this.eventStore.upsertEvidence(buildClaimEvidenceInsert(claim, article.id, nowIso(), familyKey));
    }
    await this.verifyEvent(event.id);
    return event.id;
  }

  /** Claim-specific 核验：报道数量不会自动升级为事实确认；伤亡冲突另行并列处理 */
  async verifyEvent(eventId: string): Promise<void> {
    const claimRows = await this.eventStore.claims(eventId);
    for (const claim of claimRows) {
      const evidence = await this.eventStore.verificationEvidence(claim.id);
      const result = evaluateClaimStatus(claim, evidence);
      await this.eventStore.setClaimStatus(claim.id, result.status, result.rationale, claim.supersededBy);
      await yieldToEventLoop();
    }

    const refreshed = await this.eventStore.claims(eventId);
    const conflicts = handleCasualtyNumberConflicts(
      refreshed.map((claim) => ({
        ...claim,
        status: claim.status,
        rationale: asRationale(claim.rationale),
      })),
      { checkedAt: nowIso() }
    );
    for (const update of conflicts.updates) {
      await this.eventStore.setClaimStatus(update.id, update.status, update.rationale, update.supersededBy);
      await yieldToEventLoop();
    }
    await this.eventStore.touch(eventId, { lastVerifiedAt: nowIso() });
  }
}

function asRationale(value: unknown) {
  if (!value) return null;
  if (typeof value !== "string") return value as { factors: string[]; independentChains: number; hasPrimary: boolean; hasRefutation: boolean };
  try {
    return JSON.parse(value) as { factors: string[]; independentChains: number; hasPrimary: boolean; hasRefutation: boolean };
  } catch {
    return null;
  }
}

function safeMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).slice(0, 1000);
}

function rememberCandidate<T extends { id: string }>(rows: T[], candidate: T, limit: number): void {
  const existing = rows.findIndex((row) => row.id === candidate.id);
  if (existing >= 0) rows.splice(existing, 1);
  rows.unshift(candidate);
  if (rows.length > limit) rows.length = limit;
}

class AsyncSerial {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

class CandidatePoolUnavailableError extends Error {
  constructor(error: unknown) {
    super(`候选池加载失败：${safeMessage(error)}`);
    this.name = "CandidatePoolUnavailableError";
  }
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (items.length === 0) return [];
  const output = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await fn(items[index]);
    }
  });
  await Promise.all(workers);
  return output;
}
