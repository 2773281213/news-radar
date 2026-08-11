import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import type {
  ArticleDTO,
  ClaimDTO,
  EventListItem,
  WatchlistDTO,
} from "../../shared/types";
import {
  API_ROUTES,
  ApiRequestError,
  apiRequest,
  type CollectionEnvelope,
  unwrapCollection,
  unwrapItem,
  useApi,
  withQuery,
} from "../api";
import { usePreferences } from "../preferences";
import {
  Badge,
  Button,
  ClaimStatusBadge,
  EmptyState,
  ErrorState,
  EventCard,
  ExternalLink,
  FormField,
  LoadingState,
  Notice,
  PageHeader,
  Panel,
  RefreshButton,
  SectionHeader,
  SubtleSpinner,
  TableFrame,
  VisualRefreshFrame,
} from "../components/ui";
import {
  formatDateTime,
  formatNumber,
  formatRelativeTime,
  getHostname,
  sourceCategoryLabel,
  splitTerms,
} from "../utils";

interface SearchResult {
  events: EventListItem[];
  articles: ArticleDTO[];
  claims: ClaimDTO[];
  total?: number;
}

type SearchPayload = SearchResult | { data: SearchResult } | ArticleDTO[];

function normalizeSearch(payload: SearchPayload | undefined): SearchResult | undefined {
  if (!payload) return undefined;
  if (Array.isArray(payload)) return { events: [], articles: payload, claims: [] };
  return unwrapItem(payload);
}

function ArticleResult({ article }: { article: ArticleDTO }) {
  const { timeZone } = usePreferences();
  return (
    <article className="article-result">
      <div className="article-result-topline">
        <Badge tone={article.isReprint ? "neutral" : "info"}>{article.isReprint ? "转载识别" : "原始收录"}</Badge>
        {article.paywalled ? <Badge tone="warning">可能付费墙</Badge> : null}
        <time dateTime={article.publishedAt || article.firstSeenAt}>
          {formatRelativeTime(article.publishedAt || article.firstSeenAt)}
        </time>
      </div>
      <h3>
        <ExternalLink href={article.url}>{article.title}</ExternalLink>
      </h3>
      {article.excerpt ? <p>{article.excerpt}</p> : null}
      <div className="article-result-meta">
        <span>{article.sourceName || getHostname(article.url)}</span>
        {article.sourceCategory ? <span>{sourceCategoryLabel(article.sourceCategory)}</span> : null}
        <span>{formatDateTime(article.publishedAt || article.firstSeenAt, timeZone)}</span>
        {article.eventId ? <Link href={`/events/${encodeURIComponent(article.eventId)}`}>查看关联事件</Link> : null}
      </div>
    </article>
  );
}

function WatchlistCard({
  watchlist,
  busy,
  onToggle,
  onDelete,
}: {
  watchlist: WatchlistDTO;
  busy: boolean;
  onToggle: (watchlist: WatchlistDTO) => void;
  onDelete: (watchlist: WatchlistDTO) => void;
}) {
  return (
    <article className="watchlist-card">
      <div className="watchlist-head">
        <div>
          <Badge tone={watchlist.enabled ? "good" : "neutral"}>{watchlist.enabled ? "已启用" : "已暂停"}</Badge>
          <h3>{watchlist.name}</h3>
        </div>
        {busy ? <SubtleSpinner /> : null}
      </div>
      <dl>
        <div>
          <dt>关键词</dt>
          <dd>{watchlist.keywords.length ? watchlist.keywords.join("、") : "未设置"}</dd>
        </div>
        <div>
          <dt>实体</dt>
          <dd>{watchlist.entities.length ? watchlist.entities.join("、") : "未设置"}</dd>
        </div>
        <div>
          <dt>最低重要度</dt>
          <dd>{formatNumber(watchlist.minImportance)}</dd>
        </div>
        <div>
          <dt>提醒通道</dt>
          <dd>{watchlist.channels.length ? watchlist.channels.join("、") : "仅保留列表"}</dd>
        </div>
      </dl>
      <div className="card-actions">
        <Button variant="secondary" disabled={busy} onClick={() => onToggle(watchlist)}>
          {watchlist.enabled ? "暂停" : "启用"}
        </Button>
        <Button variant="danger" disabled={busy} onClick={() => onDelete(watchlist)}>
          删除
        </Button>
      </div>
    </article>
  );
}

