import { CLAIM_STATUS_LABELS } from "../../shared/constants";
import type {
  Citation,
  ClaimDTO,
  MinistryAssignmentDTO,
  MinistryCode,
  MinistryReportStatus,
  ShangshuMinistryDigestDTO,
  SourceCategory,
} from "../../shared/types";
import type { ArticleWithSource } from "../services/article-store";
import type { GovernanceContext } from "./governance";
import { ministryCodes } from "./ministries";

export interface MinistryReportArtifact {
  ministry: MinistryCode;
  status: Extract<MinistryReportStatus, "completed" | "blocked">;
  findings: string[];
  risks: string[];
  evidenceGaps: string[];
  actions: string[];
  citations: Citation[];
  claimRefs: string[];
}

const TOPIC_SCOPE: Record<MinistryCode, Set<string>> = {
  source_identity: new Set(),
  economy: new Set(["economy", "finance", "energy", "sanctions"]),
  diplomacy_society: new Set(["diplomacy", "intl_politics", "intl_org", "election", "society", "health", "education"]),
  conflict_security: new Set(["conflict", "defense", "security", "sanctions"]),
  law_factcheck: new Set(["policy", "domestic_politics", "election", "security", "investigation"]),
  technology_infrastructure_disaster: new Set(["tech", "ai", "energy", "health", "climate", "disaster"]),
};

const TEXT_SCOPE: Record<Exclude<MinistryCode, "source_identity">, readonly string[]> = {
  economy: ["经济", "财政", "金融", "贸易", "关税", "制裁", "能源", "油价", "利率", "通胀", "就业", "gdp"],
  diplomacy_society: ["外交", "会谈", "峰会", "联合国", "声明", "选举", "社会", "教育", "医疗", "卫生", "难民"],
  conflict_security: ["冲突", "战争", "军", "袭击", "伤亡", "死亡", "安全", "国防", "导弹", "无人机", "停火"],
  law_factcheck: ["法律", "法规", "政策", "调查", "法院", "起诉", "判决", "事实核查", "争议", "辟谣", "证据"],
  technology_infrastructure_disaster: ["科技", "人工智能", "ai", "芯片", "网络", "基础设施", "交通", "气候", "地震", "洪水", "灾害", "事故"],
};

const ACTIONS: Record<MinistryCode, string[]> = {
  source_identity: ["复核主送材料的官网、域名或账号归属。", "合并同一所有权、通讯社稿源或转载链，避免虚假多样性。", "对异常采集源安排再次抓取或人工查验。"],
  economy: ["逐项核对数字的口径、币种、统计期与基期。", "优先补充监管机构、统计机构或企业原始文件。", "区分已发生数据、预测与当事方表态。"],
  diplomacy_society: ["保留声明主体、原文语种和发布时间。", "补齐相关方、国际组织与事发地来源。", "对机器翻译和跨语种转述进行原文回查。"],
  conflict_security: ["把当事方说法与独立确认分栏呈现。", "伤亡、地点与时间数字逐条绑定原始引用。", "持续搜索现场、本地、国际组织及可验证技术材料。"],
  law_factcheck: ["将报道、争议、反证与裁判文书分别列示。", "追索法规、裁判、调查报告或事实核查原文。", "争议未消解前维持限定性表述。"],
  technology_infrastructure_disaster: ["核对技术指标、版本、测量方法和影响范围。", "优先补充机构公告、论文、监测或基础设施运营方数据。", "灾害与事故数据按更新时间保留版本差异。"],
};

/**
 * 六部并行处理入口。每一部都是确定性分析器；Promise.all 只负责隔离执行，
 * 不让任何单部拥有门下审批权或脱离现有证据生成事实。
 */
export async function executeMinistryReports(
  context: GovernanceContext,
  assignments: MinistryAssignmentDTO[]
): Promise<MinistryReportArtifact[]> {
  const assigned = new Set(assignments.map((assignment) => assignment.ministry));
  return Promise.all(
    ministryCodes().map((ministry) =>
      Promise.resolve().then(() =>
        assigned.has(ministry)
          ? analyzeMinistry(ministry, context)
          : {
              ministry,
              status: "blocked" as const,
              findings: [],
              risks: [],
              evidenceGaps: ["本轮主题与证据未触发本部专责范围，留档待命。"],
              actions: ["新增证据改变分派评分后，由中书省在下一修订重新交办。"],
              citations: [],
              claimRefs: [],
            }
      )
    )
  );
}

export function analyzeMinistry(ministry: MinistryCode, context: GovernanceContext): MinistryReportArtifact {
  if (ministry === "source_identity") return analyzeSourceIdentity(context);
  const claims = relevantClaims(ministry, context);
  const materials = findingsFromClaims(claims);
  if (materials.findings.length === 0) addArticleFallback(materials, context.articles);

  const risks = commonRisks(claims, context);
  const gaps = commonGaps(claims, context);
  addSpecializedRisks(ministry, claims, context, risks, gaps);

  return {
    ministry,
    status: "completed",
    findings: unique(materials.findings, 8),
    risks: unique(risks, 8),
    evidenceGaps: unique(gaps, 8),
    actions: ACTIONS[ministry],
    citations: dedupeCitations(materials.citations, 16),
    claimRefs: unique(claims.map((claim) => claim.id), 16),
  };
}

