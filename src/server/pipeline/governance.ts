import type {
  ClaimStatus,
  EvidenceGapDTO,
  EventDetailDTO,
  MenxiaReviewDTO,
  MinistryAssignmentDTO,
  ShangshuDispatchDTO,
  WorkflowState,
  ZhongshuProposalDTO,
} from "../../shared/types";
import { sha256Hex } from "../lib/hash";
import { nowIso } from "../lib/time";
import type { ArticleWithSource } from "../services/article-store";
import { assignMinistries, THREE_DEPARTMENTS_RULES_VERSION } from "./ministries";
import { calculateEventPriority } from "./priority";

export interface GovernanceContext {
  detail: EventDetailDTO;
  articles: ArticleWithSource[];
  now?: string;
}

export interface GovernanceDraft {
  inputHash: string;
  proposal: ZhongshuProposalDTO;
  assignments: MinistryAssignmentDTO[];
}

const CLAIM_STATUSES: ClaimStatus[] = [
  "reported",
  "unverified",
  "partially_corroborated",
  "corroborated",
  "disputed",
  "refuted",
  "outdated",
];

const ALLOWED_TRANSITIONS: Record<WorkflowState, WorkflowState[]> = {
  pending: ["proposed", "failed"],
  proposed: ["remanded", "approved", "failed"],
  remanded: ["proposed", "failed"],
  approved: ["dispatched", "failed"],
  dispatched: ["completed", "failed"],
  completed: ["proposed", "failed"],
  failed: ["proposed"],
};