export function SearchPage() {
  const [, navigate] = useLocation();
  const { adminToken } = usePreferences();
  const initialQuery = new URLSearchParams(window.location.search).get("q")?.trim() || "";
  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [resultTab, setResultTab] = useState<"events" | "articles" | "claims">("events");
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  const [watchlistName, setWatchlistName] = useState("");
  const [keywords, setKeywords] = useState(initialQuery);
  const [entities, setEntities] = useState("");
  const [minImportance, setMinImportance] = useState(0);
  const [channels, setChannels] = useState("");
  const [mutationBusy, setMutationBusy] = useState<string | null>(null);
  const [mutationMessage, setMutationMessage] = useState<{ tone: "good" | "danger"; text: string } | null>(null);

  const searchState = useApi<SearchPayload>(
    submittedQuery ? withQuery(API_ROUTES.search, { q: submittedQuery, limit: 60 }) : null,
  );
  const watchlistsState = useApi<CollectionEnvelope<WatchlistDTO>>(API_ROUTES.watchlists, adminToken);
  const search = normalizeSearch(searchState.data);
  const watchlists = unwrapCollection(watchlistsState.data);

  useEffect(() => {
    document.title = "搜索与追踪 · 新闻雷达";
  }, []);

  const resultCounts = useMemo(
    () => ({
      events: search?.events.length ?? 0,
      articles: search?.articles.length ?? 0,
      claims: search?.claims.length ?? 0,
    }),
    [search],
  );

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const value = query.trim();
    if (!value) return;
    setSubmittedQuery(value);
    setKeywords(value);
    navigate(`/search?q=${encodeURIComponent(value)}`, { replace: true });
  };

  const runWatchlistMutation = async (
    id: string,
    action: () => Promise<unknown>,
    success: string,
  ): Promise<boolean> => {
    setMutationBusy(id);
    setMutationMessage(null);
    try {
      await action();
      setMutationMessage({ tone: "good", text: success });
      watchlistsState.reload();
      return true;
    } catch (error) {
      const message = error instanceof ApiRequestError ? error.message : "观察列表操作失败。";
      setMutationMessage({ tone: "danger", text: message });
      return false;
    } finally {
      setMutationBusy(null);
    }
  };

  const createWatchlist = async (event: FormEvent) => {
    event.preventDefault();
    const name = watchlistName.trim();
    const keywordList = splitTerms(keywords);
    const entityList = splitTerms(entities);
    if (!name || (!keywordList.length && !entityList.length)) return;

    const created = await runWatchlistMutation(
      "new",
      () =>
        apiRequest<WatchlistDTO>(API_ROUTES.watchlists, {
          method: "POST",
          adminToken,
          json: {
            name,
            keywords: keywordList,
            entities: entityList,
            minImportance,
            channels: splitTerms(channels),
            enabled: true,
          },
        }),
      "观察列表已创建。",
    );
    if (created) {
      setWatchlistName("");
      setWatchlistOpen(false);
    }
  };

  const toggleWatchlist = (watchlist: WatchlistDTO) =>
    void runWatchlistMutation(
      watchlist.id,
      () =>
        apiRequest(API_ROUTES.watchlist(watchlist.id), {
          method: "PATCH",
          adminToken,
          json: { enabled: !watchlist.enabled },
        }),
      watchlist.enabled ? "观察列表已暂停。" : "观察列表已启用。",
    );

  const deleteWatchlist = (watchlist: WatchlistDTO) => {
    if (!window.confirm(`确定删除观察列表“${watchlist.name}”吗？此操作无法从前端撤销。`)) return;
    void runWatchlistMutation(
      watchlist.id,
      () => apiRequest(API_ROUTES.watchlist(watchlist.id), { method: "DELETE", adminToken }),
      "观察列表已删除。",
    );
  };

  return (
    <div className="page page-search">
      <PageHeader
        eyebrow="检索台 / SEARCH & TRACK"
        title="先找材料，再建立持续观察"
        description="搜索事件、文章与结构化主张；追踪规则只使用你提交的关键词和实体，不填充示例新闻。"
        actions={<RefreshButton refreshing={watchlistsState.refreshing} onClick={watchlistsState.reload} />}
      />

      <Panel className="search-console">
        <form className="search-form" onSubmit={submitSearch} role="search">
          <label htmlFor="global-search">搜索全部已入库材料</label>
          <div className="search-input-row">
            <input
              id="global-search"
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="输入事件、人物、地点、组织或原文关键词"
              maxLength={200}
              autoComplete="off"
            />
            <Button type="submit" disabled={!query.trim() || searchState.loading}>
              {searchState.loading ? "检索中…" : "开始检索"}
            </Button>
          </div>
        </form>
      </Panel>

      {submittedQuery ? (
        <section className="content-section search-results-section" aria-labelledby="search-results-title">
          <SectionHeader
            id="search-results-title"
            eyebrow={`查询：${submittedQuery}`}
            title="检索结果"
            actions={
              <Button variant="secondary" onClick={() => setWatchlistOpen((open) => !open)}>
                {watchlistOpen ? "收起追踪表单" : "追踪这个查询"}
              </Button>
            }
          />

          {watchlistOpen ? (
            <form className="inline-form watchlist-form" onSubmit={createWatchlist}>
              <FormField label="观察列表名称" required>
                <input value={watchlistName} onChange={(event) => setWatchlistName(event.target.value)} maxLength={80} required />
              </FormField>
              <FormField label="关键词" hint="使用逗号分隔">
                <input value={keywords} onChange={(event) => setKeywords(event.target.value)} maxLength={500} />
              </FormField>
              <FormField label="实体" hint="人物、机构、地点；使用逗号分隔">
                <input value={entities} onChange={(event) => setEntities(event.target.value)} maxLength={500} />
              </FormField>
              <FormField label="最低重要度">
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={minImportance}
                  onChange={(event) => setMinImportance(Number(event.target.value))}
                />
              </FormField>
              <FormField label="提醒通道" hint="多个通道以逗号分隔；留空则只保存追踪规则">
                <input value={channels} onChange={(event) => setChannels(event.target.value)} maxLength={200} />
              </FormField>
              <div className="form-actions">
                <Button type="submit" disabled={mutationBusy === "new" || !watchlistName.trim()}>
                  {mutationBusy === "new" ? "创建中…" : "创建观察列表"}
                </Button>
                <Button variant="ghost" onClick={() => setWatchlistOpen(false)}>
                  取消
                </Button>
              </div>
            </form>
          ) : null}

          {searchState.loading && !search ? <LoadingState label="正在检索实时索引" /> : null}
          {searchState.error && !search ? <ErrorState error={searchState.error} onRetry={searchState.reload} title="检索失败" /> : null}

          {search ? (
            <VisualRefreshFrame refreshing={searchState.refreshing}>
              <div className="result-tabs" role="group" aria-label="结果类型">
                {(["events", "articles", "claims"] as const).map((tab) => (
                  <button
                    key={tab}
                    type="button"
                    className={resultTab === tab ? "is-active" : undefined}
                    aria-pressed={resultTab === tab}
                    onClick={() => setResultTab(tab)}
                  >
                    {tab === "events" ? "事件" : tab === "articles" ? "文章" : "主张"}
                    <span>{resultCounts[tab]}</span>
                  </button>
                ))}
              </div>

              {resultTab === "events" ? (
                search.events.length ? (
                  <div className="event-grid compact-event-grid">
                    {search.events.map((event) => <EventCard key={event.id} event={event} />)}
                  </div>
                ) : (
                  <EmptyState title="没有匹配事件" description="可以切换到文章或主张，或尝试更短、更具体的关键词。" />
                )
              ) : null}

              {resultTab === "articles" ? (
                search.articles.length ? (
                  <div className="article-result-list">
                    {search.articles.map((article) => <ArticleResult key={article.id} article={article} />)}
                  </div>
                ) : (
                  <EmptyState title="没有匹配文章" description="实时索引中暂未找到与查询对应的文章。" />
                )
              ) : null}

              {resultTab === "claims" ? (
                search.claims.length ? (
                  <div className="claim-search-list">
                    {search.claims.map((claim) => (
                      <article key={claim.id}>
                        <div>
                          <ClaimStatusBadge status={claim.status} />
                          <span>{formatRelativeTime(claim.firstSeenAt)}</span>
                        </div>
                        <h3>
                          <Link href={`/events/${encodeURIComponent(claim.eventId)}#claim-${encodeURIComponent(claim.id)}`}>
                            {claim.text}
                          </Link>
                        </h3>
                        <p>{claim.evidence.length} 条证据 · {claim.rationale?.independentChains ?? 0} 个独立证据链</p>
                      </article>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="没有匹配主张" description="结构化主张索引中暂未发现结果。" />
                )
              ) : null}

              <details className="table-disclosure wide-disclosure">
                <summary>查看检索结果数量表</summary>
                <TableFrame label="检索结果数量表">
                  <table>
                    <caption>各结果类型数量</caption>
                    <thead>
                      <tr>
                        <th scope="col">类型</th>
                        <th scope="col">数量</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr><th scope="row">事件</th><td>{resultCounts.events}</td></tr>
                      <tr><th scope="row">文章</th><td>{resultCounts.articles}</td></tr>
                      <tr><th scope="row">主张</th><td>{resultCounts.claims}</td></tr>
                    </tbody>
                  </table>
                </TableFrame>
              </details>
            </VisualRefreshFrame>
          ) : null}
        </section>
      ) : (
        <EmptyState title="输入一个真实查询开始" description="页面只展示 /api 返回的实时内容，不会用演示新闻填充空白。" />
      )}

      <section className="content-section" aria-labelledby="watchlists-title">
        <SectionHeader
          id="watchlists-title"
          eyebrow="WATCHLISTS"
          title="观察列表"
          description="观察列表由后端持续匹配；页面负责查看、启停和提交规则。"
        />
        {mutationMessage ? (
          <Notice tone={mutationMessage.tone} title={mutationMessage.tone === "good" ? "操作完成" : "操作失败"}>
            <p>{mutationMessage.text}</p>
          </Notice>
        ) : null}
        {watchlistsState.loading && !watchlists.length ? <LoadingState label="正在读取观察列表" /> : null}
        {watchlistsState.error && !watchlists.length ? (
          <ErrorState error={watchlistsState.error} onRetry={watchlistsState.reload} title="无法读取观察列表" />
        ) : null}
        {watchlists.length ? (
          <div className="watchlist-grid">
            {watchlists.map((watchlist) => (
              <WatchlistCard
                key={watchlist.id}
                watchlist={watchlist}
                busy={mutationBusy === watchlist.id}
                onToggle={toggleWatchlist}
                onDelete={deleteWatchlist}
              />
            ))}
          </div>
        ) : !watchlistsState.loading && !watchlistsState.error ? (
          <EmptyState
            title="还没有观察列表"
            description="从上方提交一次真实搜索，再将关键词或实体保存为持续追踪规则。"
          />
        ) : null}
      </section>
    </div>
  );
}
