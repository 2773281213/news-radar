// ============================================================
// 新闻雷达 · 前后端共享类型契约
// 所有时间字段一律为 UTC ISO8601 字符串，展示时按用户时区格式化
// ============================================================

/** 来源类别 */
export type SourceCategory =
  | "gov_cn" // 中国官方（政府/部委/人大/两高等）
  | "official_media_cn" // 中国官方媒体（新华社/央视/人民日报系）
  | "market_media_cn" // 中国市场化/民间媒体
  | "social_cn" // 中国社交平台账号
  | "gov_intl" // 外国政府与公共机构
  | "intl_org" // 国际组织（联合国/红十字等）
  | "wire" // 通讯社
  | "intl_media" // 国际媒体
  | "local_media" // 事发地本地媒体
  | "party_media" // 冲突当事方媒体/喉舌
  | "social" // 国际社交平台账号
  | "data" // 公开数据/技术数据源
  | "factcheck"; // 事实核查机构

/** 来源身份验证状态 */
export type VerifStatus = "verified" | "pending" | "unverified";

/** 来源健康状态 */
export type SourceHealth = "ok" | "degraded" | "failing" | "disabled" | "unknown";

/** 采集适配器类型 */
export type AdapterKind =
  | "rss"
  | "jsonfeed"
  | "gdelt"
  | "mastodon"
  | "bluesky"
  | "telegramweb";

/** Claim 证据状态机 */
export type ClaimStatus =
  | "reported" // 某来源进行了报道/声明
  | "unverified" // 尚无法独立确认
  | "partially_corroborated" // 部分内容得到佐证
  | "corroborated" // 多个独立证据链支持
  | "disputed" // 来源间存在明显冲突
  | "refuted" // 有较强证据显示不成立
  | "outdated"; // 已被后续信息替代

/** Claim 类型 */
export type ClaimType = "event" | "statement" | "casualty" | "number" | "intent";

/** 证据立场 */
export type EvidenceStance = "supports" | "reports" | "disputes" | "refutes" | "context";

/** 事件跟踪模式 */
export type TrackMode = "breaking" | "active" | "normal" | "slow";

/** 事件状态 */
export type EventStatus = "developing" | "active" | "dormant" | "closed";

// ---------------- 来源 ----------------

export interface SourceDTO {
  id: string;
  name: string;
  homepage: string | null;
  feedUrl: string | null;
  adapter: AdapterKind;
  config: Record<string, string> | null;
  country: string | null;
  lang: string | null;
  category: SourceCategory;
  owner: string | null;
  ownershipNote: string | null;
  isParty: boolean;
  partyOf: string | null;
  isPrimary: boolean;
  paywalled: boolean;
  intervalMin: number;
  verifStatus: VerifStatus;
  verifBasis: string | null;
  lastReviewedAt: string | null;
  familyId: string | null;
  enabled: boolean;
  lastFetchAt: string | null;
  lastSuccessAt: string | null;
  consecFails: number;
  health: SourceHealth;
  addedBy: string;
  notes: string | null;
}

export interface SourceHealthSummary {
  total: number;
  ok: number;
  degraded: number;
  failing: number;
  disabled: number;
  unknown: number;
  byCategory: Record<string, number>;
}

// ---------------- 文章 ----------------

export interface ArticleDTO {
  id: string;
  sourceId: string;
  sourceName?: string;
  sourceCategory?: SourceCategory;
  url: string;
  title: string;
  lang: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  excerpt: string | null;
  isReprint: boolean;
  wireFamily: string | null;
  paywalled: boolean;
  eventId: string | null;
}

// ---------------- 引用 ----------------

export interface Citation {
  articleId: string;
  title: string;
  url: string;
  sourceId: string;
  sourceName: string;
  sourceCategory: SourceCategory;
  lang: string | null;
  publishedAt: string | null;
  isParty?: boolean;
  partyOf?: string | null;
}

// ---------------- Claim ----------------

