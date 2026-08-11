import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import type { RoutedEventItem, StatsDTO } from "../../shared/types";
import { EVENT_TABS } from "../../shared/constants";
import {
  API_ROUTES,
  type CollectionEnvelope,
  unwrapCollection,
  unwrapItem,
  useApi,
  withQuery,
} from "../api";
import { usePreferences } from "../preferences";
import {
  EmptyState,
  ErrorState,
  EventCard,
  LoadingState,
  Notice,
  PageHeader,
  RefreshButton,
  SectionHeader,
  SourceHealthPanel,
  StatTile,
  TableFrame,
  VisualRefreshFrame,
} from "../components/ui";
import { GovernanceTrace } from "../components/governance";
import {
  EVENT_STATUS_LABELS,
  eventMatchesTab,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
} from "../utils";

export function HomePage() {
  const { timeZone } = usePreferences();
  const [activeTab, setActiveTab] = useState<(typeof EVENT_TABS)[number]["key"]>("breaking");
  const statsState = useApi<StatsDTO | { data: StatsDTO }>(API_ROUTES.stats);
  const eventsState = useApi<CollectionEnvelope<RoutedEventItem>>(
    withQuery(API_ROUTES.events, { limit: 80 }),
  );
  const stats = unwrapItem(statsState.data);
  const events = unwrapCollection(eventsState.data);
  const availableEvents = events.length ? events : stats?.topEvents ?? [];
  const visibleEvents = useMemo(
    () => availableEvents.filter((event) => eventMatchesTab(event, activeTab)),
    [activeTab, availableEvents],
  );
  const refreshing = statsState.refreshing || eventsState.refreshing;

  useEffect(() => {
    document.title = "实时事件 · 新闻雷达";
  }, []);

  const refreshAll = () => {
    statsState.reload();
    eventsState.reload();
  };

  return (
    <div className="page page-home">
      <PageHeader
        eyebrow="实时事件 / LIVE DESK"
        title="每条事件先审议，再呈递"
        description="实时聚合事件、独立来源与待核实说法；所有结论都回到时间戳和原始链接。"
        actions={<RefreshButton refreshing={refreshing} onClick={refreshAll} />}
      />

      {statsState.loading ? <LoadingState label="正在读取编辑部态势" /> : null}
      {statsState.error && !stats ? (
        <Notice tone="warning" title="态势统计尚未接通">
          <p>{statsState.error.message} 事件流仍会独立尝试读取。</p>
        </Notice>
      ) : null}

      {stats ? (
        <VisualRefreshFrame refreshing={statsState.refreshing}>
          <section className="hero-grid" aria-label="核心态势指标">
            <article className="hero-figure-card">
              <p className="eyebrow">ACTIVE EVENTS</p>
              <strong className="hero-figure">{formatNumber(stats.activeEvents)}</strong>
              <h2>个事件正在跟踪</h2>
              <p>
                最近采集：
                <time dateTime={stats.lastIngestAt || undefined} title={formatDateTime(stats.lastIngestAt, timeZone)}>
                  {formatRelativeTime(stats.lastIngestAt)}
                </time>
              </p>
              <Link className="text-link" href="/search">
                进入搜索与追踪 <span aria-hidden="true">→</span>
              </Link>
            </article>
            <SourceHealthPanel summary={stats.sourceHealth} />
          </section>

          <section className="stat-grid" aria-label="过去二十四小时统计">
            <StatTile label="24 小时新增文章" value={stats.articles24h} note="采集后去重入库" />
            <StatTile label="24 小时新增事件" value={stats.events24h} note="聚类形成的新事件" tone="accent" />
            <StatTile label="健康来源" value={stats.sourceHealth.ok} note={`共 ${formatNumber(stats.sourceHealth.total)} 个来源`} />
            <StatTile
              label="异常来源"
              value={stats.sourceHealth.degraded + stats.sourceHealth.failing}
              note="波动与失败合计"
              tone="evidence"
            />
          </section>
        </VisualRefreshFrame>
      ) : null}

      <section className="content-section" aria-labelledby="event-stream-title">
        <SectionHeader
          id="event-stream-title"
          eyebrow="事件流"
          title="正在形成的事实版图"
          description="栏目只改变当前视图，不改变事件本身的证据状态。"
          actions={
            <Link className="text-link" href="/briefings">
              查看每日简报 <span aria-hidden="true">→</span>
            </Link>
          }
        />

        <div className="filter-strip" role="group" aria-label="事件栏目">
          {EVENT_TABS.map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={activeTab === tab.key ? "is-active" : undefined}
              aria-pressed={activeTab === tab.key}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {eventsState.loading && !availableEvents.length ? <LoadingState label="正在组织事件流" /> : null}
        {eventsState.error && !availableEvents.length ? (
          <ErrorState error={eventsState.error} onRetry={eventsState.reload} />
        ) : null}

        {availableEvents.length ? (
          <VisualRefreshFrame refreshing={eventsState.refreshing}>
            {visibleEvents.length ? (
              <div className="event-grid">
                {visibleEvents.map((event, index) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    featured={index === 0 && activeTab === "breaking"}
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
            ) : (
              <EmptyState
                title="这个栏目暂时没有事件"
                description="当前实时数据中没有符合栏目条件的事件，可以切换栏目或稍后刷新。"
              />
            )}

            <details className="table-disclosure wide-disclosure">
              <summary>查看事件流数据表</summary>
              <TableFrame label="事件流数据表">
                <table>
                  <caption>当前栏目事件列表</caption>
                  <thead>
                    <tr>
                      <th scope="col">事件</th>
                      <th scope="col">状态</th>
                      <th scope="col">热度</th>
                      <th scope="col">文章</th>
                      <th scope="col">独立来源</th>
                      <th scope="col">已确认</th>
                      <th scope="col">待核实</th>
                      <th scope="col">争议</th>
                      <th scope="col">审议</th>
                      <th scope="col">最近更新</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleEvents.map((event) => (
                      <tr key={event.id}>
                        <th scope="row">
                          <Link href={`/events/${encodeURIComponent(event.id)}`}>{event.title}</Link>
                        </th>
                        <td>{EVENT_STATUS_LABELS[event.status]}</td>
                        <td>{formatNumber(event.heat)}</td>
                        <td>{formatNumber(event.articleCount)}</td>
                        <td>{formatNumber(event.independentSourceCount)}</td>
                        <td>{formatNumber(event.confirmedCount)}</td>
                        <td>{formatNumber(event.unverifiedCount)}</td>
                        <td>{formatNumber(event.disputedCount)}</td>
                        <td>{event.publishable ? "完成呈递" : event.workflowStatus === "remanded" ? "封驳补证" : "审议中"}</td>
                        <td>{formatDateTime(event.lastUpdateAt, timeZone)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableFrame>
            </details>
          </VisualRefreshFrame>
        ) : null}
      </section>
    </div>
  );
}
