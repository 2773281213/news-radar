import { beforeEach, describe, expect, it, vi } from "vitest";
import { runAdapter } from "../adapters";
import type { Config } from "../config";
import type { KV } from "../lib/kv";
import type { ArticleRow, ArticleStore } from "./article-store";
import type { EventRow, EventStore } from "./event-store";
import { IngestionService } from "./ingestion";
import type { SourceRow, SourceStore } from "./source-store";

vi.mock("../adapters", () => ({ runAdapter: vi.fn() }));

const mockedRunAdapter = vi.mocked(runAdapter);
const AT = "2026-08-02T12:00:00.000Z";

function source(id: string): SourceRow {
  return {
    id,
    name: `来源 ${id}`,
    homepage: null,
    feedUrl: null,
    adapter: "rss",
    config: null,
    country: "cn",
    region: null,
    lang: "zh",
    category: "wire",
    owner: null,
    ownershipNote: null,
    isParty: false,
    partyOf: null,
    isPrimary: false,
    paywalled: false,
    fetchFulltext: false,
    intervalMin: 30,
    verifStatus: "verified",
    verifBasis: null,
    lastReviewedAt: null,
    familyId: null,
    enabled: true,
    lastFetchAt: null,
    lastSuccessAt: null,
    consecFails: 0,
    backoffUntil: null,
    health: "ok",
    corrections: 0,
    addedBy: "test",
    notes: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

function article(overrides: Partial<ArticleRow> = {}): ArticleRow {
  return {
    id: "art_update",
    sourceId: "src_update",
    url: "https://example.test/update",
    canonicalUrl: null,
    normalizedUrl: "https://example.test/update",
    guid: null,
    title: "旧标题",
    titleNorm: "旧标题",
    author: null,
    lang: "zh",
    publishedAt: AT,
    srcUpdatedAt: AT,
    firstSeenAt: AT,
    lastCrawledAt: AT,
    bodyText: "旧正文",
    excerpt: "旧摘要",
    imageUrl: null,
    contentHash: "old-content-hash",
    simhash: null,
    isReprint: false,
    reprintOf: null,
    wireFamily: null,
    paywalled: false,
    eventId: null,
    status: "new",
    extra: null,
    ...overrides,
  };
}

function event(): EventRow {
  return {
    id: "evt_update",
    title: "更新后的测试事件",
    oneLiner: null,
    status: "developing",
    trackMode: "normal",
    importance: 30,
    heat: 1,
    prevHeat: 0,
    topics: [],
    countries: [],
    entities: [],
    firstAt: AT,
    lastUpdateAt: AT,
    lastVerifiedAt: null,
    version: 1,
    summary: null,
    summaryEngine: "extractive",
    dirty: true,
    lastSummaryAt: null,
  };
}

function config(fetchConcurrency = 4): Config {
  return {
    userAgent: "NewsRadarTest/1.0",
    rsshubBase: "https://rsshub.example.test",
    fetchConcurrency,
  } as Config;
}

describe("IngestionService candidate pooling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not load candidates when due sources return no items", async () => {
    const due = [source("src_a"), source("src_b"), source("src_c"), source("src_d")];
    mockedRunAdapter.mockResolvedValue({ items: [], httpStatus: 200 });
    const sourceStore = {
      due: vi.fn().mockResolvedValue(due),
      familyKind: vi.fn().mockResolvedValue(null),
      recordFetch: vi.fn().mockResolvedValue(undefined),
    };
    const articleStore = { recentCandidates: vi.fn().mockResolvedValue([]) };
    const eventStore = { recentCandidates: vi.fn().mockResolvedValue([]) };
    const service = new IngestionService(
      config(),
      {} as KV,
      sourceStore as unknown as SourceStore,
      articleStore as unknown as ArticleStore,
      eventStore as unknown as EventStore
    );

    const results = await service.runDue(4);

    expect(results).toHaveLength(4);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(mockedRunAdapter).toHaveBeenCalledTimes(4);
    expect(articleStore.recentCandidates).not.toHaveBeenCalled();
    expect(eventStore.recentCandidates).not.toHaveBeenCalled();
    expect(sourceStore.recordFetch).toHaveBeenCalledTimes(4);
  });

  it("loads one shared candidate pair when concurrent sources contain new items", async () => {
    const due = [source("src_new_a"), source("src_new_b"), source("src_new_c"), source("src_new_d")];
    mockedRunAdapter.mockImplementation(async (sourceRow) => ({
      httpStatus: 200,
      items: [{
        url: `https://example.test/${sourceRow.id}`,
        title: `候选池共享测试 ${sourceRow.id}`,
        contentHtml: `<p>这是用于触发候选池加载的新文章正文 ${sourceRow.id}</p>`,
        publishedAt: AT,
      }],
    }));
    const sourceStore = {
      due: vi.fn().mockResolvedValue(due),
      familyKind: vi.fn().mockResolvedValue(null),
      recordFetch: vi.fn().mockResolvedValue(undefined),
    };
    const articleStore = {
      recentCandidates: vi.fn().mockResolvedValue([]),
      byNormalizedUrl: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ article: article(), inserted: false }),
    };
    const eventStore = { recentCandidates: vi.fn().mockResolvedValue([]) };
    const service = new IngestionService(
      config(),
      {} as KV,
      sourceStore as unknown as SourceStore,
      articleStore as unknown as ArticleStore,
      eventStore as unknown as EventStore
    );

    const results = await service.runDue(4);

    expect(results).toHaveLength(4);
    expect(results.every((result) => result.ok && result.skipped === 1)).toBe(true);
    expect(articleStore.recentCandidates).toHaveBeenCalledTimes(1);
    expect(eventStore.recentCandidates).toHaveBeenCalledTimes(1);
    expect(articleStore.insert).toHaveBeenCalledTimes(4);
    expect(sourceStore.recordFetch).toHaveBeenCalledTimes(4);
  });

  it("reuses the preloaded event candidates when an existing article changes", async () => {
    const sourceRow = source("src_update");
    const oldArticle = article();
    const updatedArticle = article({
      title: "北京人工智能芯片技术产业发布更新",
      titleNorm: "北京人工智能芯片技术产业发布更新",
      bodyText: "北京人工智能芯片技术产业发布更新，正文包含足够信息以重新进入事件聚类。",
      excerpt: "更新后的摘要",
      contentHash: "new-content-hash",
      srcUpdatedAt: "2026-08-02T12:01:00.000Z",
    });
    mockedRunAdapter.mockResolvedValue({
      httpStatus: 200,
      items: [{
        url: oldArticle.url,
        title: updatedArticle.title,
        contentHtml: `<p>${updatedArticle.bodyText}</p>`,
        summaryHtml: updatedArticle.excerpt,
        publishedAt: updatedArticle.publishedAt,
        updatedAt: updatedArticle.srcUpdatedAt,
      }],
    });
    const sourceStore = {
      familyKind: vi.fn().mockResolvedValue(null),
      recordFetch: vi.fn().mockResolvedValue(undefined),
    };
    const articleStore = {
      recentCandidates: vi.fn().mockResolvedValue([oldArticle]),
      byNormalizedUrl: vi.fn().mockResolvedValue(oldArticle),
      updateContent: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockResolvedValue(updatedArticle),
    };
    const matchedEvent = {
      ...event(),
      title: updatedArticle.title,
      topics: ["technology"],
      countries: ["cn"],
      entities: [{ slug: "beijing", count: 1 }],
    };
    const eventStore = {
      recentCandidates: vi.fn().mockResolvedValue([matchedEvent]),
      get: vi.fn().mockResolvedValue(matchedEvent),
      applyEventUpdate: vi.fn().mockResolvedValue(undefined),
      insertEvent: vi.fn().mockResolvedValue(matchedEvent),
      attachArticle: vi.fn().mockResolvedValue(undefined),
      upsertClaim: vi.fn().mockResolvedValue(undefined),
      upsertEvidence: vi.fn().mockResolvedValue(undefined),
      claims: vi.fn().mockResolvedValue([]),
      touch: vi.fn().mockResolvedValue(AT),
    };
    const service = new IngestionService(
      config(1),
      {} as KV,
      sourceStore as unknown as SourceStore,
      articleStore as unknown as ArticleStore,
      eventStore as unknown as EventStore
    );

    const result = await service.ingestSource(sourceRow);

    expect(result).toMatchObject({ ok: true, updated: 1, eventIds: ["evt_update"] });
    expect(articleStore.recentCandidates).toHaveBeenCalledTimes(1);
    expect(eventStore.recentCandidates).toHaveBeenCalledTimes(1);
    expect(eventStore.applyEventUpdate).toHaveBeenCalledTimes(1);
    expect(eventStore.insertEvent).not.toHaveBeenCalled();
    expect(sourceStore.familyKind).toHaveBeenCalledTimes(1);
  });

  it("does not load candidates when every fetched URL is unchanged", async () => {
    const sourceRow = source("src_unchanged");
    const title = "同一网址内容保持不变";
    const bodyText = "这篇文章的标题、正文与来源更新时间都没有发生变化。";
    const existing = article({
      id: "art_unchanged",
      sourceId: sourceRow.id,
      url: "https://example.test/unchanged",
      normalizedUrl: "https://example.test/unchanged",
      title,
      titleNorm: title,
      bodyText,
      excerpt: bodyText,
      contentHash: null,
      srcUpdatedAt: AT,
    });
    mockedRunAdapter.mockResolvedValue({
      httpStatus: 200,
      items: [{
        url: existing.url,
        title,
        contentHtml: `<p>${bodyText}</p>`,
        publishedAt: existing.publishedAt,
        updatedAt: existing.srcUpdatedAt,
      }],
    });
    const sourceStore = {
      familyKind: vi.fn().mockResolvedValue(null),
      recordFetch: vi.fn().mockResolvedValue(undefined),
    };
    const articleStore = {
      recentCandidates: vi.fn().mockResolvedValue([]),
      byNormalizedUrl: vi.fn().mockResolvedValue(existing),
      updateContent: vi.fn().mockResolvedValue(false),
    };
    const eventStore = { recentCandidates: vi.fn().mockResolvedValue([]) };
    const service = new IngestionService(
      config(1),
      {} as KV,
      sourceStore as unknown as SourceStore,
      articleStore as unknown as ArticleStore,
      eventStore as unknown as EventStore
    );

    const result = await service.ingestSource(sourceRow);

    expect(result).toMatchObject({ ok: true, found: 1, added: 0, updated: 0, skipped: 1 });
    expect(articleStore.recentCandidates).not.toHaveBeenCalled();
    expect(eventStore.recentCandidates).not.toHaveBeenCalled();
    expect(articleStore.updateContent).not.toHaveBeenCalled();
    expect(sourceStore.recordFetch).toHaveBeenCalledTimes(1);
  });

  it("falls back per source when one shared preload side fails", async () => {
    const due = [source("src_fallback_a"), source("src_fallback_b")];
    mockedRunAdapter.mockImplementation(async (sourceRow) => ({
      httpStatus: 200,
      items: [{
        url: `https://example.test/${sourceRow.id}`,
        title: `候选池回退测试 ${sourceRow.id}`,
        contentHtml: `<p>这是用于触发逐来源回退的新文章正文 ${sourceRow.id}</p>`,
        publishedAt: AT,
      }],
    }));
    const sourceStore = {
      due: vi.fn().mockResolvedValue(due),
      familyKind: vi.fn().mockResolvedValue(null),
      recordFetch: vi.fn().mockResolvedValue(undefined),
    };
    const articleStore = {
      recentCandidates: vi.fn()
        .mockRejectedValueOnce(new Error("shared article preload failed"))
        .mockResolvedValue([]),
      byNormalizedUrl: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockResolvedValue({ article: article(), inserted: false }),
    };
    const eventStore = { recentCandidates: vi.fn().mockResolvedValue([]) };
    const service = new IngestionService(
      config(2),
      {} as KV,
      sourceStore as unknown as SourceStore,
      articleStore as unknown as ArticleStore,
      eventStore as unknown as EventStore
    );

    const results = await service.runDue(2);

    expect(results.every((result) => result.ok)).toBe(true);
    expect(articleStore.recentCandidates).toHaveBeenCalledTimes(3);
    expect(eventStore.recentCandidates).toHaveBeenCalledTimes(1);
    expect(articleStore.insert).toHaveBeenCalledTimes(2);
    expect(sourceStore.recordFetch).toHaveBeenCalledTimes(2);
  });

  it("reports a source failure when its candidate fallback also fails", async () => {
    const sourceRow = source("src_fallback_failure");
    mockedRunAdapter.mockResolvedValue({
      httpStatus: 200,
      items: [{
        url: "https://example.test/fallback-failure",
        title: "候选池回退失败测试",
        contentHtml: "<p>这是用于触发候选池回退失败的新文章正文。</p>",
        publishedAt: AT,
      }],
    });
    const sourceStore = {
      familyKind: vi.fn().mockResolvedValue(null),
      recordFetch: vi.fn().mockResolvedValue(undefined),
    };
    const articleStore = {
      recentCandidates: vi.fn()
        .mockRejectedValueOnce(new Error("shared article preload failed"))
        .mockRejectedValueOnce(new Error("article fallback failed")),
      byNormalizedUrl: vi.fn().mockResolvedValue(null),
      insert: vi.fn(),
    };
    const eventStore = { recentCandidates: vi.fn().mockResolvedValue([]) };
    const service = new IngestionService(
      config(1),
      {} as KV,
      sourceStore as unknown as SourceStore,
      articleStore as unknown as ArticleStore,
      eventStore as unknown as EventStore
    );

    const result = await service.ingestSource(sourceRow);

    expect(result).toMatchObject({ ok: false, found: 1, added: 0, updated: 0, skipped: 0 });
    expect(result.error).toContain("article fallback failed");
    expect(articleStore.recentCandidates).toHaveBeenCalledTimes(2);
    expect(articleStore.insert).not.toHaveBeenCalled();
    expect(sourceStore.recordFetch).toHaveBeenCalledTimes(1);
  });

  it("serializes event selection so concurrent sources create only one event", async () => {
    const due = [source("src_serial_a"), source("src_serial_b")];
    const title = "北京人工智能芯片产业联合发布进展";
    mockedRunAdapter.mockImplementation(async (sourceRow) => ({
      httpStatus: 200,
      items: [{
        url: `https://example.test/${sourceRow.id}`,
        title,
        contentHtml: `<p>${title}，两家来源报道同一现实事件并提供完整背景。</p>`,
        publishedAt: AT,
      }],
    }));
    const sourceStore = {
      due: vi.fn().mockResolvedValue(due),
      familyKind: vi.fn().mockResolvedValue(null),
      recordFetch: vi.fn().mockResolvedValue(undefined),
    };
    const savedArticles = new Map<string, ArticleRow>();
    const articleStore = {
      recentCandidates: vi.fn().mockResolvedValue([]),
      byNormalizedUrl: vi.fn().mockResolvedValue(null),
      insert: vi.fn().mockImplementation(async (row: Partial<ArticleRow>) => {
        const saved = article({ ...row, eventId: null, status: "new" });
        savedArticles.set(saved.id, saved);
        return { article: saved, inserted: true };
      }),
      get: vi.fn().mockImplementation(async (id: string) => savedArticles.get(id) ?? null),
      setWireFamily: vi.fn().mockResolvedValue(undefined),
    };
    let createdEvent: EventRow | null = null;
    const eventStore = {
      recentCandidates: vi.fn()
        .mockRejectedValueOnce(new Error("shared event preload failed"))
        .mockResolvedValue([]),
      insertEvent: vi.fn().mockImplementation(async (row: Partial<EventRow>) => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        createdEvent = {
          ...event(),
          ...row,
          topics: ["technology"],
          countries: ["cn"],
          entities: [{ slug: "beijing", count: 1 }],
        };
        return createdEvent;
      }),
      get: vi.fn().mockImplementation(async (id: string) => createdEvent?.id === id ? createdEvent : null),
      applyEventUpdate: vi.fn().mockImplementation(async (_id: string, patch: Partial<EventRow>) => {
        if (createdEvent) createdEvent = { ...createdEvent, ...patch };
      }),
      attachArticle: vi.fn().mockImplementation(async (eventId: string, articleId: string) => {
        const saved = savedArticles.get(articleId);
        if (saved) savedArticles.set(articleId, { ...saved, eventId, status: "analyzed" });
      }),
      upsertClaim: vi.fn().mockResolvedValue(undefined),
      upsertEvidence: vi.fn().mockResolvedValue(undefined),
      claims: vi.fn().mockResolvedValue([]),
      touch: vi.fn().mockResolvedValue(AT),
    };
    const service = new IngestionService(
      config(2),
      {} as KV,
      sourceStore as unknown as SourceStore,
      articleStore as unknown as ArticleStore,
      eventStore as unknown as EventStore
    );

    const results = await service.runDue(2);

    expect(results.map((result) => result.added)).toEqual([1, 1]);
    expect(new Set(results.flatMap((result) => result.eventIds)).size).toBe(1);
    expect(eventStore.insertEvent).toHaveBeenCalledTimes(1);
    expect(eventStore.applyEventUpdate).toHaveBeenCalledTimes(1);
    expect(eventStore.recentCandidates).toHaveBeenCalledTimes(3);
  });

  it("continues pending articles after one event resolution fails", async () => {
    const badArticle = article({ id: "art_pending_bad", sourceId: "src_pending_bad", normalizedUrl: "https://example.test/pending-bad" });
    const goodArticle = article({ id: "art_pending_good", sourceId: "src_pending_good", normalizedUrl: "https://example.test/pending-good" });
    const badSource = source("src_pending_bad");
    const goodSource = source("src_pending_good");
    const sourceStore = {
      getManyWithFamilyKind: vi.fn().mockResolvedValue([
        { source: badSource, familyKind: null },
        { source: goodSource, familyKind: null },
      ]),
    };
    const articleStore = {
      unprocessed: vi.fn().mockResolvedValue([badArticle, goodArticle]),
      get: vi.fn().mockResolvedValue(null),
      markAnalyzed: vi.fn().mockResolvedValue(undefined),
    };
    const createdEvent = event();
    const eventStore = {
      recentCandidates: vi.fn().mockResolvedValue([]),
      insertEvent: vi.fn()
        .mockRejectedValueOnce(new Error("first event insert failed"))
        .mockResolvedValue(createdEvent),
      get: vi.fn().mockResolvedValue(createdEvent),
      attachArticle: vi.fn().mockResolvedValue(undefined),
      upsertClaim: vi.fn().mockResolvedValue(undefined),
      upsertEvidence: vi.fn().mockResolvedValue(undefined),
      claims: vi.fn().mockResolvedValue([]),
      touch: vi.fn().mockResolvedValue(AT),
    };
    const service = new IngestionService(
      config(1),
      {} as KV,
      sourceStore as unknown as SourceStore,
      articleStore as unknown as ArticleStore,
      eventStore as unknown as EventStore
    );

    const touched = await service.processPending(2);

    expect(touched).toEqual([createdEvent.id]);
    expect(sourceStore.getManyWithFamilyKind).toHaveBeenCalledTimes(1);
    expect(eventStore.recentCandidates).toHaveBeenCalledTimes(1);
    expect(eventStore.insertEvent).toHaveBeenCalledTimes(2);
    expect(eventStore.attachArticle).toHaveBeenCalledTimes(1);
  });
});