export interface ClaimRationale {
  /** 影响判断的因素列表（人可读，中文） */
  factors: string[];
  /** 独立证据链数量 */
  independentChains: number;
  /** 是否有第一手材料 */
  hasPrimary: boolean;
  /** 是否有明确反证 */
  hasRefutation: boolean;
}

export interface ClaimDTO {
  id: string;
  eventId: string;
  text: string;
  type: ClaimType;
  claimedBy: string | null;
  party: string | null;
  subjectNumber: number | null;
  numberUnit: string | null;
  asOf: string | null;
  occurredAt: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  status: ClaimStatus;
  rationale: ClaimRationale | null;
  lastCheckedAt: string | null;
  evidence: EvidenceDTO[];
}

export interface EvidenceDTO {
  articleId: string;
  stance: EvidenceStance;
  familyKey: string | null;
  hasPrimary: boolean;
  note: string | null;
  citation: Citation | null;
}

// ---------------- 事件 ----------------

export interface CoverageDTO {
  /** 已覆盖的来源桶（人可读中文标签） */
  present: string[];
  /** 缺口（人可读中文标签） */
  gaps: string[];
  /** 各类别文章计数 */
  byCategory: Record<string, number>;
  /** 独立来源家族数量 */
  independentFamilies: number;
}

export interface TimelineItem {
  at: string;
  kind: "occurrence" | "statement" | "report" | "revision";
  text: string;
  citation?: Citation | null;
}

export interface DisputeGroup {
  topic: string;
  positions: {
    party: string;
    text: string;
    number?: number | null;
    asOf?: string | null;
    citation?: Citation | null;
  }[];
}

export interface StatementGroup {
  party: string;
  partyLabel: string;
  items: { text: string; status: ClaimStatus; claimId: string; citations: Citation[] }[];
}

export interface EventSummaryDTO {
  oneLiner: string;
  confirmed: { text: string; claimId: string; citations: Citation[] }[];
  statements: StatementGroup[];
  unverified: { text: string; claimId: string; citations: Citation[] }[];
  disputed: DisputeGroup[];
  whyItMatters: { text: string; generatedBy: "rule" | "ai" } | null;
}

export interface EventVersionDelta {
  sinceVersion: number;
  added: string[];
  changed: string[];
  removed: string[];
}

export interface EventListItem {
  id: string;
  title: string;
  oneLiner: string | null;
  status: EventStatus;
  trackMode: TrackMode;
  importance: number;
  heat: number;
  heatTrend: "up" | "flat" | "down";
  firstAt: string;
  lastUpdateAt: string;
  countries: string[];
  topics: string[];
  articleCount: number;
  /** 去除转载与同源稿后的独立证据链数量 */
  independentSourceCount: number;
  confirmedCount: number;
  /** reported / unverified / partially_corroborated 主张数量 */
  unverifiedCount: number;
  disputedCount: number;
  coverageGapCount: number;
  /** 列表呈递使用的代表性原始链接，每个独立来源家族最多一条 */
  sourceTrail: Citation[];
}

export interface EventDetailDTO extends EventListItem {
  version: number;
  lastVerifiedAt: string | null;
  summary: EventSummaryDTO | null;
  claims: ClaimDTO[];
  timeline: TimelineItem[];
  coverage: CoverageDTO;
  delta: EventVersionDelta | null;
  citations: Citation[];
  /** 摘要生成方式：ai 或抽取式 */
  summaryEngine: "ai" | "extractive";
}

// ---------------- 三省六部工作流 ----------------

export type DepartmentCode = "zhongshu" | "menxia" | "shangshu";

export type MinistryCode =
  | "source_identity"
  | "economy"
  | "diplomacy_society"
  | "conflict_security"
  | "law_factcheck"
  | "technology_infrastructure_disaster";

export type WorkflowState =
  | "pending"
  | "proposed"
  | "remanded"
  | "approved"
  | "dispatched"
  | "completed"
  | "failed";

export type WorkflowRunStatus = "running" | "remanded" | "completed" | "failed";

