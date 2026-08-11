import type {
  BriefingDTO,
  BriefingItem,
  BriefingType,
  Citation,
  EventStatus,
  EventSummaryDTO,
  GovernanceSnapshotDTO,
} from "../../shared/types";
import { dedupeCitations, appendCitationMarkers } from "../ai/extractive";
import { boundedString, isRecord, parseAIJson } from "../ai/json";
import { BRIEFING_SYSTEM_PROMPT, untrustedRecordBlock } from "../ai/prompts";
import { runAIOrExtractive, type AIProvider } from "../ai/provider";
import { stripHtml } from "../lib/sanitize";

export interface BriefingEventInput {
  eventId: string;
  title: string;
  oneLiner?: string | null;
  summary?: EventSummaryDTO | null;
  status?: EventStatus;
  importance?: number;
  heat?: number;
  topics?: string[];
  countries?: string[];
  lastUpdateAt?: string;
  articleCount?: number;
  independentSourceCount?: number;
  unverifiedCount?: number;
  citations: Citation[];
  governance: GovernanceSnapshotDTO;
  isNew?: boolean;
  changeNote?: string | null;
  section?: string;
}

export interface GenerateBriefingInput {
  id: string;
  type: BriefingType;
  periodKey: string;
  createdAt?: string;
  cutoffAt: string;
  tz: string;
  events: BriefingEventInput[];
  previous?: BriefingDTO | null;
  maxItems?: number;
}

function briefingTitle(type: BriefingType, cutoffAt: string): string {
  const date = cutoffAt.slice(0, 10);
  const labels: Record<BriefingType, string> = {
    morning: "晨间新闻简报",
    noon: "午间新闻简报",
    evening: "晚间新闻简报",
    breaking: "突发新闻简报",
    hourly: "整点新闻简报",
    topic: "专题新闻简报",
    watchlist: "观察列表简报",
  };
  return `${date} ${labels[type]}`;
}

function statusLine(event: BriefingEventInput): string {
  const summary = event.summary;
  if (!summary) return `${event.articleCount ?? event.citations.length} 篇相关报道`;
  const confirmed = summary.confirmed.length;
  const unverified = summary.unverified.length;
  const disputed = summary.disputed.length;
  const parts = [
    confirmed ? `${confirmed} 项已确认` : "",
    unverified ? `${unverified} 项待核实` : "",
    disputed ? `${disputed} 项争议` : "",
  ].filter(Boolean);
  return parts.join(" · ") || `${event.articleCount ?? event.citations.length} 篇相关报道`;
}

function defaultSection(event: BriefingEventInput): string {
  if (event.section) return event.section;
  if (event.status === "developing" || (event.importance ?? 0) >= 80) return "正在发生";
  if ((event.countries || []).length > 0 && (event.countries || []).every((country) => country === "cn")) return "国内";
  if ((event.topics || []).some((topic) => ["diplomacy", "defense", "conflict", "security", "sanctions"].includes(topic))) return "外交与安全";
  if ((event.topics || []).some((topic) => ["policy", "economy", "energy", "finance", "tech", "ai"].includes(topic))) return "政策与经济";
  return "国际";
}

