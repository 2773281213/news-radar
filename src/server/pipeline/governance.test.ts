import { describe, expect, it } from "vitest";
import type { EventDetailDTO } from "../../shared/types";
import type { ArticleWithSource } from "../services/article-store";
import { assertWorkflowTransition, buildWorkflowInputHash, draftByZhongshu, reviewByMenxia } from "./governance";

function detail(overrides: Partial<EventDetailDTO> = {}): EventDetailDTO {
  return {
    id: "evt_test",
    title: "测试事件",
    oneLiner: null,
    status: "developing",
    trackMode: "active",
    importance: 75,
    heat: 40,
    heatTrend: "up",
    firstAt: "2026-07-31T00:00:00.000Z",
    lastUpdateAt: "2026-07-31T01:00:00.000Z",
    countries: ["cn"],
    topics: ["policy"],
    articleCount: 2,
    confirmedCount: 0,
    disputedCount: 0,
    coverageGapCount: 1,
    version: 1,
    lastVerifiedAt: null,
    summary: null,
    claims: [],
    timeline: [],
    coverage: { present: ["中国官方"], gaps: ["中国市场化媒体"], byCategory: { gov_cn: 1 }, independentFamilies: 2 },
    delta: null,
    citations: [],
    summaryEngine: "extractive",
    ...overrides,
    independentSourceCount: overrides.independentSourceCount ?? 2,
    unverifiedCount: overrides.unverifiedCount ?? 0,
    sourceTrail: overrides.sourceTrail ?? [],
    featuredReport: overrides.featuredReport ?? null,
  };
}

function article(id: string, overrides: Partial<ArticleWithSource> = {}): ArticleWithSource {
  return {
    id,
    sourceId: `src_${id}`,
    url: `https://example.com/${id}`,
    canonicalUrl: null,
    normalizedUrl: `https://example.com/${id}`,
    guid: null,
    title: "材料",
    titleNorm: "材料",
    author: null,
    lang: "zh",
    publishedAt: "2026-07-31T00:30:00.000Z",
    srcUpdatedAt: null,
    firstSeenAt: "2026-07-31T00:31:00.000Z",
    lastCrawledAt: null,
    bodyText: null,
    excerpt: "材料摘要",
    imageUrl: null,
    contentHash: `hash_${id}`,
    simhash: null,
    isReprint: false,
    reprintOf: null,
    wireFamily: null,
    paywalled: false,
    eventId: "evt_test",
    status: "analyzed",
    extra: null,
    sourceName: `来源 ${id}`,
    sourceCategory: "gov_cn",
    sourceFamilyId: `family_${id}`,
    sourceIsParty: false,
    sourcePartyOf: null,
    sourceIsPrimary: true,
    sourceVerifStatus: "verified",
    sourceHealth: "ok",
    ...overrides,
  };
}

describe("三省治理规则", () => {
  it("摘要变化不会改变证据输入指纹", () => {
    const context = { detail: detail(), articles: [article("a"), article("b")] };
    const changed = { ...context, detail: detail({ summary: { oneLiner: "新摘要", confirmed: [], statements: [], unverified: [], disputed: [], whyItMatters: null } }) };
    expect(buildWorkflowInputHash(changed)).toBe(buildWorkflowInputHash(context));
  });

  it("新文章会改变证据输入指纹", () => {
    const base = { detail: detail(), articles: [article("a"), article("b")] };
    expect(buildWorkflowInputHash({ ...base, articles: [...base.articles, article("c")] })).not.toBe(buildWorkflowInputHash(base));
  });

  it("输入顺序不影响指纹且中书提案复用同一指纹前缀", () => {
    const base = { detail: detail(), articles: [article("a"), article("b")] };
    const reversed = { ...base, articles: [...base.articles].reverse() };
    const draft = draftByZhongshu({ ...base, now: "2026-07-31T02:00:00.000Z" });

    expect(buildWorkflowInputHash(reversed)).toBe(buildWorkflowInputHash(base));
    expect(draft.proposal.evidenceFingerprint).toBe(draft.inputHash.slice(0, 16));
  });

  it("高优先级单一来源事件会被门下封驳", () => {
    const event = detail({
      topics: ["conflict"],
      coverage: { present: [], gaps: ["通讯社"], byCategory: {}, independentFamilies: 1 },
    });
    const articles = [article("a")];
    const draft = draftByZhongshu({ detail: event, articles, now: "2026-07-31T02:00:00.000Z" });
    const review = reviewByMenxia({ detail: event, articles, now: "2026-07-31T02:00:00.000Z" }, draft.proposal);
    expect(review.decision).toBe("remand");
    expect(review.gaps.some((gap) => gap.code === "LOW_SOURCE_INDEPENDENCE")).toBe(true);
  });

  it("拒绝非法状态迁移", () => {
    expect(() => assertWorkflowTransition("pending", "completed")).toThrow("非法工作流迁移");
  });
});