export interface MinistryAssignmentDTO {
  ministry: MinistryCode;
  score: number;
  primary: boolean;
  reasons: string[];
}

export type MinistryReportStatus = "pending" | "running" | "completed" | "failed" | "blocked";

/**
 * 六部对单次工作流运行产出的结构化专责报告。
 * findings 只能转述既有 Claim 或原始材料标题，引用保留到文章级，
 * 不允许在六部阶段凭空补写事实。
 */
export interface MinistryWorkReportDTO {
  id: number;
  runId: string;
  eventId: string;
  ministry: MinistryCode;
  attempt: number;
  status: MinistryReportStatus;
  assignment: MinistryAssignmentDTO | null;
  findings: string[];
  risks: string[];
  evidenceGaps: string[];
  actions: string[];
  citations: Citation[];
  claimRefs: string[];
  rulesVersion: string;
  startedAt: string | null;
  completedAt: string | null;
  errorCode: string | null;
  errorDetail: string | null;
}

export interface MinistryReportProgressDTO {
  total: number;
  pending: number;
  running: number;
  completed: number;
  blocked: number;
  failed: number;
}

export interface EvidenceGapDTO {
  code: string;
  severity: "blocker" | "warning";
  message: string;
  suggestedAction: string;
}

export interface ZhongshuProposalDTO {
  draftedAt: string;
  evidenceFingerprint: string;
  importance: number;
  heat: number;
  trackMode: TrackMode;
  claimCounts: Record<ClaimStatus, number>;
  independentFamilies: number;
  originalArticles: number;
  reprints: number;
  coverageGaps: string[];
  actions: string[];
  rationale: string[];
}

export interface MenxiaReviewDTO {
  reviewedAt: string;
  decision: "approve" | "remand";
  gaps: EvidenceGapDTO[];
  warnings: EvidenceGapDTO[];
  rationale: string[];
}

export interface ShangshuMinistryDigestDTO {
  completedMinistries: MinistryCode[];
  blockedMinistries: MinistryCode[];
  findings: string[];
  risks: string[];
  evidenceGaps: string[];
  citationCount: number;
  claimRefs: string[];
}

export interface ShangshuDispatchDTO {
  dispatchedAt: string;
  completedAt: string | null;
  actions: {
    ministries: "pending" | "completed" | "failed";
    summary: "pending" | "completed" | "failed";
    alerts: "pending" | "completed" | "failed";
  };
  ministryDigest: ShangshuMinistryDigestDTO | null;
  summaryEngine: "ai" | "extractive" | null;
  errors: string[];
}

export interface WorkflowSummaryDTO {
  eventId: string;
  status: WorkflowState;
  currentDepartment: DepartmentCode;
  revision: number;
  rulesVersion: string;
  inputHash: string;
  publishable: boolean;
  assignments: MinistryAssignmentDTO[];
  ministryReportProgress: MinistryReportProgressDTO;
  reviewDecision: MenxiaReviewDTO["decision"] | null;
  updatedAt: string;
  completedAt: string | null;
}

export interface WorkflowTransitionDTO {
  id: number;
  runId: string;
  sequence: number;
  fromState: WorkflowState | null;
  toState: WorkflowState;
  department: DepartmentCode;
  action: string;
  reasonCode: string;
  rationale: string[];
  createdAt: string;
}

export interface EventWorkflowDTO {
  workflow: WorkflowSummaryDTO;
  proposal: ZhongshuProposalDTO | null;
  review: MenxiaReviewDTO | null;
  dispatch: ShangshuDispatchDTO | null;
  ministryReports: MinistryWorkReportDTO[];
  transitions: WorkflowTransitionDTO[];
  nextBefore: number | null;
}

/**
 * 面向实时事件与简报的只读审议快照。
 * 它与完整审计记录来自同一 workflow_cases 投影，但省略迁移日志和逐部报告正文。
 */
