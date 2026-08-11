import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link } from "wouter";
import type { AskFilters, AskResponse } from "../../shared/types";
import { API_ROUTES, ApiRequestError, apiRequest, unwrapItem } from "../api";
import { usePreferences } from "../preferences";
import {
  Button,
  CitationList,
  EmptyState,
  EngineBadge,
  FormField,
  Notice,
  PageHeader,
  Panel,
  SubtleSpinner,
} from "../components/ui";
import { formatDateTime } from "../utils";

const SUGGESTIONS = [
  "过去 24 小时有哪些已经交叉确认的重要变化？",
  "哪些事件仍存在明显的来源覆盖缺口？",
  "列出目前互相冲突的数字主张，并说明各自来源。",
] as const;

function renderCitationMarkers(text: string, citationCount: number, paragraphIndex: number): ReactNode[] {
  const parts = text.split(/(\[\d+\])/g);
  return parts.map((part, index) => {
    const match = /^\[(\d+)\]$/.exec(part);
    if (!match) return part;
    const citationNumber = Number(match[1]);
    if (citationNumber < 1 || citationNumber > citationCount) return part;
    return (
      <a
        className="answer-citation-marker"
        href={`#ask-citation-${citationNumber}`}
        key={`${paragraphIndex}-${index}-${citationNumber}`}
        aria-label={`跳到引用 ${citationNumber}`}
      >
        [{citationNumber}]
      </a>
    );
  });
}

function AnswerBody({ response }: { response: AskResponse }) {
  return (
    <article className="assistant-answer" aria-live="polite">
      <header>
        <div>
          <p className="eyebrow">ANSWER</p>
          <h2>基于当前材料的回答</h2>
        </div>
        <EngineBadge engine={response.engine} />
      </header>
      <div className="answer-prose">
        {response.answer
          .split(/\n{2,}/)
          .filter(Boolean)
          .map((paragraph, index) => (
            <p key={`${index}-${paragraph.slice(0, 24)}`}>
              {renderCitationMarkers(paragraph, response.citations.length, index)}
            </p>
          ))}
      </div>
      {response.caveats.length ? (
        <aside className="answer-caveats">
          <h3>限制与保留</h3>
          <ul>
            {response.caveats.map((caveat) => <li key={caveat}>{caveat}</li>)}
          </ul>
        </aside>
      ) : null}
      {response.relatedEventIds.length ? (
        <div className="related-events">
          <h3>相关事件</h3>
          <div>
            {response.relatedEventIds.map((eventId) => (
              <Link key={eventId} href={`/events/${encodeURIComponent(eventId)}`}>
                事件 {eventId}
              </Link>
            ))}
          </div>
        </div>
      ) : null}
      <CitationList citations={response.citations} heading="回答引用" idPrefix="ask-citation" />
    </article>
  );
}

export function AssistantPage() {
  const { timeZone } = usePreferences();
  const [question, setQuestion] = useState("");
  const [filters, setFilters] = useState<AskFilters>({
    excludeReprints: true,
    onlyCrossVerified: false,
    onlyOfficial: false,
    onlyCivilian: false,
  });
  const [response, setResponse] = useState<AskResponse | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = "自然语言助手 · 新闻雷达";
  }, []);

  const ask = async (event: FormEvent) => {
    event.preventDefault();
    const value = question.trim();
    if (value.length < 3) return;
    setBusy(true);
    setError(null);
    try {
      const payload = await apiRequest<AskResponse | { data: AskResponse }>(API_ROUTES.ask, {
        method: "POST",
        json: { question: value, filters },
      });
      const result = unwrapItem(payload);
      if (!result) throw new ApiRequestError("问答接口没有返回可读结果。", 502);
      setResponse(result);
    } catch (requestError) {
      setError(
        requestError instanceof ApiRequestError
          ? requestError
          : new ApiRequestError("生成回答时发生未知异常。", 0),
      );
    } finally {
      setBusy(false);
    }
  };

  const updateFilter = (key: keyof AskFilters, checked: boolean) => {
    setFilters((current) => {
      const next = { ...current, [key]: checked };
      if (checked && key === "onlyOfficial") next.onlyCivilian = false;
      if (checked && key === "onlyCivilian") next.onlyOfficial = false;
      return next;
    });
  };

  return (
    <div className="page page-assistant">
      <PageHeader
        eyebrow="自然语言助手 / ASK THE ARCHIVE"
        title="让回答带着引用、截点和保留意见出现"
        description="助手只能使用已入库材料；回答中的每个引用编号都必须对应 /api 返回的真实来源。"
      />

      <div className="assistant-layout">
        <Panel className="assistant-console">
          <form onSubmit={ask}>
            <FormField
              label="你的问题"
              hint="尽量说明时间范围、对象和希望比较的维度。"
              required
            >
              <textarea
                value={question}
                onChange={(event) => setQuestion(event.target.value)}
                rows={7}
                minLength={3}
                maxLength={4_000}
                placeholder="例如：哪些说法已经得到独立来源交叉确认？"
                required
              />
            </FormField>

            <fieldset className="filter-fieldset">
              <legend>证据筛选</legend>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(filters.excludeReprints)}
                  onChange={(event) => updateFilter("excludeReprints", event.target.checked)}
                />
                排除转载与同源重复
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(filters.onlyCrossVerified)}
                  onChange={(event) => updateFilter("onlyCrossVerified", event.target.checked)}
                />
                只使用已交叉确认主张
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(filters.onlyOfficial)}
                  onChange={(event) => updateFilter("onlyOfficial", event.target.checked)}
                />
                只看官方来源
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={Boolean(filters.onlyCivilian)}
                  onChange={(event) => updateFilter("onlyCivilian", event.target.checked)}
                />
                只看非官方来源
              </label>
            </fieldset>

            <Button className="assistant-submit" type="submit" disabled={busy || question.trim().length < 3}>
              {busy ? <><SubtleSpinner /> 正在核对材料…</> : "提交问题"}
            </Button>
          </form>

          <div className="question-suggestions">
            <span>查询结构建议</span>
            {SUGGESTIONS.map((suggestion) => (
              <button key={suggestion} type="button" onClick={() => setQuestion(suggestion)}>
                {suggestion}
              </button>
            ))}
          </div>
        </Panel>

        <section className="assistant-output" aria-label="助手回答">
          {busy && !response ? (
            <div className="assistant-thinking" role="status" aria-live="polite">
              <span className="radar-pulse" aria-hidden="true" />
              <h2>正在核对时间线与证据家族</h2>
              <p>不会在等待期间插入示例答案或占位引用。</p>
            </div>
          ) : null}

          {error ? (
            <Notice tone="danger" title="无法生成回答">
              <p>{error.message}</p>
              {error.detail ? <p>{error.detail}</p> : null}
            </Notice>
          ) : null}

          {response ? (
            <>
              <div className="answer-cutoff">
                <span>材料截点</span>
                <time dateTime={response.cutoff}>{formatDateTime(response.cutoff, timeZone)}</time>
              </div>
              <AnswerBody response={response} />
            </>
          ) : !busy && !error ? (
            <EmptyState
              title="回答区等待真实问题"
              description="提交后只呈现接口返回的答案、限制条件与原始引用，不生成演示性新闻内容。"
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
