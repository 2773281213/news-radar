import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Link } from "wouter";
import type { EventWorkflowDTO, RoutedEventItem, WorkflowDashboardDTO } from "../../shared/types";
import {
  DEPARTMENT_LABELS,
  MINISTRY_DESCRIPTIONS,
  MINISTRY_LABELS,
  MINISTRY_SLUGS,
} from "../../shared/constants";
import { API_ROUTES, useApi } from "../api";
import { usePreferences } from "../preferences";
import { formatDateTime, formatRelativeTime, formatNumber } from "../utils";
import { MinistrySeal, WorkflowAuditPanel, WorkflowStatusBadge } from "../components/governance";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  RefreshButton,
  Badge,
} from "../components/ui";

type WorkspacePane = "docket" | "memorials" | "review";
type QueueFilter = "active" | "attention" | "completed" | "all";

const PANE_LABELS: Record<WorkspacePane, string> = {
  docket: "案簿",
  memorials: "奏折",
  review: "批红",
};

const QUEUE_FILTERS: Array<{ key: QueueFilter; label: string }> = [
  { key: "active", label: "待推进" },
  { key: "attention", label: "待处置" },
  { key: "completed", label: "已成报" },
  { key: "all", label: "全部" },
];

function matchesQueueFilter(event: RoutedEventItem, filter: QueueFilter): boolean {
  if (filter === "all") return true;
  if (filter === "completed") return event.workflowStatus === "completed";
  if (filter === "attention") return event.workflowStatus === "remanded" || event.workflowStatus === "failed";
  return event.workflowStatus !== "completed" && event.workflowStatus !== "remanded" && event.workflowStatus !== "failed";
}

const STAGE_META: Array<{ key: "zhongshu" | "menxia" | "shangshu"; index: string; title: string; action: string }> = [
  { key: "zhongshu", index: "壹", title: "中书拟稿", action: "编录证据" },
  { key: "menxia", index: "贰", title: "门下复核", action: "封驳与准奏" },
  { key: "shangshu", index: "叁", title: "尚书执行", action: "六部具报" },
];