/** 尚书省只压缩六部已有产物，不补写新的事实判断。 */
export function consolidateMinistryReports(reports: MinistryReportArtifact[]): ShangshuMinistryDigestDTO {
  const completed = reports.filter((report) => report.status === "completed");
  const citations = dedupeCitations(completed.flatMap((report) => report.citations), 100);
  return {
    completedMinistries: completed.map((report) => report.ministry),
    blockedMinistries: reports.filter((report) => report.status === "blocked").map((report) => report.ministry),
    findings: unique(completed.flatMap((report) => report.findings), 12),
    risks: unique(completed.flatMap((report) => report.risks), 12),
    evidenceGaps: unique(completed.flatMap((report) => report.evidenceGaps), 12),
    citationCount: citations.length,
    claimRefs: unique(completed.flatMap((report) => report.claimRefs), 32),
  };
}

function analyzeSourceIdentity(context: GovernanceContext): MinistryReportArtifact {
  const articles = [...context.articles].sort(compareArticles);
  const citations = articles.map(articleCitation);
  const findings = articles.slice(0, 8).map((article) => {
    const identity = article.sourceVerifStatus === "verified" ? "身份已核验" : "身份待核验";
    const lineage = article.isReprint ? "转载材料" : "原始入库材料";
    return `「${clean(article.title)}」来自${clean(article.sourceName)}；${identity}，${lineage}，采集状态为 ${article.sourceHealth}。`;
  });
  const risks: string[] = [];
  const gaps: string[] = [];
  const unverified = articles.filter((article) => article.sourceVerifStatus !== "verified");
  const unhealthy = articles.filter((article) => article.sourceHealth === "degraded" || article.sourceHealth === "failing");
  const reprints = articles.filter((article) => article.isReprint);
  if (unverified.length) risks.push(`${unverified.length} 篇材料的来源身份尚未完全核验。`);
  if (unhealthy.length) risks.push(`${unhealthy.length} 篇材料对应采集源处于波动或失败状态。`);
  if (articles.length && reprints.length / articles.length >= 0.5) risks.push(`转载材料占 ${Math.round((reprints.length / articles.length) * 100)}%，可能造成来源数量虚高。`);
  if (context.detail.coverage.independentFamilies < 2) gaps.push("独立来源家族不足两个，不能把多篇同源转载视作交叉核验。");
  if (articles.length === 0) gaps.push("没有可供核验来源身份的原始材料。");
  for (const article of unverified.slice(0, 4)) gaps.push(`待确认来源：${clean(article.sourceName)}（材料「${clean(article.title)}」）。`);

  const claimRefs = unique(
    context.detail.claims
      .filter((claim) => claim.evidence.some((evidence) => citations.some((citation) => citation.articleId === evidence.articleId)))
      .map((claim) => claim.id),
    16
  );
  return {
    ministry: "source_identity",
    status: "completed",
    findings: unique(findings, 8),
    risks: unique(risks, 8),
    evidenceGaps: unique(gaps, 8),
    actions: ACTIONS.source_identity,
    citations: dedupeCitations(citations, 16),
    claimRefs,
  };
}

function relevantClaims(ministry: Exclude<MinistryCode, "source_identity">, context: GovernanceContext): ClaimDTO[] {
  const topicMatch = context.detail.topics.some((topic) => TOPIC_SCOPE[ministry].has(topic));
  const keywords = TEXT_SCOPE[ministry];
  return context.detail.claims.filter((claim) => {
    if (ministry === "law_factcheck" && ["disputed", "refuted"].includes(claim.status)) return true;
    if (topicMatch) return true;
    const haystack = `${claim.text} ${claim.claimedBy || ""} ${claim.party || ""}`.toLowerCase();
    return keywords.some((keyword) => haystack.includes(keyword));
  });
}

function findingsFromClaims(claims: ClaimDTO[]): { findings: string[]; citations: Citation[] } {
  const findings: string[] = [];
  const citations: Citation[] = [];
  for (const claim of claims) {
    const claimCitations = claim.evidence.map((evidence) => evidence.citation).filter((item): item is Citation => Boolean(item));
    if (claimCitations.length === 0) continue;
    const attribution = claim.claimedBy ? `（归属：${clean(claim.claimedBy)}）` : "";
    findings.push(`主张「${clean(claim.text)}」${attribution}；当前证据状态：${CLAIM_STATUS_LABELS[claim.status]}。`);
    citations.push(...claimCitations);
  }
  return { findings, citations };
}

