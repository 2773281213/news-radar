import { useEffect, useMemo, useState } from "react";
import type {
  FetchLogDTO,
  SourceDTO,
  SourceHealth,
  SourceHealthSummary,
  StatsDTO,
} from "../../shared/types";
import { CATEGORY_LABELS, HEALTH_LABELS } from "../../shared/constants";
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
  Badge,
  EmptyState,
  ErrorState,
  ExternalLink,
  HealthBadge,
  LoadingState,
  Notice,
  PageHeader,
  Panel,
  PercentBar,
  RefreshButton,
  SectionHeader,
  SourceHealthPanel,
  StatTile,
  TableFrame,
  VisualRefreshFrame,
} from "../components/ui";
import {
  formatDateTime,
  formatNumber,
  getHostname,
  sourceCategoryLabel,
} from "../utils";

const HEALTH_OPTIONS: Array<"all" | SourceHealth> = [
  "all",
  "ok",
  "degraded",
  "failing",
  "disabled",
  "unknown",
];

function deriveHealthSummary(sources: SourceDTO[]): SourceHealthSummary {
  const summary: SourceHealthSummary = {
    total: sources.length,
    ok: 0,
    degraded: 0,
    failing: 0,
    disabled: 0,
    unknown: 0,
    byCategory: {},
  };

  sources.forEach((source) => {
    summary[source.health] += 1;
    summary.byCategory[source.category] = (summary.byCategory[source.category] ?? 0) + 1;
  });
  return summary;
}