export function WorkflowPage() {
  const { timeZone } = usePreferences();
  const dashboardState = useApi<WorkflowDashboardDTO>(API_ROUTES.workflow);
  const dashboard = dashboardState.data;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [activePane, setActivePane] = useState<WorkspacePane>("memorials");
  const [queueFilter, setQueueFilter] = useState<QueueFilter>("all");
  const queueCounts = useMemo(() => {
    const events = dashboard?.recentDispatches || [];
    return {
      active: events.filter((event) => matchesQueueFilter(event, "active")).length,
      attention: events.filter((event) => matchesQueueFilter(event, "attention")).length,
      completed: events.filter((event) => matchesQueueFilter(event, "completed")).length,
      all: events.length,
    };
  }, [dashboard?.recentDispatches]);
  const visibleEvents = useMemo(
    () => (dashboard?.recentDispatches || []).filter((event) => matchesQueueFilter(event, queueFilter)),
    [dashboard?.recentDispatches, queueFilter],
  );
  const selectedEvent = visibleEvents.find((item) => item.id === selectedId) || visibleEvents[0];
  const selectedIndex = selectedEvent ? visibleEvents.findIndex((item) => item.id === selectedEvent.id) : -1;
  const auditState = useApi<EventWorkflowDTO>(selectedEvent ? API_ROUTES.eventWorkflow(selectedEvent.id) : null);

  useEffect(() => {
    document.title = "朝堂工作台 · 新闻雷达";
  }, []);

  useEffect(() => {
    if (!visibleEvents.length) {
      setSelectedId(null);
      return;
    }
    setSelectedId((current) => visibleEvents.some((event) => event.id === current) ? current : visibleEvents[0].id);
  }, [visibleEvents]);

  const selectEvent = (id: string) => {
    setSelectedId(id);
    setActivePane("review");
  };

  const moveSelection = (offset: number) => {
    const nextIndex = selectedIndex + offset;
    const nextEvent = visibleEvents[nextIndex];
    if (nextEvent) selectEvent(nextEvent.id);
  };

  return (
    <div className="court-page">
      <header className="court-masthead">
        <div>
          <p className="eyebrow">EDITORIAL COURT · 三省六部制</p>
          <h1>实时奏议台</h1>
          <p>把新闻材料交给中书拟稿、门下封驳，再由尚书省调度六部具报。</p>
        </div>
        <div className="court-masthead-actions">
          <span className="court-rule-chip">规则 {dashboard?.rulesVersion || "加载中"}</span>
          <RefreshButton refreshing={dashboardState.refreshing} onClick={dashboardState.reload} />
        </div>
      </header>

      <div className="court-cutoff">
        <span className="court-seal-mark" aria-hidden="true">录</span>
        <span><strong>实时截面</strong> · {dashboard ? formatDateTime(dashboard.cutoff, timeZone) : "正在读取"}</span>
        <span className="court-cutoff-note">所有具报均保留文章级引用与审计序列</span>
      </div>

      <nav className="workspace-pane-tabs" aria-label="工作台窗格">
        {(Object.keys(PANE_LABELS) as WorkspacePane[]).map((pane) => (
          <button key={pane} type="button" className={activePane === pane ? "is-active" : undefined} aria-pressed={activePane === pane} onClick={() => setActivePane(pane)}>
            <span>{pane === "docket" ? "01" : pane === "memorials" ? "02" : "03"}</span>
            {PANE_LABELS[pane]}
          </button>
        ))}
      </nav>

      {dashboardState.loading && !dashboard ? <LoadingState label="正在展开朝堂案簿" /> : null}
      {dashboardState.error && !dashboard ? <ErrorState error={dashboardState.error} onRetry={dashboardState.reload} title="无法读取三省工作台" /> : null}

      {dashboard ? (
        <div className={`court-workspace active-${activePane}`}>
          <aside className="court-pane court-index-pane" data-pane="docket" aria-label="案簿与六部">
            <PaneHeader kicker="案簿 / DOSSIER" title="三省案簿" subtitle="先看流程，再看材料" />
            <section className="office-stack" aria-label="三省状态">
              {STAGE_META.map((stage) => {
                const metric = {
                  zhongshu: dashboard.stages.zhongshu.pending,
                  menxia: dashboard.stages.menxia.awaitingReview + dashboard.stages.menxia.remanded,
                  shangshu: dashboard.stages.shangshu.approved,
                }[stage.key];
                return (
                  <article className={`office-strip office-${stage.key}`} key={stage.key}>
                    <span className="office-index">{stage.index}</span>
                    <div><strong>{DEPARTMENT_LABELS[stage.key]}</strong><small>{stage.title} · {stage.action}</small></div>
                    <b>{formatNumber(metric)}</b>
                  </article>
                );
              })}
            </section>

            <section className="docket-note">
              <p className="eyebrow">CURRENT RULE</p>
              <strong>封驳不是判假</strong>
              <p>门下只判断当前证据是否够进入尚书执行。新材料抵达后，案件会以新指纹重新审议。</p>
            </section>

            <section className="ministry-fold-index" aria-labelledby="ministry-fold-title">
              <header><div><p className="eyebrow">六部折页</p><h2 id="ministry-fold-title">职责印章</h2></div><Link href="/live">全案</Link></header>
              <div className="ministry-fold-list">
                {dashboard.ministries.map((summary) => <MinistryIndexFold key={summary.ministry} summary={summary} />)}
              </div>
            </section>

            <nav className="court-quick-links" aria-label="案簿工具">
              <Link href="/sources">来源健康 <span aria-hidden="true">↗</span></Link>
              <Link href="/search">补查证据 <span aria-hidden="true">↗</span></Link>
              <Link href="/briefings">阅读简报 <span aria-hidden="true">↗</span></Link>
            </nav>
          </aside>

          <section className="court-pane memorial-list-pane" data-pane="memorials" aria-label="奏折队列">
            <PaneHeader kicker="奏折 / MEMORIALS" title="待阅奏折" subtitle={`${dashboard.recentDispatches.length} 件最近递送`} action={<Badge tone="accent">LIVE</Badge>} />
            <div className="memorial-queue-toolbar">
              <div className="queue-filter" role="group" aria-label="按办理状态筛选奏折">
                {QUEUE_FILTERS.map((filter) => (
                  <button
                    key={filter.key}
                    type="button"
                    className={queueFilter === filter.key ? "is-active" : undefined}
                    aria-pressed={queueFilter === filter.key}
                    onClick={() => setQueueFilter(filter.key)}
                  >
                    {filter.label}<span>{queueCounts[filter.key]}</span>
                  </button>
                ))}
              </div>
              <span className="queue-result-count">显示 {visibleEvents.length} 件</span>
            </div>
            <div className="memorial-list">
              {visibleEvents.length ? visibleEvents.map((event, index) => (
                <button
                  className={`memorial-card${event.id === selectedEvent?.id ? " is-selected" : ""}`}
                  key={event.id}
                  type="button"
                  aria-pressed={event.id === selectedEvent?.id}
                  onClick={() => selectEvent(event.id)}
                >
                  <span className="memorial-corner" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <span className="memorial-card-head">
                    <span>{event.routing.primary ? `主送${MINISTRY_LABELS[event.routing.primary]}` : "待分流"}</span>
                    <time dateTime={event.lastUpdateAt}>{formatRelativeTime(event.lastUpdateAt)}</time>
                  </span>
                  <strong>{event.title}</strong>
                  <span className="memorial-card-summary">{event.oneLiner || "材料正在由中书省整理为可审议主张。"}</span>
                  <span className="memorial-card-foot">
                    {event.workflowStatus ? <WorkflowStatusBadge status={event.workflowStatus} /> : <span>尚未入案</span>}
                    <span>{event.articleCount} 篇材料 · {event.confirmedCount} 项确认 · {event.disputedCount} 项争议</span>
                  </span>
                </button>
              )) : <EmptyState title="当前筛选下没有奏折" description="切换办理状态，或等待调度器递送新的审议结果。" />}
            </div>
            <footer className="memorial-list-footer"><Link href="/live">进入实时事件簿</Link><span>点击奏折在右侧展开批红</span></footer>
          </section>

          <section className="court-pane review-pane" data-pane="review" aria-label="奏议与审计">
            {selectedEvent ? (
              <>
                <PaneHeader
                  kicker="批红 / REVIEW"
                  title={selectedEvent.title}
                  subtitle={`${selectedEvent.countries.join("、") || "未标明地区"} · ${selectedEvent.topics.join(" / ") || "待归类"}`}
                  action={(
                    <div className="review-actions">
                      <div className="review-stepper" role="group" aria-label="连续审阅奏折">
                        <button type="button" onClick={() => moveSelection(-1)} disabled={selectedIndex <= 0} aria-label="上一件奏折" title="上一件奏折">←</button>
                        <span>{selectedIndex + 1}/{visibleEvents.length}</span>
                        <button type="button" onClick={() => moveSelection(1)} disabled={selectedIndex < 0 || selectedIndex >= visibleEvents.length - 1} aria-label="下一件奏折" title="下一件奏折">→</button>
                      </div>
                      <Link className="review-open-link" href={`/events/${encodeURIComponent(selectedEvent.id)}`}>全案 ↗</Link>
                    </div>
                  )}
                />
                <div className="review-context-strip">
                  <span>{selectedEvent.oneLiner || "尚无成句摘要，右侧显示当前证据和工作流产物。"}</span>
                  <span>最后更新 {formatRelativeTime(selectedEvent.lastUpdateAt)}</span>
                </div>
                {auditState.loading && !auditState.data ? <LoadingState label="正在调取奏议与六部具报" /> : null}
                {auditState.error && !auditState.data ? <ErrorState error={auditState.error} onRetry={auditState.reload} title="无法读取该案审计记录" /> : null}
                {auditState.data ? <WorkflowAuditPanel data={auditState.data} /> : null}
              </>
            ) : (
              <EmptyState title="选择一件奏折" description="从中间队列选择事件，右侧会展开中书奏议、门下批红、尚书执行令和六部具报。" />
            )}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function PaneHeader({ kicker, title, subtitle, action }: { kicker: string; title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <header className="court-pane-header">
      <div><p className="eyebrow">{kicker}</p><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
      {action ? <div className="court-pane-action">{action}</div> : null}
    </header>
  );
}

function MinistryIndexFold({ summary }: { summary: WorkflowDashboardDTO["ministries"][number] }) {
  return (
    <Link className="ministry-index-fold" href={`/ministries/${MINISTRY_SLUGS[summary.ministry]}`}>
      <MinistrySeal ministry={summary.ministry} size="sm" decorative />
      <span><strong>{MINISTRY_LABELS[summary.ministry]}</strong><small>{MINISTRY_DESCRIPTIONS[summary.ministry]}</small></span>
      <b>{summary.activeEvents}</b>
    </Link>
  );
}
