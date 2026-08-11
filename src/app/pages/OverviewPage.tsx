import { useEffect } from "react";
import { Link } from "wouter";
import type { StatsDTO, WorkflowDashboardDTO } from "../../shared/types";
import { API_ROUTES, unwrapItem, useApi } from "../api";
import { GovernanceTrace } from "../components/governance";
import {
  EmptyState,
  ErrorState,
  EventCard,
  LoadingState,
  PageHeader,
  RefreshButton,
  SectionHeader,
  StatTile,
  VisualRefreshFrame,
} from "../components/ui";
import { formatDateTime, formatNumber } from "../utils";
import { usePreferences } from "../preferences";

export function OverviewPage() {
  const { timeZone } = usePreferences();
  const statsState = useApi<StatsDTO | { data: StatsDTO }>(API_ROUTES.stats);
  const workflowState = useApi<WorkflowDashboardDTO>(API_ROUTES.workflow);
  const stats = unwrapItem(statsState.data);
  const workflow = workflowState.data;
  const refreshing = statsState.refreshing || workflowState.refreshing;

  useEffect(() => {
    document.title = "中枢总览 · 新闻雷达";
  }, []);

  const refresh = () => {
    statsState.reload();
    workflowState.reload();
  };

  return (
    <div className="page page-overview">
      <PageHeader
        eyebrow="中枢总览 / NEWS CABINET"
        title="从证据入案，到审议呈递"
        description="当前桌面只汇总已经进入三省审议的事件；封驳项继续补证，完成项进入实时呈递与每日简报。"
        actions={<RefreshButton refreshing={refreshing} onClick={refresh} />}
      />

      {(statsState.loading || workflowState.loading) && !stats && !workflow ? (
        <LoadingState label="正在汇合采集与审议态势" />
      ) : null}
      {(statsState.error || workflowState.error) && !stats && !workflow ? (
        <ErrorState error={statsState.error || workflowState.error!} onRetry={refresh} title="无法读取中枢态势" />
      ) : null}

      {stats || workflow ? (
        <VisualRefreshFrame refreshing={refreshing}>
          <section className="overview-status-band" aria-label="当前呈递态势">
            <div>
              <p className="eyebrow">CURRENT CUTOFF</p>
              <strong>{workflow ? formatDateTime(workflow.cutoff, timeZone) : "正在同步"}</strong>
              <span>规则 {workflow?.rulesVersion || "待载入"}</span>
            </div>
            <dl>
              <div><dt>门下待审</dt><dd>{formatNumber(workflow?.stages.menxia.awaitingReview || 0)}</dd></div>
              <div><dt>封驳补证</dt><dd>{formatNumber(workflow?.stages.menxia.remanded || 0)}</dd></div>
              <div><dt>24h 完成呈递</dt><dd>{formatNumber(workflow?.stages.shangshu.completed24h || 0)}</dd></div>
            </dl>
            <Link className="button button-primary" href="/workflow">打开三省六部汇总</Link>
          </section>

          {stats ? (
            <section className="stat-grid" aria-label="采集与事件概况">
              <StatTile label="24 小时新增文章" value={stats.articles24h} note="去重后入库" />
              <StatTile label="24 小时新增事件" value={stats.events24h} note="聚合成案" tone="accent" />
              <StatTile label="审议后活跃事件" value={stats.activeEvents} note="实时桌面范围" tone="evidence" />
              <StatTile label="健康来源" value={stats.sourceHealth.ok} note={`共 ${formatNumber(stats.sourceHealth.total)} 个来源`} />
            </section>
          ) : null}
        </VisualRefreshFrame>
      ) : null}

      <section className="content-section" aria-labelledby="overview-deliveries-title">
        <SectionHeader
          id="overview-deliveries-title"
          eyebrow="今日呈递"
          title="最新审议事件"
          description="这里与实时事件页共享后端审议快照，不另行生成摘要或状态。"
          actions={<Link className="text-link" href="/live">查看全部实时事件 <span aria-hidden="true">→</span></Link>}
        />
        {stats?.topEvents.length ? (
          <div className="event-grid overview-event-grid">
            {stats.topEvents.slice(0, 4).map((event, index) => (
              <EventCard
                key={event.id}
                event={event}
                featured={index === 0}
                routing={
                  <GovernanceTrace
                    snapshot={event.governance}
                    sources={event.sourceTrail}
                    unverifiedCount={event.unverifiedCount}
                  />
                }
              />
            ))}
          </div>
        ) : stats ? (
          <EmptyState title="尚无完成审议的事件" description="门下完成首批复核后，准奏与封驳案件会在这里形成统一呈递。" />
        ) : null}
      </section>
    </div>
  );
}