function cleanLine(value: string, max = 1_200): string {
  return stripHtml(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function itemFromEvent(event: BriefingEventInput, section = defaultSection(event), oneLiner?: string, changeNote?: string | null): BriefingItem {
  return {
    eventId: event.eventId,
    title: cleanLine(event.title, 300),
    oneLiner: cleanLine(oneLiner || event.oneLiner || event.summary?.oneLiner || event.title, 800),
    statusLine: statusLine(event),
    citations: dedupeCitations(event.citations),
    independentSourceCount: event.independentSourceCount ?? event.governance.proposal?.independentFamilies ?? 0,
    unverifiedCount: event.unverifiedCount ?? 0,
    governance: event.governance,
    section,
    isNew: Boolean(event.isNew),
    changeNote: changeNote === undefined ? event.changeNote ?? null : changeNote,
  };
}

function flattenItems(briefing: BriefingDTO | null | undefined): BriefingItem[] {
  return briefing?.sections.flatMap((section) => section.items) || [];
}

function briefingDelta(items: BriefingItem[], previous?: BriefingDTO | null): BriefingDTO["delta"] {
  if (!previous) return null;
  const old = new Map(flattenItems(previous).map((item) => [item.eventId, item]));
  const added = items.filter((item) => !old.has(item.eventId)).map((item) => item.eventId);
  const updated = items
    .filter((item) => {
      const prior = old.get(item.eventId);
      return Boolean(prior && (item.changeNote || prior.oneLiner !== item.oneLiner || prior.statusLine !== item.statusLine));
    })
    .map((item) => item.eventId);
  return {
    added,
    updated,
    note: added.length || updated.length ? `新增 ${added.length} 项，更新 ${updated.length} 项。` : "与上一版相比暂无显著变化。",
  };
}

function citationNumberMap(sections: BriefingDTO["sections"]): { numbers: Map<string, number>; citations: Citation[] } {
  const citations = dedupeCitations(sections.flatMap((section) => section.items.flatMap((item) => item.citations)));
  return { numbers: new Map(citations.map((citation, index) => [citation.articleId, index + 1])), citations };
}

/** 生成带稳定脚注编号的 Markdown，链接与标题始终来自现有 Citation */
export function renderBriefingMarkdown(briefing: BriefingDTO): string {
  const { numbers, citations } = citationNumberMap(briefing.sections);
  const lines = [
    `# ${cleanLine(briefing.title, 300)}`,
    "",
    `> 截止时间：${briefing.cutoffAt}（${briefing.tz}）`,
    "",
  ];
  if (briefing.oneMinuteRead.length) {
    lines.push("## 1 分钟读完", "", ...briefing.oneMinuteRead.map((text) => `- ${cleanLine(text, 1_200)}`), "");
  }
  for (const section of briefing.sections) {
    lines.push(`## ${cleanLine(section.name, 200)}`, "");
    for (const item of section.items) {
      const indexes = item.citations.map((citation) => numbers.get(citation.articleId) || 0).filter(Boolean);
      lines.push(`### ${cleanLine(item.title, 300)}`);
      lines.push(appendCitationMarkers(cleanLine(item.oneLiner, 1_200), indexes));
      lines.push(`- ${cleanLine(item.statusLine, 300)}`);
      if (item.governance) {
        const decision = item.governance.review?.decision === "approve" ? "门下准奏" : "门下封驳";
        const progress = item.governance.workflow.ministryReportProgress;
        lines.push(`- 三省六部：中书聚合 ${item.independentSourceCount} 个独立来源；${decision}；尚书六部 ${progress.completed}/${progress.total} 具报`);
      }
      if (item.changeNote) lines.push(`- 变化：${cleanLine(item.changeNote, 500)}`);
      lines.push("");
    }
  }
  if (citations.length) {
    lines.push("## 来源", "");
    citations.forEach((citation, index) => {
      const published = citation.publishedAt ? `，${citation.publishedAt}` : "";
      lines.push(`[${index + 1}] ${cleanLine(citation.title, 500)} — ${cleanLine(citation.sourceName, 200)}${published}  `);
      lines.push(citation.url);
    });
  }
  return lines.join("\n").trim() + "\n";
}

/** 确定性简报：排序、分栏、差异与引用均在本地完成 */
export function buildExtractiveBriefing(input: GenerateBriefingInput): BriefingDTO {
  const cutoffMs = Date.parse(input.cutoffAt);
  const maxItems = Math.max(1, Math.min(input.maxItems ?? 30, 100));
  const events = input.events
    .filter((event) => {
      if (!event.lastUpdateAt || !Number.isFinite(cutoffMs)) return true;
      const at = Date.parse(event.lastUpdateAt);
      return !Number.isFinite(at) || at <= cutoffMs;
    })
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (b.heat ?? 0) - (a.heat ?? 0) || String(b.lastUpdateAt || "").localeCompare(String(a.lastUpdateAt || "")))
    .slice(0, maxItems);
  const items = events.map((event) => itemFromEvent(event));
  const sectionMap = new Map<string, BriefingItem[]>();
  for (const item of items) sectionMap.set(item.section, [...(sectionMap.get(item.section) || []), item]);
  const sections = [...sectionMap.entries()].map(([name, sectionItems]) => ({ name, items: sectionItems }));
  const { numbers } = citationNumberMap(sections);
  const oneMinuteRead = items.slice(0, 5).map((item) =>
    appendCitationMarkers(item.oneLiner, item.citations.map((citation) => numbers.get(citation.articleId) || 0))
  );
  const briefing: BriefingDTO = {
    id: input.id,
    type: input.type,
    periodKey: input.periodKey,
    createdAt: input.createdAt || input.cutoffAt,
    cutoffAt: input.cutoffAt,
    tz: input.tz,
    title: briefingTitle(input.type, input.cutoffAt),
    oneMinuteRead,
    sections,
    delta: briefingDelta(items, input.previous),
    engine: "extractive",
  };
  briefing.contentMd = renderBriefingMarkdown(briefing);
  return briefing;
}

const BRIEFING_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string" },
    oneMinuteRead: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { eventId: { type: "string" }, text: { type: "string" } },
        required: ["eventId", "text"],
      },
    },
    sections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          name: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                eventId: { type: "string" },
                oneLiner: { type: "string" },
                changeNote: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
              required: ["eventId", "oneLiner", "changeNote"],
            },
          },
        },
        required: ["name", "items"],
      },
    },
  },
  required: ["title", "oneMinuteRead", "sections"],
};

