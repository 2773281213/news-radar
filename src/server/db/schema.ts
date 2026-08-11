// ============================================================
// 数据库 Schema（SQLite / Drizzle）
// 时间字段统一为 UTC ISO8601 文本；JSON 字段使用 text(mode:json)
// ============================================================
import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { Citation } from "../../shared/types";

/** 来源家族：所有权/通讯社稿源/平台归属，用于识别“虚假多样性” */
export const sourceFamilies = sqliteTable("source_families", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  kind: text("kind").notNull(), // ownership | wire | platform
  note: text("note"),
});

/** 来源注册表 */
export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    homepage: text("homepage"),
    feedUrl: text("feed_url"),
    adapter: text("adapter").notNull(), // rss | jsonfeed | gdelt | mastodon | bluesky | telegramweb
    config: text("config", { mode: "json" }).$type<Record<string, string>>(),
    country: text("country"),
    region: text("region"),
    lang: text("lang"),
    category: text("category").notNull(),
    owner: text("owner"),
    ownershipNote: text("ownership_note"),
    isParty: integer("is_party", { mode: "boolean" }).notNull().default(false),
    partyOf: text("party_of"),
    isPrimary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    paywalled: integer("paywalled", { mode: "boolean" }).notNull().default(false),
    fetchFulltext: integer("fetch_fulltext", { mode: "boolean" }).notNull().default(false),
    intervalMin: integer("interval_min").notNull().default(30),
    verifStatus: text("verif_status").notNull().default("pending"),
    verifBasis: text("verif_basis"),
    lastReviewedAt: text("last_reviewed_at"),
    familyId: text("family_id"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastFetchAt: text("last_fetch_at"),
    lastSuccessAt: text("last_success_at"),
    consecFails: integer("consec_fails").notNull().default(0),
    backoffUntil: text("backoff_until"),
    health: text("health").notNull().default("unknown"),
    corrections: integer("corrections").notNull().default(0),
    addedBy: text("added_by").notNull().default("seed"),
    notes: text("notes"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("idx_sources_enabled").on(t.enabled), index("idx_sources_category").on(t.category)]
);

/** 文章（含社交帖子，统一为内容条目） */
export const articles = sqliteTable(
  "articles",
  {
    id: text("id").primaryKey(), // sha256(normalizedUrl 或 sourceId+guid) 截断
    sourceId: text("source_id").notNull(),
    url: text("url").notNull(),
    canonicalUrl: text("canonical_url"),
    normalizedUrl: text("normalized_url").notNull(),
    guid: text("guid"),
    title: text("title").notNull(),
    titleNorm: text("title_norm").notNull(),
    author: text("author"),
    lang: text("lang"),
    publishedAt: text("published_at"),
    srcUpdatedAt: text("src_updated_at"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastCrawledAt: text("last_crawled_at"),
    bodyText: text("body_text"),
    excerpt: text("excerpt"),
    imageUrl: text("image_url"),
    contentHash: text("content_hash"),
    simhash: text("simhash"), // 64 位十六进制
    isReprint: integer("is_reprint", { mode: "boolean" }).notNull().default(false),
    reprintOf: text("reprint_of"),
    wireFamily: text("wire_family"),
    paywalled: integer("paywalled", { mode: "boolean" }).notNull().default(false),
    eventId: text("event_id"),
    status: text("status").notNull().default("new"), // new | analyzed | discarded
    extra: text("extra", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => [
    uniqueIndex("uq_articles_normurl").on(t.normalizedUrl),
    index("idx_articles_source").on(t.sourceId),
    index("idx_articles_event").on(t.eventId),
    index("idx_articles_published").on(t.publishedAt),
    index("idx_articles_status").on(t.status),
    index("idx_articles_chash").on(t.contentHash),
  ]
);

/** 文章版本（原文修改/更正记录） */
export const articleVersions = sqliteTable(
  "article_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    articleId: text("article_id").notNull(),
    seenAt: text("seen_at").notNull(),
    title: text("title").notNull(),
    contentHash: text("content_hash"),
    note: text("note"), // modified | corrected | deleted
  },
  (t) => [index("idx_artver_article").on(t.articleId)]
);

/** 事件（同一现实事件的报道聚合） */
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    oneLiner: text("one_liner"),
    status: text("status").notNull().default("developing"),
    trackMode: text("track_mode").notNull().default("normal"),
    importance: integer("importance").notNull().default(30),
    heat: integer("heat").notNull().default(0),
    prevHeat: integer("prev_heat").notNull().default(0),
    topics: text("topics", { mode: "json" }).$type<string[]>(),
    countries: text("countries", { mode: "json" }).$type<string[]>(),
    entities: text("entities", { mode: "json" }).$type<{ slug: string; count: number }[]>(),
    firstAt: text("first_at").notNull(),
    lastUpdateAt: text("last_update_at").notNull(),
    lastVerifiedAt: text("last_verified_at"),
    version: integer("version").notNull().default(1),
    summary: text("summary", { mode: "json" }),
    summaryEngine: text("summary_engine").notNull().default("extractive"),
    dirty: integer("dirty", { mode: "boolean" }).notNull().default(true),
    lastSummaryAt: text("last_summary_at"),
  },
  (t) => [
    index("idx_events_lastupdate").on(t.lastUpdateAt),
    index("idx_events_status").on(t.status),
    index("idx_events_importance").on(t.importance),
  ]
);

