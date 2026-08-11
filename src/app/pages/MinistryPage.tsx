import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import type { MinistryCode, MinistryWorkReportDTO, RoutedEventItem } from "../../shared/types";
import {
  MINISTRY_DESCRIPTIONS,
  MINISTRY_LABELS,
  MINISTRY_SLUGS,
} from "../../shared/constants";
import { API_ROUTES, useApi } from "../api";
import { usePreferences } from "../preferences";
import { formatDateTime } from "../utils";
import { MinistryReportCard, MinistrySeal, RoutingByline } from "../components/governance";
import {
  EmptyState,
  ErrorState,
  EventCard,
  LoadingState,
  Notice,
  PageHeader,
  RefreshButton,
  SectionHeader,
  StatTile,
  VisualRefreshFrame,
} from "../components/ui";

interface MinistryResponse {
  ministry: MinistryCode;
  stats: {
    ministry: MinistryCode;
    activeEvents: number;
    updates24h: number;
    remanded: number;
    disputedClaims: number;
  };
  reports: MinistryWorkReportDTO[];
  items: RoutedEventItem[];
  total: number;
  cutoff: string;
}

const MINISTRY_BY_SLUG = new Map<string, MinistryCode>(
  Object.entries(MINISTRY_SLUGS).map(([ministry, slug]) => [slug, ministry as MinistryCode])
);

export function MinistryPage({ slug }: { slug: string }) {
  const { timeZone } = usePreferences();
  const ministry = MINISTRY_BY_SLUG.get(slug);
  const [view, setView] = useState<"all" | "remanded" | "disputed">("all");
  const state = useApi<MinistryResponse>(ministry ? API_ROUTES.ministry(slug) : null);
  const data = state.data;
  const visible = useMemo(() => {
    if (!data) return [];
    if (view === "remanded") return data.items.filter((item) => item.workflowStatus === "remanded");
    if (view === "disputed") return data.items.filter((item) => item.disputedCount > 0);
    return data.items;
  }, [data, view]);
  const visibleReports = useMemo(() => {
    if (!data) return [];
    const visibleIds = new Set(visible.map((item) => item.id));
    return (data.reports || []).filter((report) => visibleIds.has(report.eventId));
  }, [data, visible]);
  const eventTitles = useMemo(() => new Map((data?.items || []).map((item) => [item.id, item.title])), [data]);

  useEffect(() => {
    document.title = ministry ? `${MINISTRY_LABELS[ministry]} · 新闻雷达` : "部门不存在 · 新闻雷达";
  }, [ministry]);

  if (!ministry) {
    return (
      <div className="page ministry-page">
        <EmptyState
          title="没有这个部门"
          description="部门链接可能已失效，请回到三省六部工作流选择有效入口。"
          action={<Link className="button button-primary" href="/workflow">返回中枢</Link>}
        />
      </div>
    );
  }

  return (
    <div className="page ministry-page">
      <nav className="breadcrumbs" aria-label="面包屑">
        <Link href="/workflow">三省六部</Link>
        <span aria-hidden="true">/</span>
        <span>{MINISTRY_LABELS[ministry]}</span>
      </nav>

      <div className="ministry-hero">
        <MinistrySeal ministry={ministry} size="lg" decorative />
        <PageHeader
          eyebrow={`${MINISTRY_SLUGS[ministry]} / MINISTRY DESK`}
          title={`${MINISTRY_LABELS[ministry]}工作台`}
          description={MINISTRY_DESCRIPTIONS[ministry]}
          actions={<RefreshButton refreshing={state.refreshing} onClick={state.reload} />}
        />
      </div>

      <nav className="ministry-switcher" aria-label="切换六部">
        {(Object.keys(MINISTRY_LABELS) as MinistryCode[]).map((item) => (
          <Link
            key={item}
            href={`/ministries/${MINISTRY_SLUGS[item]}`}
            aria-current={item === ministry ? "page" : undefined}
            className={item === ministry ? "is-active" : undefined}
          >
            <MinistrySeal ministry={item} size="sm" decorative />
            <span>{MINISTRY_LABELS[item]}</span>
          </Link>
        ))}
      </nav>

      {state.loading && !data ? <LoadingState label={`正在读取${MINISTRY_LABELS[ministry]}案卷`} /> : null}
      {state.error && !data ? <ErrorState error={state.error} onRetry={state.reload} title="无法读取部门工作台" /> : null}

      {data ? (
        <VisualRefreshFrame refreshing={state.refreshing}>
          <div className="ministry-cutoff">
            <span>自动分流，不代表人工定责</span>
            <time dateTime={data.cutoff}>信息截至 {formatDateTime(data.cutoff, timeZone)}</time>
          </div>

          <section className="stat-grid" aria-label={`${MINISTRY_LABELS[ministry]}统计`}>
            <StatTile label="在办事件" value={data.stats.activeEvents} tone="accent" />
            <StatTile label="24 小时更新" value={data.stats.updates24h} />
            <StatTile label="门下封驳" value={data.stats.remanded} tone="evidence" />
            <StatTile label="争议主张" value={data.stats.disputedClaims} />
          </section>

          {data.stats.remanded > 0 ? (
            <Notice tone="warning" title="存在证据缺口">
              <p>封驳事件仍可阅读原始材料，但不会越过门下审议直接进入治理后简报与提醒。</p>
            </Notice>
          ) : null}

          <section className="content-section ministry-report-desk" aria-labelledby="ministry-reports-title">
            <SectionHeader
              id="ministry-reports-title"
              eyebrow="真实后端产物 / WORK REPORTS"
              title={`${MINISTRY_LABELS[ministry]}具报`}
              description="这里只展示该部在后端专责分析中持久化的发现、风险、补证动作与文章级引用；没有报告时不会用新闻卡片冒充。"
            />
            {visibleReports.length ? (
              <div className="ministry-report-desk-grid">
                {visibleReports.map((report) => (
                  <MinistryReportCard
                    key={`${report.runId}-${report.ministry}-${report.attempt}`}
                    report={report}
                    eventTitle={eventTitles.get(report.eventId)}
                  />
                ))}
              </div>
            ) : (
              <EmptyState title="当前筛选下尚无本部具报" description="旧案或门下封驳案件可能只有分派记录；新规则完成执行后会在这里出现可审计报告。" />
            )}
          </section>

          <section className="content-section" aria-labelledby="ministry-events-title">
            <SectionHeader
              id="ministry-events-title"
              eyebrow="部门案卷"
              title="分流事件"
              description="一件事件可以同时出现在多个部门；主送部门负责首要职责，会同部门保留协作视角。"
            />
            <div className="filter-strip" role="group" aria-label="部门事件筛选">
              {([
                ["all", "全部"],
                ["remanded", "门下封驳"],
                ["disputed", "存在争议"],
              ] as const).map(([key, label]) => (
                <button key={key} type="button" className={view === key ? "is-active" : undefined} aria-pressed={view === key} onClick={() => setView(key)}>
                  {label}
                </button>
              ))}
            </div>
            {visible.length ? (
              <div className="event-grid">
                {visible.map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    routing={
                      <RoutingByline
                        primary={event.routing.primary}
                        collaborators={event.routing.collaborators}
                        reasons={event.routing.reasons}
                        status={event.workflowStatus}
                      />
                    }
                  />
                ))}
              </div>
            ) : (
              <EmptyState title="当前筛选下没有案卷" description="切换筛选条件，或等待新的事件完成自动分流。" />
            )}
          </section>
        </VisualRefreshFrame>
      ) : null}
    </div>
  );
}
