import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  ReactNode,
} from "react";
import { Link } from "wouter";
import type {
  Citation,
  ClaimStatus,
  EventListItem,
  SourceHealth,
  SourceHealthSummary,
} from "../../shared/types";
import { CLAIM_STATUS_LABELS, HEALTH_LABELS } from "../../shared/constants";
import type { ApiRequestError } from "../api";
import { usePreferences } from "../preferences";
import {
  CLAIM_STATUS_TONES,
  EVENT_STATUS_LABELS,
  HEALTH_TONES,
  TRACK_MODE_LABELS,
  clamp,
  cx,
  formatCompactNumber,
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  getHostname,
  safeExternalUrl,
  sourceCategoryLabel,
  topicLabel,
  uniqueById,
} from "../utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="page-header">
      <div className="page-header-copy">
        <p className="eyebrow">{eyebrow}</p>
        <h1>{title}</h1>
        {description ? <div className="page-lead">{description}</div> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </header>
  );
}

export function SectionHeader({
  eyebrow,
  title,
  description,
  actions,
  id,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  id?: string;
}) {
  return (
    <header className="section-header">
      <div>
        {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
        <h2 id={id}>{title}</h2>
        {description ? <div className="section-description">{description}</div> : null}
      </div>
      {actions ? <div className="section-actions">{actions}</div> : null}
    </header>
  );
}

export function Panel({ className, ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={cx("panel", className)} {...props} />;
}

export function Button({
  variant = "primary",
  className,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
}) {
  return <button type={type} className={cx("button", `button-${variant}`, className)} {...props} />;
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "good" | "warning" | "danger" | "evidence" | "accent" | "info";
  className?: string;
}) {
  return <span className={cx("badge", `badge-${tone}`, className)}>{children}</span>;
}

export function ClaimStatusBadge({ status }: { status: ClaimStatus }) {
  return <Badge tone={CLAIM_STATUS_TONES[status]}>{CLAIM_STATUS_LABELS[status]}</Badge>;
}

export function HealthBadge({ health }: { health: SourceHealth }) {
  return <Badge tone={HEALTH_TONES[health]}>{HEALTH_LABELS[health]}</Badge>;
}

export function EventStatusBadge({ event }: { event: Pick<EventListItem, "status" | "trackMode"> }) {
  const tone = event.status === "developing" ? "accent" : event.status === "closed" ? "neutral" : "info";
  return (
    <Badge tone={tone}>
      {EVENT_STATUS_LABELS[event.status]} · {TRACK_MODE_LABELS[event.trackMode]}
    </Badge>
  );
}

export function EngineBadge({ engine }: { engine: "ai" | "extractive" }) {
  return <Badge tone={engine === "ai" ? "evidence" : "neutral"}>{engine === "ai" ? "AI 辅助" : "抽取式"}</Badge>;
}

export function LoadingState({ label = "正在读取实时数据" }: { label?: string }) {
  return (
    <div className="state-block loading-state" role="status" aria-live="polite">
      <span className="loading-mark" aria-hidden="true" />
      <div className="loading-copy">
        <strong>{label}</strong>
        <span>保持页面结构，数据返回后自动更新。</span>
      </div>
      <div className="loading-lines" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
  title = "数据暂时不可用",
}: {
  error: ApiRequestError;
  onRetry?: () => void;
  title?: string;
}) {
  const backendMissing = error.status === 404 || error.status === 0;
  return (
    <div className="state-block error-state" role="alert">
      <p className="state-kicker">{backendMissing ? "连接提示" : `HTTP ${error.status}`}</p>
      <h2>{title}</h2>
      <p>{error.message}</p>
      {error.detail ? <p className="state-detail">{error.detail}</p> : null}
      {onRetry ? <Button onClick={onRetry}>重新读取</Button> : null}
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <div className="state-block empty-state">
      <span className="empty-rule" aria-hidden="true" />
      <h2>{title}</h2>
      <p>{description}</p>
      {action ? <div className="state-action">{action}</div> : null}
    </div>
  );
}

export function RefreshButton({ refreshing, onClick }: { refreshing: boolean; onClick: () => void }) {
  return (
    <Button variant="secondary" onClick={onClick} disabled={refreshing} aria-busy={refreshing}>
      {refreshing ? "更新中…" : "刷新数据"}
    </Button>
  );
}

export function StatTile({
  label,
  value,
  note,
  tone = "default",
}: {
  label: string;
  value: number | string;
  note?: ReactNode;
  tone?: "default" | "accent" | "evidence";
}) {
  return (
    <article className={cx("stat-tile", `stat-tile-${tone}`)}>
      <p>{label}</p>
      <strong>{typeof value === "number" ? formatCompactNumber(value) : value}</strong>
      {note ? <div className="stat-note">{note}</div> : null}
    </article>
  );
}

function normalizedScore(value: number): number {
  return clamp(value <= 10 ? value * 10 : value);
}

export function HeatMeter({ heat, heatTrend }: Pick<EventListItem, "heat" | "heatTrend">) {
  const trendLabel = heatTrend === "up" ? "上升" : heatTrend === "down" ? "回落" : "平稳";
  const trendGlyph = heatTrend === "up" ? "↗" : heatTrend === "down" ? "↘" : "→";
  const width = normalizedScore(heat);

  return (
    <div className="heat-meter" aria-label={`事件热度 ${formatNumber(heat)}，趋势${trendLabel}`}>
      <div className="heat-meter-label">
        <span>热度</span>
        <strong>{formatNumber(heat)}</strong>
        <span className={cx("heat-trend", `heat-trend-${heatTrend}`)}>
          <span aria-hidden="true">{trendGlyph}</span> {trendLabel}
        </span>
      </div>
      <div className="meter-track" aria-hidden="true">
        <span className="meter-fill" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

const HEALTH_ORDER: SourceHealth[] = ["ok", "degraded", "failing", "disabled", "unknown"];

export function SourceHealthPanel({ summary }: { summary: SourceHealthSummary }) {
  const total = summary.total || HEALTH_ORDER.reduce((sum, key) => sum + summary[key], 0);

  return (
    <Panel className="source-health-panel" aria-labelledby="source-health-title">
      <SectionHeader
        id="source-health-title"
        eyebrow="采集网络"
        title="来源健康度"
        description={total ? `${formatNumber(total)} 个来源的当前采集状态` : "等待来源注册"}
      />
      <div className="semantic-bars">
        {HEALTH_ORDER.map((health) => {
          const value = summary[health];
          const percentage = total ? (value / total) * 100 : 0;
          return (
            <div className="semantic-bar-row" key={health}>
              <div className="semantic-bar-label">
                <span className={cx("status-dot", `status-dot-${HEALTH_TONES[health]}`)} aria-hidden="true" />
                <span>{HEALTH_LABELS[health]}</span>
                <strong>{formatNumber(value)}</strong>
              </div>
              <div
                className="semantic-track"
                role="img"
                aria-label={`${HEALTH_LABELS[health]} ${formatNumber(value)} 个，占 ${Math.round(percentage)}%`}
              >
                <span
                  className={cx("semantic-fill", `semantic-fill-${HEALTH_TONES[health]}`)}
                  style={{ width: `${clamp(percentage)}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
      <details className="table-disclosure">
        <summary>查看来源健康数据表</summary>
        <div className="table-scroll">
          <table>
            <caption>来源健康状态明细</caption>
            <thead>
              <tr>
                <th scope="col">状态</th>
                <th scope="col">来源数</th>
                <th scope="col">占比</th>
              </tr>
            </thead>
            <tbody>
              {HEALTH_ORDER.map((health) => {
                const value = summary[health];
                return (
                  <tr key={health}>
                    <th scope="row">{HEALTH_LABELS[health]}</th>
                    <td>{formatNumber(value)}</td>
                    <td>{total ? `${Math.round((value / total) * 100)}%` : "0%"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </details>
    </Panel>
  );
}

export function ExternalLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  const safe = safeExternalUrl(href);
  if (!safe) return <span className={className}>{children}</span>;
  return (
    <a className={className} href={safe} target="_blank" rel="noreferrer">
      {children} <span aria-hidden="true">↗</span>
      <span className="sr-only">（在新窗口打开）</span>
    </a>
  );
}

export function CitationList({
  citations,
  heading = "引用来源",
  idPrefix = "citation",
  compact = false,
}: {
  citations: Citation[];
  heading?: string;
  idPrefix?: string;
  compact?: boolean;
}) {
  const unique = uniqueById(citations.map((citation) => ({ ...citation, id: citation.articleId })));
  if (!unique.length) return null;

  return (
    <section className={cx("citation-section", compact && "citation-section-compact")} aria-label={heading}>
      <h3>{heading}</h3>
      <ol className="citation-list">
        {unique.map((citation, index) => (
          <li id={`${idPrefix}-${index + 1}`} key={citation.articleId}>
            <span className="citation-index">[{index + 1}]</span>
            <div>
              <ExternalLink href={citation.url} className="citation-title">
                {citation.title}
              </ExternalLink>
              <p>
                {citation.sourceName} · {getHostname(citation.url)}
                {citation.publishedAt ? ` · ${formatRelativeTime(citation.publishedAt)}` : ""}
              </p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

export function InlineCitations({ citations }: { citations: Citation[] }) {
  if (!citations.length) return null;
  return (
    <span className="inline-citations" aria-label="相关引用">
      {citations.map((citation, index) => (
        <ExternalLink key={citation.articleId} href={citation.url} className="inline-citation">
          [{index + 1}] {citation.sourceName}
        </ExternalLink>
      ))}
    </span>
  );
}

export function EventCard({ event, featured = false, routing }: { event: EventListItem; featured?: boolean; routing?: ReactNode }) {
  const { timeZone } = usePreferences();
  return (
    <article className={cx("event-card", featured && "event-card-featured")}>
      <div className="event-card-topline">
        <EventStatusBadge event={event} />
        <time dateTime={event.lastUpdateAt} title={formatDateTime(event.lastUpdateAt, timeZone)}>
          {formatRelativeTime(event.lastUpdateAt)}更新
        </time>
      </div>
      <h3>
        <Link href={`/events/${encodeURIComponent(event.id)}`}>{event.title}</Link>
      </h3>
      <span className="event-content-label">新闻主要内容</span>
      <p className="event-summary">{event.oneLiner || "摘要尚未形成，事件材料仍在归并。"}</p>
      {event.sourceTrail[0] ? (
        <div className="event-best-report">
          <span>最高可信报道</span>
          <ExternalLink href={event.sourceTrail[0].url}>{event.sourceTrail[0].title}</ExternalLink>
          <small>{event.sourceTrail[0].sourceName} · {sourceCategoryLabel(event.sourceTrail[0].sourceCategory)}</small>
        </div>
      ) : null}
      {event.topics.length || event.countries.length ? (
        <div className="tag-row" aria-label="事件标签">
          {event.topics.slice(0, 4).map((topic) => (
            <span className="topic-tag" key={topic}>
              {topicLabel(topic)}
            </span>
          ))}
          {event.countries.slice(0, 3).map((country) => (
            <span className="country-tag" key={country}>
              {country}
            </span>
          ))}
        </div>
      ) : null}
      {routing}
      <HeatMeter heat={event.heat} heatTrend={event.heatTrend} />
      <dl className="event-signals">
        <div>
          <dt>独立来源</dt>
          <dd>{formatNumber(event.independentSourceCount || 0)}</dd>
        </div>
        <div>
          <dt>报道</dt>
          <dd>{formatNumber(event.articleCount)}</dd>
        </div>
        <div className="signal-confirmed">
          <dt>已确认</dt>
          <dd>{formatNumber(event.confirmedCount)}</dd>
        </div>
        <div className="signal-gap">
          <dt>待核实</dt>
          <dd>{formatNumber(event.unverifiedCount || 0)}</dd>
        </div>
        <div className="signal-disputed">
          <dt>争议</dt>
          <dd>{formatNumber(event.disputedCount)}</dd>
        </div>
      </dl>
    </article>
  );
}

export function TableFrame({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="table-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

export function FormField({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="form-field">
      <span className="form-label">
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </span>
      {children}
      {hint ? <span className="form-hint">{hint}</span> : null}
    </label>
  );
}

export function Notice({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning" | "good" | "danger";
  title: string;
  children: ReactNode;
}) {
  return (
    <div className={cx("notice", `notice-${tone}`)} role={tone === "danger" ? "alert" : "status"}>
      <strong>{title}</strong>
      <div>{children}</div>
    </div>
  );
}

export function PercentBar({
  label,
  value,
  max,
  tone = "accent",
}: {
  label: string;
  value: number;
  max: number;
  tone?: "accent" | "evidence" | "neutral";
}) {
  const percentage = max > 0 ? clamp((value / max) * 100) : 0;
  return (
    <div className="rank-bar-row">
      <div className="rank-bar-label">
        <span>{label}</span>
        <strong>{formatNumber(value)}</strong>
      </div>
      <div className="rank-track" aria-hidden="true">
        <span className={cx("rank-fill", `rank-fill-${tone}`)} style={{ width: `${percentage}%` }} />
      </div>
    </div>
  );
}

export function SubtleSpinner() {
  return <span className="subtle-spinner" aria-label="处理中" role="status" />;
}

export function VisualRefreshFrame({ refreshing, children }: { refreshing: boolean; children: ReactNode }) {
  return (
    <div className={cx("refresh-frame", refreshing && "is-refreshing")} aria-busy={refreshing}>
      {children}
    </div>
  );
}