/** 事件版本快照（“与上一版相比”） */
export const eventVersions = sqliteTable(
  "event_versions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    eventId: text("event_id").notNull(),
    version: integer("version").notNull(),
    createdAt: text("created_at").notNull(),
    summary: text("summary", { mode: "json" }),
    changes: text("changes", { mode: "json" }).$type<{ added: string[]; changed: string[]; removed: string[] }>(),
  },
  (t) => [index("idx_evtver_event").on(t.eventId)]
);

/** 三省六部工作流当前投影 */
export const workflowCases = sqliteTable(
  "workflow_cases",
  {
    eventId: text("event_id").primaryKey(),
    status: text("status").notNull().default("pending"),
    currentDepartment: text("current_department").notNull().default("zhongshu"),
    revision: integer("revision").notNull().default(0),
    rulesVersion: text("rules_version").notNull(),
    inputHash: text("input_hash").notNull(),
    activeRunId: text("active_run_id"),
    proposal: text("proposal", { mode: "json" }).$type<Record<string, unknown>>(),
    review: text("review", { mode: "json" }).$type<Record<string, unknown>>(),
    dispatch: text("dispatch", { mode: "json" }).$type<Record<string, unknown>>(),
    publishable: integer("publishable", { mode: "boolean" }).notNull().default(false),
    lastErrorCode: text("last_error_code"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    approvedAt: text("approved_at"),
    completedAt: text("completed_at"),
  },
  (t) => [
    index("idx_workflow_cases_status").on(t.status),
    index("idx_workflow_cases_health").on(t.status, t.completedAt),
    index("idx_workflow_cases_department").on(t.currentDepartment),
    index("idx_workflow_cases_publishable").on(t.publishable),
    index("idx_workflow_cases_updated").on(t.updatedAt),
  ]
);

/** 同一证据指纹在同一规则版本下只产生一次逻辑运行 */
export const workflowRuns = sqliteTable(
  "workflow_runs",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    inputHash: text("input_hash").notNull(),
    rulesVersion: text("rules_version").notNull(),
    trigger: text("trigger").notNull(),
    status: text("status").notNull().default("running"),
    attempt: integer("attempt").notNull().default(1),
    leaseUntil: text("lease_until"),
    nextAttemptAt: text("next_attempt_at"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
  },
  (t) => [
    uniqueIndex("uq_workflow_run_input").on(t.eventId, t.inputHash, t.rulesVersion),
    index("idx_workflow_runs_event").on(t.eventId),
    index("idx_workflow_runs_status").on(t.status),
    index("idx_workflow_runs_retry").on(t.nextAttemptAt),
  ]
);

/** 每次运行的多值六部分派 */
export const workflowMinistryAssignments = sqliteTable(
  "workflow_ministry_assignments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    eventId: text("event_id").notNull(),
    ministry: text("ministry").notNull(),
    score: integer("score").notNull(),
    primary: integer("is_primary", { mode: "boolean" }).notNull().default(false),
    reasons: text("reasons", { mode: "json" }).$type<string[]>(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_workflow_assignment").on(t.runId, t.ministry),
    index("idx_workflow_assignment_event").on(t.eventId),
    index("idx_workflow_assignment_ministry").on(t.ministry),
  ]
);

/** 六部在每次运行尝试中产出的专责报告；失败重试保留旧 attempt 供审计 */
export const workflowMinistryReports = sqliteTable(
  "workflow_ministry_reports",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    eventId: text("event_id").notNull(),
    ministry: text("ministry").notNull(),
    attempt: integer("attempt").notNull().default(1),
    status: text("status").notNull().default("pending"),
    findings: text("findings", { mode: "json" }).$type<string[]>().notNull(),
    risks: text("risks", { mode: "json" }).$type<string[]>().notNull(),
    evidenceGaps: text("evidence_gaps", { mode: "json" }).$type<string[]>().notNull(),
    actions: text("actions", { mode: "json" }).$type<string[]>().notNull(),
    citations: text("citations", { mode: "json" }).$type<Citation[]>().notNull(),
    claimRefs: text("claim_refs", { mode: "json" }).$type<string[]>().notNull(),
    rulesVersion: text("rules_version").notNull(),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    errorCode: text("error_code"),
    errorDetail: text("error_detail"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_workflow_ministry_report_attempt").on(t.runId, t.ministry, t.attempt),
    index("idx_workflow_ministry_report_run").on(t.runId, t.attempt),
    index("idx_workflow_ministry_report_event").on(t.eventId),
    index("idx_workflow_ministry_report_ministry_status").on(t.ministry, t.status),
  ]
);

/** 追加式迁移审计日志，不提供修改与删除入口 */
export const workflowTransitions = sqliteTable(
  "workflow_transitions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    eventId: text("event_id").notNull(),
    sequence: integer("sequence").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    department: text("department").notNull(),
    action: text("action").notNull(),
    reasonCode: text("reason_code").notNull(),
    rationale: text("rationale", { mode: "json" }).$type<string[]>(),
    artifact: text("artifact", { mode: "json" }).$type<Record<string, unknown>>(),
    actorType: text("actor_type").notNull().default("system"),
    actorId: text("actor_id"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_workflow_transition_sequence").on(t.runId, t.sequence),
    uniqueIndex("uq_workflow_transition_key").on(t.idempotencyKey),
    index("idx_workflow_transition_event").on(t.eventId),
  ]
);

/** 事件-文章关联 */
export const eventArticles = sqliteTable(
  "event_articles",
  {
    eventId: text("event_id").notNull(),
    articleId: text("article_id").notNull(),
    addedAt: text("added_at").notNull(),
    role: text("role").notNull().default("report"), // report | statement | data | analysis
    familyKey: text("family_key"), // 独立性计数用的家族键
  },
  (t) => [
    uniqueIndex("uq_event_articles").on(t.eventId, t.articleId),
    index("idx_evtart_article").on(t.articleId),
  ]
);

/** 具体主张（Claim） */
export const claims = sqliteTable(
  "claims",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    text: text("text").notNull(),
    textNorm: text("text_norm").notNull(),
    type: text("type").notNull().default("event"),
    claimedBy: text("claimed_by"),
    claimedByKind: text("claimed_by_kind"), // gov | military | party | media | org | social | unknown
    party: text("party"),
    subjectNumber: real("subject_number"),
    numberUnit: text("number_unit"),
    asOf: text("as_of"),
    occurredAt: text("occurred_at"),
    publishedAt: text("published_at"),
    firstSeenAt: text("first_seen_at").notNull(),
    status: text("status").notNull().default("reported"),
    rationale: text("rationale", { mode: "json" }),
    lastCheckedAt: text("last_checked_at"),
    supersededBy: text("superseded_by"),
  },
  (t) => [index("idx_claims_event").on(t.eventId), index("idx_claims_status").on(t.status)]
);

