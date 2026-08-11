import type { AskFilters, AskResponse, BriefingDTO, BriefingType, EventDetailDTO } from "../../shared/types";
import type { Config } from "../config";
import { createAIProvider, AIUnavailableError, type AIGenerateRequest, type AIGenerateResult, type AIProvider } from "../ai";
import type { ReportArticle } from "../ai/extractive";
import { generateEventSummary } from "../ai/reporting";
import { generateBriefing, type BriefingEventInput } from "../pipeline/briefing";
import { answerNewsQuestion } from "../pipeline/qa";
import { buildGdeltSearchPlan } from "../pipeline/search";
import { calculateEventPriority } from "../pipeline/priority";
import { yieldToEventLoop } from "../lib/async";
import type { KV } from "../lib/kv";
import { localDateKey, nowIso } from "../lib/time";
import type { ArticleStore, ArticleWithSource } from "./article-store";
import type { BriefingStore } from "./briefing-store";
import type { EventStore } from "./event-store";
import type { WorkflowStore } from "./workflow-store";

/** AI 每日调用预算包装；超过上限直接触发抽取式降级，不产生费用 */
class BudgetedProvider implements AIProvider {
  readonly name;
  readonly model;
  readonly enabled;

  constructor(
    private inner: AIProvider,
    private kv: KV,
    private dailyLimit: number
  ) {
    this.name = inner.name;
    this.model = inner.model;
    this.enabled = inner.enabled && dailyLimit > 0;
  }

  async generate(request: AIGenerateRequest): Promise<AIGenerateResult> {
    const day = new Date().toISOString().slice(0, 10);
    const key = `ai-budget:${this.name}:${day}`;
    const used = Number((await this.kv.get(key)) || "0");
    if (used >= this.dailyLimit) {
      throw new AIUnavailableError(this.name, `AI 每日调用上限 ${this.dailyLimit} 已达到`);
    }
    await this.kv.set(key, String(used + 1), 3 * 24 * 3600);
    return this.inner.generate(request);
  }
}

/** 摘要、简报、问答与主动搜索计划的统一应用服务 */
export class ReportingService {
  readonly provider: AIProvider;

  constructor(
    private config: Config,
    private kv: KV,
    private articleStore: ArticleStore,
    private eventStore: EventStore,
    private briefingStore: BriefingStore,
    private workflowStore: WorkflowStore
  ) {
    const base = createAIProvider(config);
    this.provider = new BudgetedProvider(base, kv, config.aiDailyBudget);
  }

  async refreshEvent(eventId: string): Promise<EventDetailDTO | null> {
    const loaded = await this.eventStore.detailWithArticles(eventId);
    if (!loaded) return null;
    const { event, detail, articles: articleRows } = loaded;
    const families = new Set(articleRows.map((row) => row.wireFamily || row.reprintOf || row.sourceFamilyId || row.sourceId));
    const priority = calculateEventPriority(detail, articleRows, families.size);
    const summaryFenceLastUpdateAt = await this.eventStore.touch(eventId, {
      importance: priority.importance,
      prevHeat: event.heat,
      heat: priority.heat,
      trackMode: priority.trackMode,
      status: priority.trackMode === "slow" ? event.status : "developing",
    });

    const generated = await generateEventSummary(
      {
        eventId,
        title: event.title,
        importance: priority.importance,
        topics: event.topics || [],
        countries: event.countries || [],
        claims: detail.claims,
        articles: articleRows.map(toReportArticle),
      },
      this.provider
    );
    const saved = await this.eventStore.saveSummary(eventId, generated.summary, generated.engine, {
      version: event.version,
      lastUpdateAt: summaryFenceLastUpdateAt,
    });
    if (!saved) throw new Error("事件在摘要生成期间已更新，保留 dirty 状态等待重算");
    return this.eventStore.detail(eventId);
  }

  async refreshDirty(limit = 40): Promise<string[]> {
    const dirty = await this.eventStore.dirty(limit);
    const refreshed: string[] = [];
    for (const event of dirty) {
      try {
        if (await this.refreshEvent(event.id)) refreshed.push(event.id);
      } catch (error) {
        console.warn(`[简报] 事件 ${event.id} 摘要刷新失败，保留 dirty 状态: ${safeMessage(error)}`);
      }
      await yieldToEventLoop();
    }
    return refreshed;
  }

