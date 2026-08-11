import type { ReactNode } from "react";
import { Link } from "wouter";
import type {
  Citation,
  EventWorkflowDTO,
  GovernanceSnapshotDTO,
  MinistryAssignmentDTO,
  MinistryCode,
  MinistryReportStatus,
  MinistryWorkReportDTO,
  WorkflowDashboardDTO,
  WorkflowState,
} from "../../shared/types";
import {
  DEPARTMENT_LABELS,
  MINISTRY_DESCRIPTIONS,
  MINISTRY_LABELS,
  MINISTRY_SLUGS,
  WORKFLOW_STATE_LABELS,
} from "../../shared/constants";
import { Badge, CitationList, ExternalLink, Panel, SectionHeader } from "./ui";
import { formatDateTime, formatNumber } from "../utils";
import { usePreferences } from "../preferences";

const MINISTRY_GLYPHS: Record<MinistryCode, string> = {
  source_identity: "吏",
  economy: "户",
  diplomacy_society: "礼",
  conflict_security: "兵",
  law_factcheck: "刑",
  technology_infrastructure_disaster: "工",
};

const STATE_TONES: Record<WorkflowState, "neutral" | "accent" | "warning" | "good" | "danger" | "info"> = {
  pending: "neutral",
  proposed: "accent",
  remanded: "warning",
  approved: "info",
  dispatched: "accent",
  completed: "good",
  failed: "danger",
};

const REPORT_STATUS: Record<MinistryReportStatus, { label: string; tone: "neutral" | "accent" | "warning" | "good" | "danger" }> = {
  pending: { label: "待领办", tone: "neutral" },
  running: { label: "办理中", tone: "accent" },
  completed: { label: "已具报", tone: "good" },
  failed: { label: "执行异常", tone: "danger" },
  blocked: { label: "本轮待命", tone: "neutral" },
};

const DISPATCH_ACTION_LABELS = {
  ministries: "六部专责",
  summary: "摘要汇总",
  alerts: "提醒评估",
} as const;

const PROPOSAL_ACTION_LABELS: Record<string, string> = {
  execute_ministry_reports: "交六部专责分析",
  consolidate_ministry_findings: "尚书汇总六部报告",
  refresh_summary: "刷新事件摘要",
  evaluate_alerts: "评估提醒",
  consider_briefing: "评估纳入简报",
  consider_active_search: "评估主动补证",
};

function arrayOrEmpty<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value.filter((item): item is T => item !== null && item !== undefined) : [];
}

function ministryMeta(ministry: MinistryCode) {
  return {
    label: MINISTRY_LABELS[ministry] || "未知部",
    slug: MINISTRY_SLUGS[ministry] || "unknown",
    description: MINISTRY_DESCRIPTIONS[ministry] || "该报告来自旧版或未知部门编码，请核对后端契约。",
    glyph: MINISTRY_GLYPHS[ministry] || "?",
  };
}

export function MinistrySeal({ ministry, size = "md", decorative = false }: {
  ministry: MinistryCode;
  size?: "sm" | "md" | "lg";
  decorative?: boolean;
}) {
  const meta = ministryMeta(ministry);
  return (
    <span
      className={`ministry-seal ministry-seal-${size}`}
      aria-hidden={decorative || undefined}
      aria-label={decorative ? undefined : meta.label}
    >
      {meta.glyph}
    </span>
  );
}

export function WorkflowStatusBadge({ status }: { status: WorkflowState }) {
  return <Badge tone={STATE_TONES[status] || "neutral"}>{WORKFLOW_STATE_LABELS[status] || "未知状态"}</Badge>;
}

export function WorkflowStageCard({
  index,
  office,
  title,
  description,
  metrics,
  active,
  children,
}: {
  index: string;
  office: "中书省" | "门下省" | "尚书省";
  title: string;
  description: string;
  metrics: Array<{ label: string; value: number }>;
  active?: boolean;
  children?: ReactNode;
}) {
  return (
    <li className={active ? "workflow-stage-card is-active" : "workflow-stage-card"}>
      <div className="workflow-stage-index" aria-hidden="true">{index}</div>
      <header>
        <p>{office}</p>
        <h2>{title}</h2>
        <span>{description}</span>
      </header>
      <dl>
        {metrics.map((metric) => (
          <div key={metric.label}>
            <dt>{metric.label}</dt>
            <dd>{formatNumber(metric.value)}</dd>
          </div>
        ))}
      </dl>
      {children ? <div className="workflow-stage-action">{children}</div> : null}
    </li>
  );
}