/** Claim 证据关联 */
export const claimEvidence = sqliteTable(
  "claim_evidence",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    claimId: text("claim_id").notNull(),
    articleId: text("article_id").notNull(),
    stance: text("stance").notNull().default("reports"),
    familyKey: text("family_key"),
    hasPrimary: integer("has_primary", { mode: "boolean" }).notNull().default(false),
    note: text("note"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_claim_evidence").on(t.claimId, t.articleId),
    index("idx_evidence_article").on(t.articleId),
  ]
);

/** 简报 */
export const briefings = sqliteTable(
  "briefings",
  {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    periodKey: text("period_key").notNull(),
    createdAt: text("created_at").notNull(),
    cutoffAt: text("cutoff_at").notNull(),
    tz: text("tz").notNull(),
    content: text("content", { mode: "json" }),
    contentMd: text("content_md"),
    prevId: text("prev_id"),
    delta: text("delta", { mode: "json" }),
    engine: text("engine").notNull().default("extractive"),
  },
  (t) => [uniqueIndex("uq_briefings_period").on(t.type, t.periodKey), index("idx_briefings_created").on(t.createdAt)]
);

/** 提醒 */
export const alerts = sqliteTable(
  "alerts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    createdAt: text("created_at").notNull(),
    level: text("level").notNull().default("info"),
    eventId: text("event_id"),
    claimId: text("claim_id"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    reason: text("reason").notNull(),
    sentChannels: text("sent_channels", { mode: "json" }).$type<string[]>(),
    readAt: text("read_at"),
    dedupeKey: text("dedupe_key"),
  },
  (t) => [index("idx_alerts_created").on(t.createdAt), uniqueIndex("uq_alerts_dedupe").on(t.dedupeKey)]
);

/** 观察列表 */
export const watchlists = sqliteTable("watchlists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  keywords: text("keywords", { mode: "json" }).$type<string[]>(),
  entities: text("entities", { mode: "json" }).$type<string[]>(),
  minImportance: integer("min_importance").notNull().default(40),
  channels: text("channels", { mode: "json" }).$type<string[]>(),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  createdAt: text("created_at").notNull(),
});

/** Web Push 订阅 */
export const pushSubs = sqliteTable(
  "push_subs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    ua: text("ua"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("uq_push_endpoint").on(t.endpoint)]
);

/** 采集日志 */
export const fetchLog = sqliteTable(
  "fetch_log",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: text("source_id").notNull(),
    startedAt: text("started_at").notNull(),
    ok: integer("ok", { mode: "boolean" }).notNull(),
    httpStatus: integer("http_status"),
    found: integer("found").notNull().default(0),
    added: integer("added").notNull().default(0),
    error: text("error"),
    ms: integer("ms").notNull().default(0),
  },
  (t) => [index("idx_fetchlog_source").on(t.sourceId), index("idx_fetchlog_started").on(t.startedAt)]
);

/** 简单 KV（缓存、调度标记、robots 缓存等） */
export const kvStore = sqliteTable("kv_store", {
  k: text("k").primaryKey(),
  v: text("v").notNull(),
  expiresAt: text("expires_at"),
});