  async createBriefing(type: BriefingType, tz = this.config.defaultTz): Promise<BriefingDTO> {
    const cutoffAt = nowIso();
    const hours = type === "hourly" ? 2 : type === "morning" ? 24 : 14;
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const list = this.eventStore.list({
      since,
      minImportance: type === "breaking" ? 70 : 25,
      publishableOnly: true,
      limit: 60,
    });
    const previous = await this.briefingStore.latest(type);
    const previousIds = new Set(previous?.sections.flatMap((section) => section.items.map((item) => item.eventId)) || []);
    const inputs: BriefingEventInput[] = [];
    const details = await this.eventStore.briefingDetails(list.map((item) => item.id));
    const governance = this.workflowStore.snapshots(list.map((item) => item.id));

    for (const item of list) {
      const detail = details.get(item.id);
      const snapshot = governance.get(item.id);
      if (!detail || !snapshot || snapshot.workflow.status !== "completed" || !snapshot.workflow.publishable) continue;
      inputs.push({
        eventId: item.id,
        title: item.title,
        oneLiner: item.oneLiner,
        summary: detail.summary,
        status: item.status,
        importance: item.importance,
        heat: item.heat,
        topics: item.topics,
        countries: item.countries,
        lastUpdateAt: item.lastUpdateAt,
        articleCount: item.articleCount,
        independentSourceCount: item.independentSourceCount,
        unverifiedCount: item.unverifiedCount,
        citations: detail.citations,
        governance: snapshot,
        isNew: !previousIds.has(item.id),
        changeNote: detail.delta
          ? [...detail.delta.added.slice(0, 2), ...detail.delta.changed.slice(0, 1)].join("；") || null
          : null,
      });
    }

    const periodKey = `${localDateKey(new Date(cutoffAt), tz)}-${type}`;
    const generated = await generateBriefing(
      {
        id: `brf_${periodKey}`,
        type,
        periodKey,
        cutoffAt,
        tz,
        events: inputs,
        previous,
        maxItems: type === "hourly" ? 10 : 24,
      },
      this.provider
    );
    const { id: _generatedId, aiError: _aiError, ...withoutId } = generated;
    return this.briefingStore.save(withoutId);
  }

  async ask(question: string, filters: AskFilters = {}, cutoff = nowIso()): Promise<AskResponse> {
    const trimmed = question.replace(/\s+/g, " ").trim().slice(0, 1000);
    if (!trimmed) {
      return {
        answer: "请输入要查询的新闻问题。",
        citations: [],
        cutoff,
        caveats: ["未收到有效问题。"],
        engine: "extractive",
        relatedEventIds: [],
      };
    }
    let rows = this.articleStore.search(trimmed, 80, true);
    if (rows.length < 8) {
      const recent = await this.articleStore.recent(72, 80, true);
      const map = new Map(rows.map((row) => [row.id, row]));
      for (const row of recent) map.set(row.id, row);
      rows = [...map.values()];
    }
    return answerNewsQuestion(
      {
        question: trimmed,
        articles: rows.map(toReportArticle),
        cutoff,
        filters,
        maxSources: 14,
      },
      this.provider
    );
  }

  async searchPlan(eventId: string) {
    const event = await this.eventStore.get(eventId);
    if (!event) return null;
    return buildGdeltSearchPlan(
      {
        title: event.title,
        entitySlugs: (event.entities || []).map((entity) => entity.slug),
        countries: event.countries || [],
      },
      { trackMode: event.trackMode as "breaking" | "active" | "normal" | "slow" }
    );
  }
}

function toReportArticle(row: ArticleWithSource): ReportArticle {
  return {
    id: row.id,
    sourceId: row.sourceId,
    sourceName: row.sourceName,
    sourceCategory: row.sourceCategory as ReportArticle["sourceCategory"],
    url: row.url,
    title: row.title,
    lang: row.lang,
    publishedAt: row.publishedAt,
    firstSeenAt: row.firstSeenAt,
    excerpt: row.excerpt,
    bodyText: row.bodyText,
    isReprint: row.isReprint,
    wireFamily: row.wireFamily,
    eventId: row.eventId,
    isParty: row.sourceIsParty,
    partyOf: row.sourcePartyOf,
    familyKey: row.wireFamily || row.reprintOf || row.sourceFamilyId || `source:${row.sourceId}`,
    isCivilian: !row.sourceIsParty,
  };
}

function safeMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 500);
}