function addArticleFallback(
  materials: { findings: string[]; citations: Citation[] },
  articles: ArticleWithSource[]
): void {
  for (const article of [...articles].sort(compareArticles).slice(0, 4)) {
    materials.findings.push(`待抽取具体主张的材料：「${clean(article.title)}」（${clean(article.sourceName)}）。`);
    materials.citations.push(articleCitation(article));
  }
}

function commonRisks(claims: ClaimDTO[], context: GovernanceContext): string[] {
  const risks: string[] = [];
  const uncertain = claims.filter((claim) => ["reported", "unverified", "partially_corroborated"].includes(claim.status));
  const contested = claims.filter((claim) => claim.status === "disputed" || claim.status === "refuted");
  if (uncertain.length) risks.push(`${uncertain.length} 项本部相关主张仍未完成交叉确认。`);
  if (contested.length) risks.push(`${contested.length} 项本部相关主张存在争议或反证。`);
  if (context.articles.some((article) => article.sourceIsParty)) risks.push("材料包含当事方来源，其声明不能自动视作独立确认。");
  return risks;
}

function commonGaps(claims: ClaimDTO[], context: GovernanceContext): string[] {
  const gaps: string[] = [];
  const uncited = claims.filter((claim) => !claim.evidence.some((evidence) => evidence.citation));
  if (uncited.length) gaps.push(`${uncited.length} 项相关主张没有可展示的文章级引用。`);
  if (context.detail.coverage.independentFamilies < 2) gaps.push("独立来源家族不足两个，需补充不共享稿源或所有权链的证据。");
  for (const gap of context.detail.coverage.gaps.slice(0, 3)) gaps.push(`来源覆盖缺口：${clean(gap)}。`);
  return gaps;
}

function addSpecializedRisks(
  ministry: Exclude<MinistryCode, "source_identity">,
  claims: ClaimDTO[],
  context: GovernanceContext,
  risks: string[],
  gaps: string[]
): void {
  switch (ministry) {
    case "economy": {
      const undatedNumbers = claims.filter((claim) => claim.subjectNumber !== null && !claim.asOf);
      if (undatedNumbers.length) risks.push(`${undatedNumbers.length} 项数字主张缺少明确统计时点或口径日期。`);
      if (!context.articles.some((article) => article.sourceCategory === "data" || article.sourceIsPrimary)) {
        gaps.push("尚无公开数据源或第一手文件支撑本部相关判断。");
      }
      break;
    }
    case "diplomacy_society": {
      if (claims.some((claim) => !claim.claimedBy && (claim.type === "statement" || claim.type === "intent"))) {
        gaps.push("部分声明或意图类主张没有明确发言主体。");
      }
      if (context.articles.some((article) => article.lang && !/^zh/i.test(article.lang))) {
        risks.push("包含非中文材料，跨语种转述需要回查原文。");
      }
      break;
    }
    case "conflict_security": {
      const sensitiveNumbers = claims.filter(
        (claim) => (claim.type === "casualty" || claim.type === "number") && claim.status !== "corroborated"
      );
      if (sensitiveNumbers.length) risks.push(`${sensitiveNumbers.length} 项伤亡或数量主张尚未交叉确认。`);
      if (!context.articles.some((article) => article.sourceCategory === "local_media" || article.sourceCategory === "intl_org")) {
        gaps.push("尚缺事发地本地来源或国际组织材料。");
      }
      break;
    }
    case "law_factcheck": {
      if (!context.articles.some((article) => article.sourceCategory === "factcheck" || article.sourceIsPrimary)) {
        gaps.push("尚缺事实核查机构或法规、裁判、调查等第一手文件。");
      }
      break;
    }
    case "technology_infrastructure_disaster": {
      if (!context.articles.some((article) => article.sourceCategory === "data" || article.sourceIsPrimary)) {
        gaps.push("尚缺监测数据、技术文件或运营机构第一手公告。");
      }
      if (context.detail.topics.some((topic) => topic === "disaster" || topic === "climate")) {
        risks.push("灾害与气候数据会随时间更新，后续版本不得覆盖早期口径。");
      }
      break;
    }
  }
}

function articleCitation(article: ArticleWithSource): Citation {
  return {
    articleId: article.id,
    title: article.title,
    url: article.url,
    sourceId: article.sourceId,
    sourceName: article.sourceName,
    sourceCategory: article.sourceCategory as SourceCategory,
    lang: article.lang,
    publishedAt: article.publishedAt,
    isParty: article.sourceIsParty,
    partyOf: article.sourcePartyOf,
  };
}

function dedupeCitations(citations: Citation[], limit: number): Citation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    if (seen.has(citation.articleId)) return false;
    seen.add(citation.articleId);
    return true;
  }).slice(0, limit);
}

function unique(values: string[], limit: number): string[] {
  return [...new Set(values.map(clean).filter(Boolean))].slice(0, limit);
}

function clean(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function compareArticles(a: ArticleWithSource, b: ArticleWithSource): number {
  return (a.publishedAt || a.firstSeenAt).localeCompare(b.publishedAt || b.firstSeenAt) || a.id.localeCompare(b.id);
}
