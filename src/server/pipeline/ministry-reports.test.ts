import { describe, expect, it } from "vitest";
import type { Citation, ClaimDTO, EventDetailDTO, MinistryAssignmentDTO } from "../../shared/types";
import type { ArticleWithSource } from "../services/article-store";
import { analyzeMinistry, consolidateMinistryReports, executeMinistryReports } from "./ministry-reports";

const citation: Citation = {
  articleId: "art_economy",
  title: "统计机构发布季度数据",
  url: "https://example.com/economy",
  sourceId: "src_data",
  sourceName: "测试统计机构",
  sourceCategory: "data",
  lang: "zh",
  publishedAt: "2026-07-31T01:00:00.000Z",
};

function claim(id: string, text: string, withCitation: boolean): ClaimDTO {
  return {
    id,
    eventId: "evt_reports",
    text,
    type: "number",
    claimedBy: "测试统计机构",
    party: null,
    subjectNumber: 3.2,
    numberUnit: "%",
    asOf: withCitation ? "2026-Q2" : null,
    occurredAt: null,
    publishedAt: citation.publishedAt,
    firstSeenAt: citation.publishedAt!,
    status: withCitation ? "corroborated" : "unverified",
    rationale: null,
    lastCheckedAt: null,
    evidence: withCitation
      ? [{ articleId: citation.articleId, stance: "supports", familyKey: "family-data", hasPrimary: true, note: null, citation }]
      : [],
  };
}

function article(overrides: Partial<ArticleWithSource> = {}): ArticleWithSource {
  return {
    id: citation.articleId,
    sourceId: citation.sourceId,
    url: citation.url,
    canonicalUrl: null,
    normalizedUrl: citation.url,
    guid: null,
    title: citation.title,
    titleNorm: citation.title,
    author: null,
    lang: "zh",
    publishedAt: citation.publishedAt,
    srcUpdatedAt: null,
    firstSeenAt: citation.publishedAt!,
    lastCrawledAt: null,
    bodyText: null,
    excerpt: null,
    imageUrl: null,
    contentHash: "hash-economy",
    simhash: null,
    isReprint: false,
    reprintOf: null,
    wireFamily: null,
    paywalled: false,
    eventId: "evt_reports",
    status: "analyzed",
    extra: null,
    sourceName: citation.sourceName,
    sourceCategory: "data",
    sourceFamilyId: "family-data",
    sourceIsParty: false,
    sourcePartyOf: null,
    sourceIsPrimary: true,
    sourceVerifStatus: "verified",
    sourceHealth: "ok",
    ...overrides,
  };
}

function detail(): EventDetailDTO {
  const claims = [claim("clm_cited", "季度经济指标同比增长 3.2%", true), claim("clm_uncited", "另一项经济数字为 3.2%", false)];
  return {
    id: "evt_reports",
    title: "经济数据测试事件",
    oneLiner: null,
    status: "active",
    trackMode: "normal",
    importance: 55,
    heat: 20,
    heatTrend: "flat",
    firstAt: citation.publishedAt!,
    lastUpdateAt: citation.publishedAt!,
    countries: ["cn"],
    topics: ["economy"],
    articleCount: 1,
    independentSourceCount: 1,
    confirmedCount: 1,
    unverifiedCount: 1,
    disputedCount: 0,
    coverageGapCount: 0,
    version: 1,
    lastVerifiedAt: citation.publishedAt,
    summary: null,
    claims,
    timeline: [],
    coverage: { present: ["公开数据"], gaps: [], byCategory: { data: 1 }, independentFamilies: 2 },
    delta: null,
    citations: [citation],
    featuredReport: null,
    summaryEngine: "extractive",
    sourceTrail: [citation],
  };
}

describe("六部专责报告", () => {
  it("为六部都建立终态产物，仅被分派部门执行专责分析", async () => {
    const assignments: MinistryAssignmentDTO[] = [
      { ministry: "economy", score: 7, primary: true, reasons: ["经济主题"] },
      { ministry: "source_identity", score: 2, primary: false, reasons: ["来源复核"] },
    ];
    const reports = await executeMinistryReports({ detail: detail(), articles: [article()] }, assignments);

    expect(reports).toHaveLength(6);
    expect(reports.find((report) => report.ministry === "economy")?.status).toBe("completed");
    expect(reports.find((report) => report.ministry === "source_identity")?.status).toBe("completed");
    expect(reports.filter((report) => report.status === "blocked")).toHaveLength(4);
  });

  it("不把无引用主张写入发现，并明确列为证据缺口", () => {
    const report = analyzeMinistry("economy", { detail: detail(), articles: [article()] });

    expect(report.findings.join(" ")).toContain("季度经济指标同比增长 3.2%");
    expect(report.findings.join(" ")).not.toContain("另一项经济数字");
    expect(report.citations).toEqual([citation]);
    expect(report.evidenceGaps.join(" ")).toContain("没有可展示的文章级引用");
  });

  it("尚书汇总只压缩六部已有发现和引用", async () => {
    const reports = await executeMinistryReports(
      { detail: detail(), articles: [article()] },
      [{ ministry: "economy", score: 7, primary: true, reasons: ["经济主题"] }]
    );
    const digest = consolidateMinistryReports(reports);

    expect(digest.completedMinistries).toEqual(["economy"]);
    expect(digest.blockedMinistries).toHaveLength(5);
    expect(digest.citationCount).toBe(1);
    expect(digest.findings.join(" ")).toContain("季度经济指标同比增长 3.2%");
  });

  it("吏部识别高转载占比与待核验来源", () => {
    const context = {
      detail: detail(),
      articles: [
        article({ id: "art_1", isReprint: true, sourceVerifStatus: "pending" }),
        article({ id: "art_2", isReprint: true, sourceVerifStatus: "pending", normalizedUrl: "https://example.com/2", url: "https://example.com/2" }),
      ],
    };
    const report = analyzeMinistry("source_identity", context);

    expect(report.risks.join(" ")).toContain("来源身份");
    expect(report.risks.join(" ")).toContain("转载材料占 100%");
  });
});