export interface GovernanceSnapshotDTO {
  workflow: WorkflowSummaryDTO;
  proposal: ZhongshuProposalDTO | null;
  review: MenxiaReviewDTO | null;
  dispatch: ShangshuDispatchDTO | null;
}

export interface RoutedEventItem extends EventListItem {
  routing: {
    primary: MinistryCode | null;
    collaborators: MinistryCode[];
    reasons: string[];
  };
  workflowStatus: WorkflowState | null;
  publishable: boolean;
  governance: GovernanceSnapshotDTO | null;
}

export interface WorkflowDashboardDTO {
  cutoff: string;
  rulesVersion: string;
  stages: {
    zhongshu: { articles24h: number; events24h: number; pending: number };
    menxia: { awaitingReview: number; remanded: number; disputedClaims: number };
    shangshu: { approved: number; completed24h: number; failed: number };
  };
  ministries: Array<{
    ministry: MinistryCode;
    activeEvents: number;
    updates24h: number;
    remanded: number;
    disputedClaims: number;
  }>;
  recentDispatches: RoutedEventItem[];
}

// ---------------- 简报 ----------------

export type BriefingType =
  | "morning"
  | "noon"
  | "evening"
  | "breaking"
  | "hourly"
  | "topic"
  | "watchlist";

export interface BriefingItem {
  eventId: string;
  title: string;
  oneLiner: string;
  statusLine: string; // 例如 “3 项已确认 · 2 项待核实 · 1 项争议”
  citations: Citation[];
  independentSourceCount: number;
  unverifiedCount: number;
  governance: GovernanceSnapshotDTO | null;
  section: string;
  isNew: boolean;
  changeNote: string | null;
}

export interface BriefingDTO {
  id: string;
  type: BriefingType;
  periodKey: string;
  createdAt: string;
  cutoffAt: string;
  tz: string;
  title: string;
  oneMinuteRead: string[];
  sections: { name: string; items: BriefingItem[] }[];
  delta: { added: string[]; updated: string[]; note: string } | null;
  contentMd?: string;
  engine: "ai" | "extractive";
}

// ---------------- 提醒与观察列表 ----------------

export interface AlertDTO {
  id: number;
  createdAt: string;
  level: "info" | "notable" | "breaking";
  eventId: string | null;
  title: string;
  body: string;
  reason: string;
  readAt: string | null;
}

export interface WatchlistDTO {
  id: string;
  name: string;
  keywords: string[];
  entities: string[];
  minImportance: number;
  channels: string[];
  enabled: boolean;
  createdAt: string;
}

// ---------------- 问答 ----------------

export interface AskFilters {
  onlyOfficial?: boolean;
  onlyCivilian?: boolean;
  excludeReprints?: boolean;
  onlyCrossVerified?: boolean;
}

export interface AskResponse {
  answer: string;
  /** 回答中 [n] 标记对应的引用 */
  citations: Citation[];
  cutoff: string;
  caveats: string[];
  engine: "ai" | "extractive";
  relatedEventIds: string[];
}

// ---------------- 系统 ----------------

export interface HealthDTO {
  ok: boolean;
  version: string;
  now: string;
  db: boolean;
  scheduler: { running: boolean; lastTickAt: string | null };
  counts: { sources: number; articles: number; events: number; claims: number };
  workflow: {
    backlog: number;
    running: number;
    remanded: number;
    failed: number;
    completed: number;
    lastCompletedAt: string | null;
  };
}

export interface StatsDTO {
  articles24h: number;
  events24h: number;
  activeEvents: number;
  sourceHealth: SourceHealthSummary;
  lastIngestAt: string | null;
  topEvents: RoutedEventItem[];
}

export interface FetchLogDTO {
  id: number;
  sourceId: string;
  sourceName?: string;
  startedAt: string;
  ok: boolean;
  httpStatus: number | null;
  found: number;
  added: number;
  error: string | null;
  ms: number;
}

/** 统一 API 响应包装 */
export interface ApiError {
  error: string;
  detail?: string;
}