export function buildWorkflowInputHash(context: GovernanceContext): string {
  const payload = {
    rulesVersion: THREE_DEPARTMENTS_RULES_VERSION,
    event: {
      id: context.detail.id,
      title: context.detail.title,
      topics: [...context.detail.topics].sort(),
      countries: [...context.detail.countries].sort(),
    },
    articles: context.articles
      .map((article) => ({
        id: article.id,
        contentHash: article.contentHash,
        sourceId: article.sourceId,
        sourceCategory: article.sourceCategory,
        sourceFamilyId: article.sourceFamilyId,
        sourceIsParty: article.sourceIsParty,
        sourcePartyOf: article.sourcePartyOf,
        sourceIsPrimary: article.sourceIsPrimary,
        sourceVerifStatus: article.sourceVerifStatus,
        sourceHealth: article.sourceHealth,
        isReprint: article.isReprint,
        reprintOf: article.reprintOf,
        wireFamily: article.wireFamily,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    claims: context.detail.claims
      .map((claim) => ({
        id: claim.id,
        text: claim.text,
        status: claim.status,
        party: claim.party,
        subjectNumber: claim.subjectNumber,
        numberUnit: claim.numberUnit,
        evidence: claim.evidence
          .map((evidence) => ({
            articleId: evidence.articleId,
            stance: evidence.stance,
            familyKey: evidence.familyKey,
            hasPrimary: evidence.hasPrimary,
          }))
          .sort((a, b) => a.articleId.localeCompare(b.articleId)),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
  return sha256Hex(stableStringify(payload));
}

export function draftByZhongshu(context: GovernanceContext): GovernanceDraft {
  const at = context.now || nowIso();
  const claimCounts = Object.fromEntries(CLAIM_STATUSES.map((status) => [status, 0])) as Record<ClaimStatus, number>;
  for (const claim of context.detail.claims) claimCounts[claim.status] += 1;
  const originalArticles = context.articles.filter((article) => !article.isReprint).length;
  const reprints = context.articles.length - originalArticles;
  const priority = calculateEventPriority(context.detail, context.articles, context.detail.coverage.independentFamilies, Date.parse(at));
  const assignments = assignMinistries({
    topics: context.detail.topics,
    claimStatuses: context.detail.claims.map((claim) => claim.status),
    articles: context.articles.map((article) => ({
      sourceVerifStatus: article.sourceVerifStatus,
      sourceHealth: article.sourceHealth,
      sourceCategory: article.sourceCategory,
      isReprint: article.isReprint,
    })),
    independentFamilies: context.detail.coverage.independentFamilies,
  });
  const rationale = [
    `汇集 ${context.articles.length} 篇材料，识别 ${context.detail.claims.length} 项可核验主张`,
    `独立来源家族 ${context.detail.coverage.independentFamilies} 个，覆盖缺口 ${context.detail.coverage.gaps.length} 项`,
    assignments.length
      ? `主送${assignments.find((item) => item.primary)?.ministry || assignments[0].ministry}，另有 ${Math.max(0, assignments.length - 1)} 个会同部门`
      : "尚无足够主题信号，暂由尚书省待分流",
  ];
  const inputHash = buildWorkflowInputHash(context);

  return {
    inputHash,
    proposal: {
      draftedAt: at,
      evidenceFingerprint: inputHash.slice(0, 16),
      importance: priority.importance,
      heat: priority.heat,
      trackMode: priority.trackMode,
      claimCounts,
      independentFamilies: context.detail.coverage.independentFamilies,
      originalArticles,
      reprints,
      coverageGaps: [...context.detail.coverage.gaps],
      actions: ["execute_ministry_reports", "consolidate_ministry_findings", "refresh_summary", "evaluate_alerts", "consider_briefing", "consider_active_search"],
      rationale,
    },
    assignments,
  };
}

export function reviewByMenxia(context: GovernanceContext, proposal: ZhongshuProposalDTO): MenxiaReviewDTO {
  const gaps: EvidenceGapDTO[] = [];
  const warnings: EvidenceGapDTO[] = [];
  const highPriority = proposal.importance >= 70 || proposal.trackMode === "breaking";
  const unverified = context.articles.filter((article) => article.sourceVerifStatus !== "verified").length;
  const add = (target: EvidenceGapDTO[], code: string, message: string, suggestedAction: string, severity: EvidenceGapDTO["severity"]) =>
    target.push({ code, message, suggestedAction, severity });

  if (context.articles.length === 0) {
    add(gaps, "NO_ORIGINAL_ARTICLE", "事件没有可供复核的原始材料。", "重新运行采集并确认原始链接。", "blocker");
  } else if (proposal.originalArticles === 0) {
    add(gaps, "ALL_ARTICLES_REPRINTS", "当前材料全部被识别为转载，无法形成独立证据链。", "查找首发稿、官方原文或本地来源。", "blocker");
  }

  if (proposal.independentFamilies < 2) {
    add(
      highPriority ? gaps : warnings,
      "LOW_SOURCE_INDEPENDENCE",
      `当前只有 ${proposal.independentFamilies} 个独立来源家族。`,
      "补充不共享同一稿源或所有权链的来源。",
      highPriority ? "blocker" : "warning"
    );
  }

  if (context.articles.length > 0 && unverified === context.articles.length) {
    add(
      highPriority ? gaps : warnings,
      "SOURCE_IDENTITY_UNVERIFIED",
      "所有材料的来源身份都尚未完成验证。",
      "从机构官网反向确认域名、账号或频道身份。",
      highPriority ? "blocker" : "warning"
    );
  } else if (unverified > 0) {
    add(warnings, "SOURCE_IDENTITY_PARTIAL", `${unverified} 个来源身份仍待核实。`, "优先复核主送证据的来源身份。", "warning");
  }

  if (context.detail.claims.length === 0) {
    add(
      highPriority ? gaps : warnings,
      "NO_ACTIONABLE_CLAIMS",
      "尚未抽取出可单独核验的具体主张。",
      "补充正文或重新运行 Claim 抽取。",
      highPriority ? "blocker" : "warning"
    );
  }

  const refutedClaims = context.detail.claims.filter((claim) => claim.status === "refuted");
  const disputedClaims = context.detail.claims.filter((claim) => claim.status === "disputed");
  if (refutedClaims.length > 0) {
    add(
      gaps,
      "REFUTED_CLAIM_REQUIRES_REDRAFT",
      `${refutedClaims.length} 项主张已有较强反证，不能按当前奏议直接成报。`,
      "中书省应删除、降格或明确改写相关主张，并保留反证引用。",
      "blocker"
    );
  }
  if (disputedClaims.length > 0) {
    add(
      highPriority ? gaps : warnings,
      "DISPUTED_CLAIM_REQUIRES_BALANCE",
      `${disputedClaims.length} 项主张存在实质争议。`,
      "补齐相反立场与独立证据，并在成报中明确并列争议。",
      highPriority ? "blocker" : "warning"
    );
  }

  for (const gap of proposal.coverageGaps.slice(0, 8)) {
    add(warnings, "REQUIRED_SOURCE_CATEGORY_MISSING", `来源覆盖缺口：${gap}。`, "主动搜索相应类别或相关方的一手材料。", "warning");
  }

  const decision = gaps.length === 0 ? "approve" : "remand";
  return {
    reviewedAt: context.now || nowIso(),
    decision,
    gaps,
    warnings,
    rationale: decision === "approve"
      ? ["未发现阻断发布的证据缺陷。", warnings.length ? `带 ${warnings.length} 项风险提示准奏。` : "证据结构满足当前发布门槛。"]
      : [`发现 ${gaps.length} 项阻断缺口，退回中书省补证。`, "封驳表示证据不足，不代表事件为假。"],
  };
}

export function createShangshuDispatch(at = nowIso()): ShangshuDispatchDTO {
  return {
    dispatchedAt: at,
    completedAt: null,
    actions: { ministries: "pending", summary: "pending", alerts: "pending" },
    ministryDigest: null,
    summaryEngine: null,
    errors: [],
  };
}

export function assertWorkflowTransition(from: WorkflowState, to: WorkflowState): void {
  if (!ALLOWED_TRANSITIONS[from].includes(to)) throw new Error(`非法工作流迁移：${from} -> ${to}`);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
