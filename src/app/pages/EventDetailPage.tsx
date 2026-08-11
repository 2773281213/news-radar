import { useEffect } from "react";
import { Link } from "wouter";
import type {
  ClaimDTO,
  CoverageDTO,
  EventDetailDTO,
  EventSummaryDTO,
  EventWorkflowDTO,
  TimelineItem,
} from "../../shared/types";
import { PARTY_DISCLAIMER } from "../../shared/constants";
import { WorkflowAuditPanel } from "../components/governance";
import { API_ROUTES, unwrapItem, useApi } from "../api";
import { usePreferences } from "../preferences";
import {
  Badge,
  CitationList,
  ClaimStatusBadge,
  EmptyState,
  EngineBadge,
  ErrorState,
  EventStatusBadge,
  ExternalLink,
  HeatMeter,
  InlineCitations,
  LoadingState,
  Notice,
  PageHeader,
  Panel,
  PercentBar,
  RefreshButton,
  SectionHeader,
  StatTile,
  TableFrame,
  VisualRefreshFrame,
} from "../components/ui";
import {
  EVIDENCE_STANCE_LABELS,
  TIMELINE_KIND_LABELS,
  formatDateTime,
  formatNumber,
  sourceCategoryLabel,
} from "../utils";

function SummarySection({ summary }: { summary: EventSummaryDTO }) {
  return (
    <section className="event-summary-section" aria-labelledby="event-summary-title">
      <SectionHeader id="event-summary-title" eyebrow="已知情况" title="事件摘要" />
      <p className="summary-one-liner">
        {summary.oneLiner}
      </p>

      {summary.confirmed.length ? (
        <div className="summary-group summary-group-confirmed">
          <h3>已交叉确认</h3>
          <ul className="evidence-list">
            {summary.confirmed.map((item) => (
              <li key={item.claimId}>
                <span className="evidence-marker" aria-hidden="true">✓</span>
                <div>
                  <p>{item.text}</p>
                  <InlineCitations citations={item.citations} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {summary.statements.length ? (
        <div className="summary-group">
          <h3>各方声明</h3>
          <Notice tone="warning" title="声明不等于事实">
            <p>{PARTY_DISCLAIMER}</p>
          </Notice>
          <div className="statement-grid">
            {summary.statements.map((group) => (
              <article className="statement-card" key={group.party}>
                <h4>{group.partyLabel}</h4>
                <ul>
                  {group.items.map((item) => (
                    <li key={item.claimId}>
                      <ClaimStatusBadge status={item.status} />
                      <p>{item.text}</p>
                      <InlineCitations citations={item.citations} />
                    </li>
                  ))}
                </ul>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {summary.unverified.length ? (
        <div className="summary-group summary-group-unverified">
          <h3>仍待核实</h3>
          <ul className="evidence-list">
            {summary.unverified.map((item) => (
              <li key={item.claimId}>
                <span className="evidence-marker" aria-hidden="true">?</span>
                <div>
                  <p>{item.text}</p>
                  <InlineCitations citations={item.citations} />
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {summary.disputed.length ? (
        <div className="summary-group summary-group-disputed">
          <h3>争议焦点</h3>
          <div className="dispute-list">
            {summary.disputed.map((group) => (
              <article className="dispute-card" key={group.topic}>
                <h4>{group.topic}</h4>
                <div className="position-list">
                  {group.positions.map((position, index) => (
                    <div key={`${position.party}-${index}`}>
                      <Badge tone="danger">{position.party}</Badge>
                      <p>{position.text}</p>
                      {position.number !== undefined && position.number !== null ? (
                        <p className="position-number">
                          {formatNumber(position.number)} {position.asOf ? `· 截至 ${position.asOf}` : ""}
                        </p>
                      ) : null}
                      {position.citation ? <InlineCitations citations={[position.citation]} /> : null}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}

      {summary.whyItMatters ? (
        <aside className="why-it-matters">
          <span>为什么重要</span>
          <p>{summary.whyItMatters.text}</p>
          <small>{summary.whyItMatters.generatedBy === "ai" ? "AI 辅助判断" : "规则生成"}</small>
        </aside>
      ) : null}
    </section>
  );
}

function ClaimCard({ claim }: { claim: ClaimDTO }) {
  const { timeZone } = usePreferences();
  return (
    <article className="claim-card" id={`claim-${claim.id}`}>
      <div className="claim-head">
        <ClaimStatusBadge status={claim.status} />
        <span className="claim-type">{claim.type}</span>
      </div>
      <h3>{claim.text}</h3>
      <dl className="claim-meta">
        {claim.claimedBy ? (
          <div>
            <dt>提出者</dt>
            <dd>{claim.claimedBy}</dd>
          </div>
        ) : null}
        {claim.party ? (
          <div>
            <dt>相关方</dt>
            <dd>{claim.party}</dd>
          </div>
        ) : null}
        {claim.subjectNumber !== null ? (
          <div>
            <dt>数字主张</dt>
            <dd>
              {formatNumber(claim.subjectNumber)} {claim.numberUnit || ""}
            </dd>
          </div>
        ) : null}
        <div>
          <dt>首次发现</dt>
          <dd>{formatDateTime(claim.firstSeenAt, timeZone)}</dd>
        </div>
        <div>
          <dt>最近核验</dt>
          <dd>{formatDateTime(claim.lastCheckedAt, timeZone)}</dd>
        </div>
      </dl>

      {claim.rationale ? (
        <div className="rationale-box">
          <div className="rationale-metrics">
            <span>独立证据链 <strong>{formatNumber(claim.rationale.independentChains)}</strong></span>
            <span>{claim.rationale.hasPrimary ? "含第一手材料" : "暂无第一手材料"}</span>
            <span>{claim.rationale.hasRefutation ? "存在明确反证" : "未发现明确反证"}</span>
          </div>
          {claim.rationale.factors.length ? (
            <ul>
              {claim.rationale.factors.map((factor) => (
                <li key={factor}>{factor}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="claim-evidence">
        <h4>结构化证据</h4>
        {claim.evidence.length ? (
          <ol>
            {claim.evidence.map((evidence, index) => (
              <li key={`${evidence.articleId}-${index}`}>
                <div className="evidence-line">
                  <Badge
                    tone={
                      evidence.stance === "supports"
                        ? "good"
                        : evidence.stance === "refutes" || evidence.stance === "disputes"
                          ? "danger"
                          : "neutral"
                    }
                  >
                    {EVIDENCE_STANCE_LABELS[evidence.stance]}
                  </Badge>
                  {evidence.hasPrimary ? <Badge tone="evidence">第一手材料</Badge> : null}
                  {evidence.familyKey ? <span className="family-key">证据家族 {evidence.familyKey}</span> : null}
                </div>
                {evidence.citation ? (
                  <div className="evidence-citation">
                    <ExternalLink href={evidence.citation.url}>{evidence.citation.title}</ExternalLink>
                    <p>
                      {evidence.citation.sourceName} · {sourceCategoryLabel(evidence.citation.sourceCategory)}
                    </p>
                  </div>
                ) : (
                  <p className="muted-copy">该证据条目尚未关联可公开访问的引用。</p>
                )}
                {evidence.note ? <p className="evidence-note">{evidence.note}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="muted-copy">尚未形成结构化证据条目。</p>
        )}
      </div>
    </article>
  );
}

function Timeline({ items }: { items: TimelineItem[] }) {
  const { timeZone } = usePreferences();
  if (!items.length) return null;
  return (
    <section className="content-section" aria-labelledby="timeline-title">
      <SectionHeader id="timeline-title" eyebrow="按发生时间排序" title="时间线" />
      <ol className="timeline">
        {items.map((item, index) => (
          <li key={`${item.at}-${index}`}>
            <div className="timeline-stamp">
              <time dateTime={item.at}>{formatDateTime(item.at, timeZone)}</time>
              <Badge tone={item.kind === "revision" ? "evidence" : "neutral"}>
                {TIMELINE_KIND_LABELS[item.kind]}
              </Badge>
            </div>
            <div className="timeline-body">
              <p>{item.text}</p>
              {item.citation ? <InlineCitations citations={[item.citation]} /> : null}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function CoveragePanel({ coverage }: { coverage: CoverageDTO }) {
  const rows = Object.entries(coverage.byCategory).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, value]) => value));
  return (
    <Panel className="coverage-panel" aria-labelledby="coverage-title">
      <SectionHeader
        id="coverage-title"
        eyebrow="覆盖审计"
        title="来源覆盖"
        description={`${formatNumber(coverage.independentFamilies)} 个独立来源家族`}
      />
      <div className="coverage-summary">
        <div>
          <h3>已覆盖</h3>
          {coverage.present.length ? (
            <ul className="compact-list good-list">
              {coverage.present.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="muted-copy">暂无覆盖记录。</p>
          )}
        </div>
        <div>
          <h3>信息缺口</h3>
          {coverage.gaps.length ? (
            <ul className="compact-list warning-list">
              {coverage.gaps.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="muted-copy">当前未标记明显缺口。</p>
          )}
        </div>
      </div>
      {rows.length ? (
        <div className="coverage-bars" aria-label="来源类别文章数量">
          {rows.slice(0, 8).map(([category, value]) => (
            <PercentBar key={category} label={sourceCategoryLabel(category)} value={value} max={max} />
          ))}
        </div>
      ) : null}
      <details className="table-disclosure">
        <summary>查看覆盖数据表</summary>
        <TableFrame label="来源覆盖数据表">
          <table>
            <caption>事件各来源类别文章数量</caption>
            <thead>
              <tr>
                <th scope="col">来源类别</th>
                <th scope="col">文章数</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(([category, value]) => (
                <tr key={category}>
                  <th scope="row">{sourceCategoryLabel(category)}</th>
                  <td>{formatNumber(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableFrame>
      </details>
    </Panel>
  );
}

export function EventDetailPage({ eventId }: { eventId: string }) {
  const { timeZone } = usePreferences();
  const state = useApi<EventDetailDTO | { data: EventDetailDTO }>(API_ROUTES.event(eventId));
  const workflowState = useApi<EventWorkflowDTO>(API_ROUTES.eventWorkflow(eventId));
  const event = unwrapItem(state.data);

  useEffect(() => {
    document.title = event ? `${event.title} · 新闻雷达` : "事件详情 · 新闻雷达";
  }, [event]);

  if (state.loading && !event) return <LoadingState label="正在装配事件证据链" />;
  if (state.error && !event) return <ErrorState error={state.error} onRetry={state.reload} title="无法读取事件" />;
  if (!event) {
    return <EmptyState title="没有找到这个事件" description="事件可能尚未生成、已被合并，或后端接口尚未提供。" />;
  }

  return (
    <VisualRefreshFrame refreshing={state.refreshing}>
      <article className="page event-detail-page">
        <nav className="breadcrumbs" aria-label="面包屑">
          <Link href="/live">实时事件</Link>
          <span aria-hidden="true">/</span>
          <span>事件详情</span>
        </nav>

        <PageHeader
          eyebrow={`事件版本 V${event.version}`}
          title={event.title}
          description={event.oneLiner || "事件摘要尚在形成，以下内容按现有证据结构展示。"}
          actions={
            <RefreshButton
              refreshing={state.refreshing || workflowState.refreshing}
              onClick={() => {
                state.reload();
                workflowState.reload();
              }}
            />
          }
        />

        <div className="event-detail-topline">
          <EventStatusBadge event={event} />
          <EngineBadge engine={event.summaryEngine} />
          <span>首次进入视野：{formatDateTime(event.firstAt, timeZone)}</span>
          <span>最近核验：{formatDateTime(event.lastVerifiedAt, timeZone)}</span>
        </div>

        <section className="event-detail-stats" aria-label="事件指标">
          <StatTile label="重要度" value={formatNumber(event.importance)} note="用于编辑优先级排序" tone="accent" />
          <StatTile label="关联文章" value={event.articleCount} note="含转载识别后的材料" />
          <StatTile label="已确认主张" value={event.confirmedCount} note="达到交叉确认条件" />
          <StatTile label="争议主张" value={event.disputedCount} note="存在相互冲突的证据" tone="evidence" />
        </section>

        <Panel className="event-heat-panel">
          <HeatMeter heat={event.heat} heatTrend={event.heatTrend} />
          <p>热度用于反映更新强度，不等同于事实可信度或事件重要性。</p>
        </Panel>

        {event.delta ? (
          <Panel className="delta-panel">
            <SectionHeader eyebrow={`相对版本 ${event.delta.sinceVersion}`} title="本次更新了什么" />
            <div className="delta-grid">
              <div>
                <h3>新增</h3>
                {event.delta.added.length ? <ul>{event.delta.added.map((item) => <li key={item}>{item}</li>)}</ul> : <p>无</p>}
              </div>
              <div>
                <h3>变化</h3>
                {event.delta.changed.length ? <ul>{event.delta.changed.map((item) => <li key={item}>{item}</li>)}</ul> : <p>无</p>}
              </div>
              <div>
                <h3>移除</h3>
                {event.delta.removed.length ? <ul>{event.delta.removed.map((item) => <li key={item}>{item}</li>)}</ul> : <p>无</p>}
              </div>
            </div>
          </Panel>
        ) : null}

        <div className="event-detail-layout">
          <div className="event-detail-main">
            {event.summary ? (
              <SummarySection summary={event.summary} />
            ) : (
              <EmptyState title="摘要尚未生成" description="可以先阅读下方主张、时间线与原始引用。" />
            )}

            <section className="content-section" aria-labelledby="claims-title">
              <SectionHeader
                id="claims-title"
                eyebrow="CLAIM LEDGER"
                title="主张与证据"
                description="不绘制推断性的关系图；每条主张直接列出立场、证据家族与原文引用。"
              />
              <div className="claim-list">
                {event.claims.length ? (
                  event.claims.map((claim) => <ClaimCard claim={claim} key={claim.id} />)
                ) : (
                  <EmptyState title="尚无结构化主张" description="事件已建立，但主张抽取和证据归并尚未完成。" />
                )}
              </div>
            </section>

            <Timeline items={event.timeline} />
            <CitationList citations={event.citations} heading="事件原始引用" idPrefix="event-citation" />
          </div>

          <aside className="event-detail-aside">
            {workflowState.data ? <WorkflowAuditPanel data={workflowState.data} /> : null}
            {workflowState.error && workflowState.error.status !== 404 ? (
              <Notice tone="warning" title="审议记录暂不可用"><p>{workflowState.error.message}</p></Notice>
            ) : null}
            <CoveragePanel coverage={event.coverage} />
            <Panel className="event-context-panel">
              <SectionHeader eyebrow="索引" title="事件范围" />
              <dl>
                <div>
                  <dt>国家与地区</dt>
                  <dd>{event.countries.length ? event.countries.join("、") : "未标注"}</dd>
                </div>
                <div>
                  <dt>主题</dt>
                  <dd>{event.topics.length ? event.topics.join("、") : "未标注"}</dd>
                </div>
                <div>
                  <dt>覆盖缺口</dt>
                  <dd>{formatNumber(event.coverageGapCount)}</dd>
                </div>
                <div>
                  <dt>最近更新</dt>
                  <dd>{formatDateTime(event.lastUpdateAt, timeZone)}</dd>
                </div>
              </dl>
              <Link className="button button-secondary" href={`/search?q=${encodeURIComponent(event.title)}`}>
                搜索相关材料
              </Link>
            </Panel>
          </aside>
        </div>
      </article>
    </VisualRefreshFrame>
  );
}
