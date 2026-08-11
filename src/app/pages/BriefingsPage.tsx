import { useEffect, useMemo, useState } from "react";
import { Link } from "wouter";
import type { BriefingDTO, BriefingType, Citation } from "../../shared/types";
import { BRIEFING_SCHEDULE } from "../../shared/constants";
import {
  API_ROUTES,
  type CollectionEnvelope,
  unwrapCollection,
  unwrapItem,
  useApi,
  withQuery,
} from "../api";
import { useOnlineStatus, usePreferences } from "../preferences";
import {
  Badge,
  CitationList,
  EmptyState,
  EngineBadge,
  ErrorState,
  LoadingState,
  Notice,
  PageHeader,
  RefreshButton,
  SectionHeader,
  VisualRefreshFrame,
} from "../components/ui";
import { GovernanceTrace } from "../components/governance";
import {
  BRIEFING_TYPE_LABELS,
  formatDateTime,
  formatRelativeTime,
  uniqueById,
} from "../utils";

const TYPE_FILTERS: Array<{ key: "all" | BriefingType; label: string }> = [
  { key: "all", label: "全部" },
  { key: "morning", label: "晨报" },
  { key: "noon", label: "午间" },
  { key: "evening", label: "晚报" },
  { key: "breaking", label: "突发" },
  { key: "topic", label: "专题" },
];

function collectCitations(briefing: BriefingDTO): Citation[] {
  return uniqueById(
    briefing.sections
      .flatMap((section) => section.items)
      .flatMap((item) => item.citations)
      .map((citation) => ({ ...citation, id: citation.articleId })),
  );
}