function SourceTable({ sources }: { sources: SourceDTO[] }) {
  const { timeZone } = usePreferences();
  return (
    <TableFrame label="来源目录">
      <table className="source-table">
        <caption>已注册来源及其采集状态</caption>
        <thead>
          <tr>
            <th scope="col">来源</th>
            <th scope="col">类别</th>
            <th scope="col">适配器</th>
            <th scope="col">身份核验</th>
            <th scope="col">健康</th>
            <th scope="col">最近成功</th>
            <th scope="col">连续失败</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((source) => (
            <tr key={source.id}>
              <th scope="row">
                <div className="source-name-cell">
                  {source.homepage ? <ExternalLink href={source.homepage}>{source.name}</ExternalLink> : <span>{source.name}</span>}
                  <small>
                    {source.country || "地区未标注"} · {source.lang || "语言未标注"}
                    {!source.enabled ? " · 已停用" : ""}
                  </small>
                </div>
              </th>
              <td>{sourceCategoryLabel(source.category)}</td>
              <td>
                <code>{source.adapter}</code>
                {source.feedUrl ? <small>{getHostname(source.feedUrl)}</small> : null}
              </td>
              <td>
                <Badge tone={source.verifStatus === "verified" ? "good" : source.verifStatus === "pending" ? "warning" : "neutral"}>
                  {source.verifStatus === "verified" ? "已核验" : source.verifStatus === "pending" ? "待复核" : "未核验"}
                </Badge>
              </td>
              <td><HealthBadge health={source.health} /></td>
              <td>{formatDateTime(source.lastSuccessAt, timeZone)}</td>
              <td>{formatNumber(source.consecFails)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

function FetchLogTable({ logs }: { logs: FetchLogDTO[] }) {
  const { timeZone } = usePreferences();
  return (
    <TableFrame label="最近采集日志">
      <table>
        <caption>最近的来源采集运行结果</caption>
        <thead>
          <tr>
            <th scope="col">开始时间</th>
            <th scope="col">来源</th>
            <th scope="col">结果</th>
            <th scope="col">HTTP</th>
            <th scope="col">发现</th>
            <th scope="col">新增</th>
            <th scope="col">耗时</th>
            <th scope="col">错误</th>
          </tr>
        </thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.id}>
              <td>{formatDateTime(log.startedAt, timeZone)}</td>
              <th scope="row">{log.sourceName || log.sourceId}</th>
              <td><Badge tone={log.ok ? "good" : "danger"}>{log.ok ? "成功" : "失败"}</Badge></td>
              <td>{log.httpStatus ?? "—"}</td>
              <td>{formatNumber(log.found)}</td>
              <td>{formatNumber(log.added)}</td>
              <td>{formatNumber(log.ms)} ms</td>
              <td className="error-cell">{log.error || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </TableFrame>
  );
}

export function SourcesPage() {
  const [query, setQuery] = useState("");
  const [health, setHealth] = useState<"all" | SourceHealth>("all");
  const [category, setCategory] = useState("all");
  const sourcesState = useApi<CollectionEnvelope<SourceDTO>>(API_ROUTES.sources);
  const statsState = useApi<StatsDTO | { data: StatsDTO }>(API_ROUTES.stats);
  const logsState = useApi<CollectionEnvelope<FetchLogDTO>>(withQuery(API_ROUTES.fetchLogs, { limit: 80 }));
  const sources = unwrapCollection(sourcesState.data);
  const stats = unwrapItem(statsState.data);
  const healthSummary = stats?.sourceHealth ?? deriveHealthSummary(sources);

  useEffect(() => {
    document.title = "来源中心 · 新闻雷达";
  }, []);

  const categories = useMemo(
    () => Array.from(new Set(sources.map((source) => source.category))).sort(),
    [sources],
  );
  const filteredSources = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return sources
      .filter((source) => health === "all" || source.health === health)
      .filter((source) => category === "all" || source.category === category)
      .filter((source) => {
        if (!needle) return true;
        return [source.name, source.owner, source.country, source.lang, source.homepage, source.feedUrl]
          .filter(Boolean)
          .some((value) => String(value).toLocaleLowerCase("zh-CN").includes(needle));
      })
      .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }, [category, health, query, sources]);

  const categoryRows = Object.entries(healthSummary.byCategory).sort((a, b) => b[1] - a[1]);
  const maxCategory = Math.max(1, ...categoryRows.map(([, value]) => value));
  const logs = unwrapCollection(logsState.data);
  const refreshing = sourcesState.refreshing || statsState.refreshing || logsState.refreshing;

  const refresh = () => {
    sourcesState.reload();
    statsState.reload();
    logsState.reload();
  };

  return (
    <div className="page page-sources">
      <PageHeader
        eyebrow="来源中心 / SOURCE DESK"
        title="知道消息从哪里来，也知道采集哪里出了问题"
        description="来源身份、所有权、核验状态与采集健康度分开呈现；健康并不等于可信，失败也不等于内容错误。"
        actions={<RefreshButton refreshing={refreshing} onClick={refresh} />}
      />

      {sourcesState.loading && !sources.length ? <LoadingState label="正在读取来源目录" /> : null}
      {sourcesState.error && !sources.length ? (
        <ErrorState error={sourcesState.error} onRetry={sourcesState.reload} title="无法读取来源中心" />
      ) : null}

      {sources.length || stats ? (
        <VisualRefreshFrame refreshing={sourcesState.refreshing || statsState.refreshing}>
          <section className="source-overview-grid" aria-label="来源概览">
            <SourceHealthPanel summary={healthSummary} />
            <Panel className="category-panel">
              <SectionHeader
                eyebrow="来源构成"
                title="类别分布"
                description="条长仅比较来源数量，所有类别使用同一强调色。"
              />
              <div className="category-bars">
                {categoryRows.slice(0, 8).map(([key, value]) => (
                  <PercentBar key={key} label={sourceCategoryLabel(key)} value={value} max={maxCategory} />
                ))}
              </div>
              <details className="table-disclosure">
                <summary>查看类别数据表</summary>
                <TableFrame label="来源类别数据表">
                  <table>
                    <caption>各来源类别数量</caption>
                    <thead><tr><th scope="col">类别</th><th scope="col">数量</th></tr></thead>
                    <tbody>
                      {categoryRows.map(([key, value]) => (
                        <tr key={key}><th scope="row">{sourceCategoryLabel(key)}</th><td>{value}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </TableFrame>
              </details>
            </Panel>
          </section>

          <section className="stat-grid" aria-label="来源状态统计">
            <StatTile label="全部来源" value={healthSummary.total} />
            <StatTile label="已启用" value={sources.filter((source) => source.enabled).length} />
            <StatTile label="第一手来源" value={sources.filter((source) => source.isPrimary).length} tone="evidence" />
            <StatTile label="已验证身份" value={sources.filter((source) => source.verifStatus === "verified").length} tone="accent" />
          </section>
        </VisualRefreshFrame>
      ) : null}

      <section className="content-section" aria-labelledby="source-directory-title">
        <SectionHeader
          id="source-directory-title"
          eyebrow="DIRECTORY"
          title="来源目录"
          description={`当前显示 ${formatNumber(filteredSources.length)} / ${formatNumber(sources.length)} 个来源`}
        />
        <div className="source-filters">
          <label>
            <span>筛选来源</span>
            <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名称、所有者、地区或域名" />
          </label>
          <label>
            <span>健康状态</span>
            <select value={health} onChange={(event) => setHealth(event.target.value as "all" | SourceHealth)}>
              {HEALTH_OPTIONS.map((value) => (
                <option key={value} value={value}>{value === "all" ? "全部状态" : HEALTH_LABELS[value]}</option>
              ))}
            </select>
          </label>
          <label>
            <span>来源类别</span>
            <select value={category} onChange={(event) => setCategory(event.target.value)}>
              <option value="all">全部类别</option>
              {categories.map((value) => (
                <option key={value} value={value}>{CATEGORY_LABELS[value]}</option>
              ))}
            </select>
          </label>
        </div>

        {filteredSources.length ? (
          <SourceTable sources={filteredSources} />
        ) : sources.length ? (
          <EmptyState title="没有匹配来源" description="调整名称、健康状态或类别筛选后再试。" />
        ) : !sourcesState.loading && !sourcesState.error ? (
          <EmptyState title="来源目录为空" description="后端注册真实来源后，身份与采集状态会显示在这里。" />
        ) : null}
      </section>

      <section className="content-section" aria-labelledby="fetch-log-title">
        <SectionHeader
          id="fetch-log-title"
          eyebrow="INGEST LOG"
          title="最近采集运行"
          description="日志只反映抓取过程；内容核验状态由独立证据链另行判断。"
        />
        {logsState.loading && !logs.length ? <LoadingState label="正在读取采集日志" /> : null}
        {logsState.error && !logs.length ? (
          <Notice tone="warning" title="采集日志尚未接通"><p>{logsState.error.message}</p></Notice>
        ) : null}
        {logs.length ? <FetchLogTable logs={logs} /> : !logsState.loading && !logsState.error ? (
          <EmptyState title="尚无采集日志" description="采集器完成第一次运行后，这里会显示真实执行记录。" />
        ) : null}
      </section>
    </div>
  );
}