export function MinistryRouteCard({ summary }: { summary: WorkflowDashboardDTO["ministries"][number] }) {
  const meta = ministryMeta(summary.ministry);
  return (
    <article className="ministry-route-card">
      <div className="ministry-route-heading">
        <MinistrySeal ministry={summary.ministry} size="lg" decorative />
        <div>
          <p className="eyebrow">{meta.slug}</p>
          <h3>{meta.label}</h3>
        </div>
      </div>
      <p>{meta.description}</p>
      <dl>
        <div><dt>在办事件</dt><dd>{formatNumber(summary.activeEvents)}</dd></div>
        <div><dt>24h 更新</dt><dd>{formatNumber(summary.updates24h)}</dd></div>
        <div><dt>封驳</dt><dd>{formatNumber(summary.remanded)}</dd></div>
        <div><dt>争议主张</dt><dd>{formatNumber(summary.disputedClaims)}</dd></div>
      </dl>
      <Link className="ministry-card-link" href={meta.slug === "unknown" ? "/workflow" : `/ministries/${meta.slug}`}>
        进入{meta.label}工作台 <span aria-hidden="true">→</span>
      </Link>
    </article>
  );
}

export function RoutingByline({
  primary,
  collaborators,
  reasons,
  status,
}: {
  primary: MinistryCode | null;
  collaborators: MinistryCode[];
  reasons: string[];
  status?: WorkflowState | null;
}) {
  const safeCollaborators = arrayOrEmpty(collaborators);
  const safeReasons = arrayOrEmpty(reasons);
  return (
    <div className="routing-byline">
      <div className="routing-labels">
        {primary ? <><MinistrySeal ministry={primary} size="sm" decorative /><strong>主送{ministryMeta(primary).label}</strong></> : <strong>尚书省待分流</strong>}
        {safeCollaborators.length ? <span>会同 {safeCollaborators.map((item) => ministryMeta(item).label).join("、")}</span> : null}
        {status ? <WorkflowStatusBadge status={status} /> : null}
      </div>
      {safeReasons.length ? (
        <details>
          <summary>查看分流依据</summary>
          <ul>{safeReasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
        </details>
      ) : null}
    </div>
  );
}

/** 实时事件与简报共用的紧凑审议链；数据直接来自 workflow_cases 批量投影。 */
export function GovernanceTrace({
  snapshot,
  sources,
  unverifiedCount,
}: {
  snapshot: GovernanceSnapshotDTO | null | undefined;
  sources?: Citation[];
  unverifiedCount?: number;
}) {
  const { timeZone } = usePreferences();
  if (!snapshot) {
    return (
      <section className="governance-trace is-missing" aria-label="三省六部审议流程">
        <strong>审议记录待同步</strong>
        <span>该条目暂不具备正式呈递条件</span>
      </section>
    );
  }

  const { workflow, proposal, review, dispatch } = snapshot;
  const progress = workflow.ministryReportProgress;
  const safeSources = arrayOrEmpty(sources);
  const decision = review?.decision;
  const sourceCount = proposal?.independentFamilies ?? 0;
  const blockers = arrayOrEmpty(review?.gaps).length;
  return (
    <section className="governance-trace" aria-label="三省六部审议流程">
      <header className="governance-trace-head">
        <span>审议链 · {workflow.rulesVersion}</span>
        <WorkflowStatusBadge status={workflow.status} />
        <time dateTime={workflow.updatedAt}>{formatDateTime(workflow.updatedAt, timeZone)}</time>
      </header>
      <ol className="governance-trace-stages">
        <li className={proposal ? "is-complete" : "is-pending"}>
          <span>01 · 中书省</span>
          <strong>{proposal ? "聚合成案" : "等待拟稿"}</strong>
          <small>{sourceCount} 个独立来源 · {proposal?.originalArticles ?? 0} 份原始材料</small>
        </li>
        <li className={decision === "approve" ? "is-complete" : decision === "remand" ? "is-remanded" : "is-pending"}>
          <span>02 · 门下省</span>
          <strong>{decision === "approve" ? "准奏" : decision === "remand" ? "封驳补证" : "复核中"}</strong>
          <small>{decision === "remand" ? `${blockers} 项阻断缺口` : `${unverifiedCount || 0} 项说法仍标注待核实`}</small>
        </li>
        <li className={workflow.publishable ? "is-complete" : dispatch ? "is-active" : "is-pending"}>
          <span>03 · 尚书省</span>
          <strong>{workflow.publishable ? "完成呈递" : dispatch ? "六部办理" : "等待执行"}</strong>
          <small>{progress.completed}/{progress.total} 部具报 · {dispatch?.ministryDigest?.citationCount ?? 0} 条核验引用</small>
        </li>
      </ol>
      <div className="governance-source-trail">
        <strong>原始链路</strong>
        {safeSources.slice(0, 4).map((source) => (
          <ExternalLink key={source.articleId} href={source.url}>
            {source.sourceName}
            <time dateTime={source.publishedAt || undefined}>
              {source.publishedAt ? formatDateTime(source.publishedAt, timeZone) : "发布时间待确认"}
            </time>
          </ExternalLink>
        ))}
        {!safeSources.length ? <span>原始链接待同步</span> : null}
      </div>
    </section>
  );
}

export function MinistryReportCard({
  report,
  eventTitle,
  compact = false,
}: {
  report: MinistryWorkReportDTO;
  eventTitle?: string;
  compact?: boolean;
}) {
  const status = REPORT_STATUS[report.status] || { label: "未知状态", tone: "neutral" as const };
  const meta = ministryMeta(report.ministry);
  const assignmentReasons = arrayOrEmpty(report.assignment?.reasons);
  const findings = arrayOrEmpty(report.findings);
  const risks = arrayOrEmpty(report.risks);
  const evidenceGaps = arrayOrEmpty(report.evidenceGaps);
  const actions = arrayOrEmpty(report.actions);
  const citations = arrayOrEmpty(report.citations);
  const claimRefs = arrayOrEmpty(report.claimRefs);
  const bodyId = `ministry-report-${report.id ?? `${report.ministry}-${report.attempt ?? "unknown"}`}`;
  return (
    <article
      className={`ministry-report-card status-${report.status}${compact ? " is-compact" : ""}`}
      data-ministry={report.ministry}
    >
      <details open={Boolean(report.assignment?.primary)}>
        <summary aria-controls={bodyId}>
          <MinistrySeal ministry={report.ministry} size={compact ? "sm" : "md"} decorative />
          <span className="ministry-report-heading">
            <span>
              <strong>{meta.label}具报</strong>
              {report.assignment ? (
                <small>{report.assignment.primary ? "主办" : "会同"} · 评分 {report.assignment.score ?? "—"}</small>
              ) : (
                <small>本轮无专责交办</small>
              )}
            </span>
            <Badge tone={status.tone}>{status.label}</Badge>
          </span>
        </summary>

        <div className="ministry-report-body" id={bodyId}>
          {eventTitle && report.eventId ? <Link className="ministry-report-event" href={`/events/${encodeURIComponent(report.eventId)}`}>{eventTitle}</Link> : null}
          {assignmentReasons.length ? (
            <p className="ministry-report-mandate">交办理由：{assignmentReasons.join("；")}</p>
          ) : null}
          {report.errorDetail ? <p className="ministry-report-error">{report.errorCode}: {report.errorDetail}</p> : null}
          <ReportList title="本部发现" items={findings} tone="finding" />
          <ReportList title="风险提示" items={risks} tone="risk" />
          <ReportList title="补证缺口" items={evidenceGaps} tone="gap" />
          <ReportList title="执行建议" items={actions} tone="action" />
          <CitationList
            citations={citations}
            heading={`${meta.label}引用`}
            idPrefix={`ministry-${report.id}-citation`}
            compact
          />
          <footer>
            <span>第 {report.attempt ?? "?"} 次办理</span>
            <span>{claimRefs.length} 项 Claim · {citations.length} 条引用</span>
          </footer>
        </div>
      </details>
    </article>
  );
}

function ReportList({ title, items, tone }: { title: string; items: string[]; tone: "finding" | "risk" | "gap" | "action" }) {
  const safeItems = arrayOrEmpty(items);
  if (!safeItems.length) return null;
  return (
    <section className={`ministry-report-list tone-${tone}`}>
      <h4>{title}</h4>
      <ul>{safeItems.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
    </section>
  );
}

export function WorkflowAuditPanel({ data }: { data: EventWorkflowDTO }) {
  const { timeZone } = usePreferences();
  const workflow = (data.workflow || {}) as Partial<EventWorkflowDTO["workflow"]>;
  const assignments = arrayOrEmpty(workflow.assignments);
  const transitions = arrayOrEmpty(data.transitions);
  const reports = arrayOrEmpty(data.ministryReports);
  const primary = assignments.find((assignment) => assignment.primary) || assignments[0];
  const fallbackProgress = {
    total: reports.length,
    pending: reports.filter((report) => report.status === "pending").length,
    running: reports.filter((report) => report.status === "running").length,
    completed: reports.filter((report) => report.status === "completed").length,
    blocked: reports.filter((report) => report.status === "blocked").length,
    failed: reports.filter((report) => report.status === "failed").length,
  };
  const progress = { ...fallbackProgress, ...(workflow.ministryReportProgress || {}) };
  const status = (workflow.status || "pending") as WorkflowState;
  const departmentLabel = workflow.currentDepartment
    ? DEPARTMENT_LABELS[workflow.currentDepartment] || "未知部门"
    : "待接管";
  return (
    <Panel className="workflow-audit-panel" aria-labelledby="workflow-audit-title">
      <SectionHeader
        id="workflow-audit-title"
        eyebrow={`RULE ${workflow.rulesVersion || "legacy"}`}
        title="三省审议记录"
        description="自动审议用于控制摘要与提醒的发布门槛，不把封驳解释为事件为假。"
      />
      <div className="workflow-audit-status">
        <WorkflowStatusBadge status={status} />
        <span>{departmentLabel}</span>
        {workflow.updatedAt
          ? <time dateTime={workflow.updatedAt}>{formatDateTime(workflow.updatedAt, timeZone)}</time>
          : <span>时间待同步</span>}
      </div>
      <RoutingByline
        primary={primary?.ministry || null}
        collaborators={assignments.filter((item) => item.ministry !== primary?.ministry).map((item) => item.ministry)}
        reasons={arrayOrEmpty(primary?.reasons)}
      />
      {data.proposal ? (
        <article className="governance-artifact zhongshu-artifact">
          <header><span className="artifact-stamp">中书</span><div><p className="eyebrow">第一省 · MEMORIAL</p><h3>中书奏议</h3></div></header>
          <div className="artifact-metrics">
            <span><small>重要度</small><strong>{data.proposal.importance ?? 0}</strong></span>
            <span><small>热度</small><strong>{data.proposal.heat ?? 0}</strong></span>
            <span><small>独立家族</small><strong>{data.proposal.independentFamilies ?? 0}</strong></span>
            <span><small>原始材料</small><strong>{data.proposal.originalArticles ?? 0}</strong></span>
          </div>
          <p>{arrayOrEmpty(data.proposal.rationale).join(" ") || "旧版奏议未附拟稿说明。"}</p>
          <ul className="artifact-action-list">
            {arrayOrEmpty(data.proposal.actions).map((action) => <li key={action}>{PROPOSAL_ACTION_LABELS[action] || action}</li>)}
          </ul>
        </article>
      ) : null}
      {data.review ? (
        <article className={data.review.decision === "approve" ? "governance-artifact review-decision is-approved" : "governance-artifact review-decision is-remanded"}>
          <header><span className="artifact-stamp">门下</span><div><p className="eyebrow">第二省 · RED INK</p><h3>{data.review.decision === "approve" ? "门下准奏" : "门下封驳"}</h3></div></header>
          <p>{arrayOrEmpty(data.review.rationale).join(" ") || "旧版批红未附复核说明。"}</p>
          {arrayOrEmpty(data.review.gaps).length ? <ReportList title="阻断缺口" items={arrayOrEmpty(data.review.gaps).map((gap) => `${gap.code || "EVIDENCE_GAP"}：${gap.message || "证据不足"} 建议：${gap.suggestedAction || "继续补证"}`)} tone="gap" /> : null}
          {arrayOrEmpty(data.review.warnings).length ? <ReportList title="朱批提示" items={arrayOrEmpty(data.review.warnings).map((gap) => `${gap.code || "REVIEW_WARNING"}：${gap.message || "请复核旧版记录"}`)} tone="risk" /> : null}
        </article>
      ) : null}
      {data.dispatch ? (
        <article className="governance-artifact shangshu-artifact">
          <header><span className="artifact-stamp">尚书</span><div><p className="eyebrow">第三省 · EXECUTION ORDER</p><h3>尚书执行令</h3></div></header>
          <div className="dispatch-action-grid">
            {(Object.keys(DISPATCH_ACTION_LABELS) as Array<keyof typeof DISPATCH_ACTION_LABELS>).map((action) => {
              const actionStatus = data.dispatch!.actions?.[action] || "pending";
              return <div key={action}><span>{DISPATCH_ACTION_LABELS[action]}</span><Badge tone={actionStatus === "completed" ? "good" : actionStatus === "failed" ? "danger" : "accent"}>{actionStatus === "completed" ? "已完成" : actionStatus === "failed" ? "失败" : "待执行"}</Badge></div>;
            })}
          </div>
          {data.dispatch.ministryDigest ? (
            <div className="ministry-digest">
              <strong>六部汇总 · {data.dispatch.ministryDigest.citationCount ?? 0} 条引用</strong>
              <p>{arrayOrEmpty(data.dispatch.ministryDigest.findings).slice(0, 3).join(" ") || "本轮没有可合并的具报发现。"}</p>
              {arrayOrEmpty(data.dispatch.ministryDigest.risks).length ? <small>风险：{arrayOrEmpty(data.dispatch.ministryDigest.risks).slice(0, 2).join("；")}</small> : null}
            </div>
          ) : null}
          {arrayOrEmpty(data.dispatch.errors).length ? <ReportList title="执行异常" items={arrayOrEmpty(data.dispatch.errors)} tone="risk" /> : null}
        </article>
      ) : null}
      {reports.length ? (
        <section className="ministry-report-section" aria-labelledby="ministry-report-section-title">
          <header className="report-section-head">
            <div><p className="eyebrow">六部具报</p><h3 id="ministry-report-section-title">专责办理簿</h3></div>
            <span className="report-progress">{progress.completed} 成 / {progress.blocked} 待命 / {progress.failed} 异常</span>
          </header>
          <div className="ministry-report-list-grid">
            {reports.map((report, index) => <MinistryReportCard key={`${report.ministry || "unknown"}-${report.attempt ?? index}`} report={report} compact />)}
          </div>
        </section>
      ) : null}
      <details className="audit-log">
        <summary>展开完整审计时间线（{transitions.length} 条）</summary>
        <ol className="workflow-transition-list">
          {transitions.slice().reverse().map((transition, index) => {
            const action = String(transition.action || "");
            return (
              <li key={transition.id ?? `${transition.runId || "legacy"}-${index}`}>
                <span>{Number.isFinite(transition.sequence) ? transition.sequence.toString().padStart(2, "0") : "--"}</span>
                <div>
                  <strong>{DEPARTMENT_LABELS[transition.department] || "未知部门"} · {action.startsWith("ministry_report_") ? "六部具报" : WORKFLOW_STATE_LABELS[transition.toState] || "未知状态"}</strong>
                  <p>{arrayOrEmpty(transition.rationale).join(" ") || "旧版审计记录未附说明。"}</p>
                  {transition.createdAt ? <time dateTime={transition.createdAt}>{formatDateTime(transition.createdAt, timeZone)}</time> : null}
                </div>
              </li>
            );
          })}
        </ol>
      </details>
    </Panel>
  );
}

export function assignmentsToRouting(assignments: MinistryAssignmentDTO[]) {
  const safeAssignments = arrayOrEmpty(assignments);
  const primary = safeAssignments.find((item) => item.primary) || safeAssignments[0];
  return {
    primary: primary?.ministry || null,
    collaborators: safeAssignments.filter((item) => item.ministry !== primary?.ministry).map((item) => item.ministry),
    reasons: arrayOrEmpty(primary?.reasons),
  };
}