function BriefingDocument({ briefing }: { briefing: BriefingDTO }) {
  const { timeZone } = usePreferences();
  const citations = collectCitations(briefing);

  return (
    <article className="briefing-document">
      <header className="briefing-document-head">
        <div className="briefing-kickers">
          <Badge tone="accent">{BRIEFING_TYPE_LABELS[briefing.type]}</Badge>
          <EngineBadge engine={briefing.engine} />
        </div>
        <h2>{briefing.title}</h2>
        <dl>
          <div>
            <dt>生成时间</dt>
            <dd>{formatDateTime(briefing.createdAt, timeZone)}</dd>
          </div>
          <div>
            <dt>信息截点</dt>
            <dd>{formatDateTime(briefing.cutoffAt, briefing.tz || timeZone)}</dd>
          </div>
          <div>
            <dt>简报时区</dt>
            <dd>{briefing.tz}</dd>
          </div>
        </dl>
      </header>

      {briefing.delta ? (
        <aside className="briefing-delta">
          <span>相较上一版</span>
          <p>{briefing.delta.note}</p>
          <div>
            <Badge tone="good">新增 {briefing.delta.added.length}</Badge>
            <Badge tone="evidence">更新 {briefing.delta.updated.length}</Badge>
          </div>
        </aside>
      ) : null}

      {briefing.oneMinuteRead.length ? (
        <section className="one-minute-read" aria-labelledby="one-minute-title">
          <p className="eyebrow">ONE-MINUTE READ</p>
          <h3 id="one-minute-title">一分钟读完</h3>
          <ol>
            {briefing.oneMinuteRead.map((item, index) => (
              <li key={`${index}-${item}`}>{item}</li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="briefing-sections">
        {briefing.sections.map((section) => (
          <section key={section.name}>
            <SectionHeader title={section.name} />
            {section.items.length ? (
              <div className="briefing-item-list">
                {section.items.map((item) => (
                  <article className="briefing-item" key={`${section.name}-${item.eventId}`}>
                    <div className="briefing-item-topline">
                      {item.isNew ? <Badge tone="accent">新增</Badge> : <Badge>持续更新</Badge>}
                      <span>{item.statusLine}</span>
                    </div>
                    <h4>
                      <Link href={`/events/${encodeURIComponent(item.eventId)}`}>{item.title}</Link>
                    </h4>
                    <p>{item.oneLiner}</p>
                    {item.changeNote ? <p className="change-note">变化：{item.changeNote}</p> : null}
                    <GovernanceTrace
                      snapshot={item.governance || null}
                      sources={item.citations}
                      unverifiedCount={item.unverifiedCount ?? 0}
                    />
                    {item.citations.length ? (
                      <div className="briefing-source-line">
                        {item.citations.map((citation) => {
                          const citationNumber =
                            citations.findIndex((itemCitation) => itemCitation.articleId === citation.articleId) + 1;
                          return (
                            <a
                              key={citation.articleId}
                              href={`#briefing-citation-${citationNumber}`}
                            >
                              [{citationNumber}] {citation.sourceName}
                            </a>
                          );
                        })}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted-copy">本栏目没有条目。</p>
            )}
          </section>
        ))}
      </div>

      <CitationList citations={citations} heading="简报引用" idPrefix="briefing-citation" />
    </article>
  );
}

export function BriefingsPage() {
  const online = useOnlineStatus();
  const [type, setType] = useState<"all" | BriefingType>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const listState = useApi<CollectionEnvelope<BriefingDTO>>(
    withQuery(API_ROUTES.briefings, { limit: 60 }),
  );
  const briefings = unwrapCollection(listState.data).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  const filtered = useMemo(
    () => (type === "all" ? briefings : briefings.filter((briefing) => briefing.type === type)),
    [briefings, type],
  );
  const fallbackBriefing = briefings.find((briefing) => briefing.id === selectedId);
  const detailState = useApi<BriefingDTO | { data: BriefingDTO }>(
    selectedId ? API_ROUTES.briefing(selectedId) : null,
  );
  const selected = unwrapItem(detailState.data) ?? fallbackBriefing;

  useEffect(() => {
    document.title = "每日简报 · 新闻雷达";
  }, []);

  useEffect(() => {
    if (!selectedId || !filtered.some((briefing) => briefing.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? null);
    }
  }, [filtered, selectedId]);

  const refresh = () => {
    listState.reload();
    detailState.reload();
  };

  return (
    <div className="page page-briefings">
      <PageHeader
        eyebrow="每日简报 / EDITIONS"
        title="在固定截点，记录世界发生了什么变化"
        description="只收录完成三省审议与六部具报的事件；每条保留审议结论、信息截点和原始链接。"
        actions={<RefreshButton refreshing={listState.refreshing || detailState.refreshing} onClick={refresh} />}
      />

      {!online ? (
        <Notice tone="warning" title="正在使用离线能力">
          <p>服务工作线程会优先展示曾经成功读取过的简报；未缓存的版本无法离线打开。</p>
        </Notice>
      ) : null}

      <section className="briefing-schedule" aria-label="常规简报时间">
        <div>
          <span>晨报</span>
          <strong>{BRIEFING_SCHEDULE.morning}</strong>
        </div>
        <div>
          <span>午间</span>
          <strong>{BRIEFING_SCHEDULE.noon}</strong>
        </div>
        <div>
          <span>晚报</span>
          <strong>{BRIEFING_SCHEDULE.evening}</strong>
        </div>
        <p>突发事件按证据变化即时生成，不受固定班次限制。</p>
      </section>

      <div className="filter-strip" role="group" aria-label="简报类型">
        {TYPE_FILTERS.map((filter) => (
          <button
            key={filter.key}
            type="button"
            className={type === filter.key ? "is-active" : undefined}
            aria-pressed={type === filter.key}
            onClick={() => setType(filter.key)}
          >
            {filter.label}
          </button>
        ))}
      </div>

      {listState.loading && !briefings.length ? <LoadingState label="正在读取简报档案" /> : null}
      {listState.error && !briefings.length ? (
        <ErrorState error={listState.error} onRetry={listState.reload} title="无法读取简报" />
      ) : null}

      {briefings.length ? (
        <VisualRefreshFrame refreshing={listState.refreshing || detailState.refreshing}>
          <div className="briefing-layout">
            <aside className="edition-list" aria-label="简报版本">
              <div className="edition-list-head">
                <span>{filtered.length} 个版本</span>
                <small>按生成时间倒序</small>
              </div>
              {filtered.length ? (
                filtered.map((briefing) => (
                  <button
                    key={briefing.id}
                    type="button"
                    className={selectedId === briefing.id ? "is-active" : undefined}
                    aria-pressed={selectedId === briefing.id}
                    onClick={() => setSelectedId(briefing.id)}
                  >
                    <span>{BRIEFING_TYPE_LABELS[briefing.type]}</span>
                    <strong>{briefing.title}</strong>
                    <small>{formatRelativeTime(briefing.createdAt)}</small>
                  </button>
                ))
              ) : (
                <p className="muted-copy">当前筛选下没有简报。</p>
              )}
            </aside>

            <section className="edition-reader" aria-label="简报阅读区">
              {detailState.loading && !selected ? <LoadingState label="正在打开简报" /> : null}
              {detailState.error && !selected ? (
                <ErrorState error={detailState.error} onRetry={detailState.reload} title="无法打开这个版本" />
              ) : null}
              {selected ? (
                <BriefingDocument briefing={selected} />
              ) : !detailState.loading && !detailState.error ? (
                <EmptyState title="当前类型没有简报" description="切换到其他简报类型，或稍后等待后端生成新版本。" />
              ) : null}
            </section>
          </div>
        </VisualRefreshFrame>
      ) : !listState.loading && !listState.error ? (
        <EmptyState
          title="尚无可读简报"
          description="简报生成服务写入第一个版本后，这里会按时间归档展示；页面不会填充演示内容。"
        />
      ) : null}
    </div>
  );
}