function validateAIBriefing(text: string, input: GenerateBriefingInput): BriefingDTO | null {
  const parsed = parseAIJson(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.oneMinuteRead) || !Array.isArray(parsed.sections)) return null;
  const title = boundedString(parsed.title, 300);
  if (!title || parsed.oneMinuteRead.length > 8 || parsed.sections.length > 12) return null;
  const events = new Map(input.events.map((event) => [event.eventId, event]));
  const selected = new Set<string>();
  const sections: BriefingDTO["sections"] = [];

  for (const rawSection of parsed.sections) {
    if (!isRecord(rawSection) || !Array.isArray(rawSection.items) || rawSection.items.length > 50) return null;
    const rawName = boundedString(rawSection.name, 200);
    if (!rawName) return null;
    const name = cleanLine(rawName, 200);
    const items: BriefingItem[] = [];
    for (const rawItem of rawSection.items) {
      if (!isRecord(rawItem)) return null;
      const eventId = boundedString(rawItem.eventId, 200);
      const rawOneLiner = boundedString(rawItem.oneLiner, 1_200);
      if (!eventId || !rawOneLiner || selected.has(eventId)) return null;
      const event = events.get(eventId);
      if (!event) return null;
      let changeNote: string | null = null;
      if (rawItem.changeNote !== null) {
        const rawChange = boundedString(rawItem.changeNote, 500);
        if (!rawChange) return null;
        changeNote = cleanLine(rawChange, 500);
      }
      selected.add(eventId);
      items.push(itemFromEvent(event, name, cleanLine(rawOneLiner, 1_200), changeNote));
    }
    if (items.length) sections.push({ name, items });
  }
  if (input.events.length > 0 && selected.size === 0) return null;

  const flatItems = sections.flatMap((section) => section.items);
  const { numbers } = citationNumberMap(sections);
  const oneMinuteRead: string[] = [];
  for (const raw of parsed.oneMinuteRead) {
    if (!isRecord(raw)) return null;
    const eventId = boundedString(raw.eventId, 200);
    const rawText = boundedString(raw.text, 1_200);
    if (!eventId || !rawText) return null;
    const item = flatItems.find((candidate) => candidate.eventId === eventId);
    if (!item) return null;
    oneMinuteRead.push(
      appendCitationMarkers(cleanLine(rawText, 1_200), item.citations.map((citation) => numbers.get(citation.articleId) || 0))
    );
  }

  const briefing: BriefingDTO = {
    id: input.id,
    type: input.type,
    periodKey: input.periodKey,
    createdAt: input.createdAt || input.cutoffAt,
    cutoffAt: input.cutoffAt,
    tz: input.tz,
    title: cleanLine(title, 300),
    oneMinuteRead,
    sections,
    delta: briefingDelta(flatItems, input.previous),
    engine: "ai",
  };
  briefing.contentMd = renderBriefingMarkdown(briefing);
  return briefing;
}

function briefingPrompt(input: GenerateBriefingInput): string {
  const records = input.events.map((event) => ({
    eventId: event.eventId,
    title: event.title,
    oneLiner: event.oneLiner || event.summary?.oneLiner || null,
    status: event.status || null,
    importance: event.importance ?? null,
    heat: event.heat ?? null,
    topics: event.topics || [],
    countries: event.countries || [],
    lastUpdateAt: event.lastUpdateAt || null,
    isNew: Boolean(event.isNew),
    changeNote: event.changeNote ?? null,
    citationArticleIds: event.citations.map((citation) => citation.articleId),
    governance: {
      status: event.governance.workflow.status,
      reviewDecision: event.governance.workflow.reviewDecision,
      publishable: event.governance.workflow.publishable,
      independentSources: event.independentSourceCount ?? event.governance.proposal?.independentFamilies ?? 0,
      unverifiedClaims: event.unverifiedCount ?? 0,
      ministryProgress: event.governance.workflow.ministryReportProgress,
      reviewedAt: event.governance.review?.reviewedAt || null,
      completedAt: event.governance.workflow.completedAt,
    },
  }));
  return [
    `请生成 ${input.type} 简报，截止时间为 ${input.cutoffAt}，时区为 ${input.tz}。sections.items 中每个 eventId 只能出现一次；oneMinuteRead 只能引用已进入 sections 的 eventId。不要输出 URL。`,
    untrustedRecordBlock(records, "候选事件及其已有引用"),
  ].join("\n\n");
}

/** AI 编辑失败时返回结构完整、带引用的抽取式简报 */
export async function generateBriefing(
  input: GenerateBriefingInput,
  provider?: AIProvider | null
): Promise<BriefingDTO & { aiError?: string }> {
  const fallback = () => buildExtractiveBriefing(input);
  const result = await runAIOrExtractive(
    provider,
    {
      system: BRIEFING_SYSTEM_PROMPT,
      prompt: briefingPrompt(input),
      mode: "json",
      jsonSchema: BRIEFING_SCHEMA,
      maxTokens: 10_000,
      cacheSystem: true,
    },
    (text) => validateAIBriefing(text, input),
    fallback
  );
  const briefing = result.value;
  briefing.engine = result.engine;
  return result.aiError ? { ...briefing, aiError: result.aiError } : briefing;
}

export const createBriefing = generateBriefing;
