import { PARTY_LABELS, TOPIC_LABELS } from "../../shared/constants";
import type { ClaimDTO, Citation, DisputeGroup, EventSummaryDTO, StatementGroup } from "../../shared/types";
import { boundedString, boundedStringArray, isRecord, parseAIJson } from "./json";
import { articlePromptBlock, EVENT_SUMMARY_SYSTEM_PROMPT, untrustedRecordBlock } from "./prompts";
import { runAIOrExtractive, type AIProvider } from "./provider";
import {
  citationFromArticle,
  dedupeCitations,
  type ReportArticle,
} from "./extractive";

export interface EventSummaryInput {
  eventId: string;
  title: string;
  importance?: number;
  topics?: string[];
  countries?: string[];
  claims: ClaimDTO[];
  articles?: ReportArticle[];
}

export interface GeneratedEventSummary {
  summary: EventSummaryDTO;
  engine: "ai" | "extractive";
  aiError?: string;
}

function citationIndex(input: EventSummaryInput): Map<string, Citation> {
  const map = new Map<string, Citation>();
  for (const article of input.articles || []) map.set(article.id, citationFromArticle(article));
  for (const claim of input.claims) {
    for (const evidence of claim.evidence) {
      if (evidence.citation) map.set(evidence.citation.articleId, evidence.citation);
    }
  }
  return map;
}

function citationsForClaim(claim: ClaimDTO, all: Map<string, Citation>): Citation[] {
  return dedupeCitations(
    claim.evidence.map((evidence) => evidence.citation || all.get(evidence.articleId))
  );
}

function claimParty(claim: ClaimDTO): string | null {
  return claim.party || claim.claimedBy || null;
}

function ruleWhyItMatters(input: EventSummaryInput): EventSummaryDTO["whyItMatters"] {
  const topic = (input.topics || []).find((key) => TOPIC_LABELS[key]);
  if ((input.importance ?? 0) >= 80) {
    return { text: "该事件影响范围较大，后续官方确认、数字修订和各方回应都可能改变当前判断。", generatedBy: "rule" };
  }
  if (topic) {
    return { text: `该事件涉及${TOPIC_LABELS[topic]}，需持续关注后续独立证据与政策反应。`, generatedBy: "rule" };
  }
  if ((input.countries || []).length > 1) {
    return { text: "该事件涉及多个国家或地区，后续外交回应与跨来源核验值得关注。", generatedBy: "rule" };
  }
  return null;
}

/** 完全本地的事件摘要，不调用网络，且只使用现有引用对象 */
export function buildExtractiveEventSummary(input: EventSummaryInput): EventSummaryDTO {
  const allCitations = citationIndex(input);
  const confirmed: EventSummaryDTO["confirmed"] = [];
  const unverified: EventSummaryDTO["unverified"] = [];
  const statementMap = new Map<string, StatementGroup>();
  const disputed: DisputeGroup[] = [];

  for (const claim of input.claims) {
    const citations = citationsForClaim(claim, allCitations);
    const party = claimParty(claim);
    if (party) {
      const group = statementMap.get(party) || {
        party,
        partyLabel: PARTY_LABELS[party] || claim.claimedBy || party,
        items: [],
      };
      group.items.push({ text: claim.text, status: claim.status, claimId: claim.id, citations });
      statementMap.set(party, group);
    } else if (claim.status === "corroborated") {
      confirmed.push({ text: claim.text, claimId: claim.id, citations });
    } else if (["reported", "unverified", "partially_corroborated"].includes(claim.status)) {
      unverified.push({ text: claim.text, claimId: claim.id, citations });
    }

    if (claim.status === "disputed" || claim.status === "refuted") {
      disputed.push({
        topic: claim.text,
        positions: [
          {
            party: party || "other",
            text: claim.text,
            number: claim.subjectNumber,
            asOf: claim.asOf,
            citation: citations[0] || null,
          },
        ],
      });
    }
  }

  if (input.claims.length === 0) {
    for (const article of (input.articles || []).slice(0, 4)) {
      unverified.push({
        text: article.excerpt?.trim() || article.title,
        claimId: `article:${article.id}`,
        citations: [citationFromArticle(article)],
      });
    }
  }

  return {
    oneLiner: input.title.trim() || confirmed[0]?.text || unverified[0]?.text || "暂无可用摘要",
    confirmed,
    statements: [...statementMap.values()],
    unverified,
    disputed,
    whyItMatters: ruleWhyItMatters(input),
  };
}

const EVENT_SUMMARY_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    oneLiner: { type: "string" },
    confirmed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claimId: { type: "string" },
          text: { type: "string" },
          articleIds: { type: "array", items: { type: "string" } },
        },
        required: ["claimId", "text", "articleIds"],
      },
    },
    statements: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          party: { type: "string" },
          items: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                claimId: { type: "string" },
                text: { type: "string" },
                articleIds: { type: "array", items: { type: "string" } },
              },
              required: ["claimId", "text", "articleIds"],
            },
          },
        },
        required: ["party", "items"],
      },
    },
    unverified: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claimId: { type: "string" },
          text: { type: "string" },
          articleIds: { type: "array", items: { type: "string" } },
        },
        required: ["claimId", "text", "articleIds"],
      },
    },
    disputed: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          topic: { type: "string" },
          positions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                claimId: { type: "string" },
                text: { type: "string" },
                articleIds: { type: "array", items: { type: "string" } },
              },
              required: ["claimId", "text", "articleIds"],
            },
          },
        },
        required: ["topic", "positions"],
      },
    },
    whyItMatters: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["oneLiner", "confirmed", "statements", "unverified", "disputed", "whyItMatters"],
};

interface ValidatedClaimItem {
  claim: ClaimDTO;
  text: string;
  citations: Citation[];
}

function validateClaimItem(
  value: unknown,
  claims: Map<string, ClaimDTO>,
  citations: Map<string, Citation>,
  allowedStatuses?: Set<string>
): ValidatedClaimItem | null {
  if (!isRecord(value)) return null;
  const claimId = boundedString(value.claimId, 200);
  const text = boundedString(value.text, 1_200);
  const articleIds = boundedStringArray(value.articleIds, 20, 200);
  if (!claimId || !text || !articleIds) return null;
  const claim = claims.get(claimId);
  if (!claim || (allowedStatuses && !allowedStatuses.has(claim.status))) return null;

  const allowed = new Set(claim.evidence.map((evidence) => evidence.articleId));
  if (articleIds.some((id) => !allowed.has(id) || !citations.has(id))) return null;
  const mapped = dedupeCitations(articleIds.map((id) => citations.get(id)));
  if (allowed.size > 0 && mapped.length === 0) return null;
  return { claim, text, citations: mapped };
}

function validateAIEventSummary(text: string, input: EventSummaryInput): EventSummaryDTO | null {
  const parsed = parseAIJson(text);
  if (!isRecord(parsed)) return null;
  const oneLiner = boundedString(parsed.oneLiner, 500);
  if (!oneLiner || !Array.isArray(parsed.confirmed) || !Array.isArray(parsed.statements) || !Array.isArray(parsed.unverified) || !Array.isArray(parsed.disputed)) return null;
  if (parsed.confirmed.length > 30 || parsed.statements.length > 20 || parsed.unverified.length > 30 || parsed.disputed.length > 20) return null;

  const claims = new Map(input.claims.map((claim) => [claim.id, claim]));
  const citations = citationIndex(input);
  const confirmed: EventSummaryDTO["confirmed"] = [];
  const unverified: EventSummaryDTO["unverified"] = [];
  const statements: StatementGroup[] = [];
  const disputed: DisputeGroup[] = [];

  for (const raw of parsed.confirmed) {
    const item = validateClaimItem(raw, claims, citations, new Set(["corroborated"]));
    if (!item || claimParty(item.claim)) return null;
    confirmed.push({ text: item.text, claimId: item.claim.id, citations: item.citations });
  }

  for (const rawGroup of parsed.statements) {
    if (!isRecord(rawGroup) || !Array.isArray(rawGroup.items) || rawGroup.items.length > 30) return null;
    const requestedParty = boundedString(rawGroup.party, 200);
    if (!requestedParty) return null;
    const grouped = new Map<string, StatementGroup>();
    for (const raw of rawGroup.items) {
      const item = validateClaimItem(raw, claims, citations);
      if (!item) return null;
      const party = claimParty(item.claim);
      if (!party || party !== requestedParty) return null;
      const group = grouped.get(party) || {
        party,
        partyLabel: PARTY_LABELS[party] || item.claim.claimedBy || party,
        items: [],
      };
      group.items.push({ text: item.text, status: item.claim.status, claimId: item.claim.id, citations: item.citations });
      grouped.set(party, group);
    }
    statements.push(...grouped.values());
  }

  for (const raw of parsed.unverified) {
    const item = validateClaimItem(raw, claims, citations, new Set(["reported", "unverified", "partially_corroborated"]));
    if (!item || claimParty(item.claim)) return null;
    unverified.push({ text: item.text, claimId: item.claim.id, citations: item.citations });
  }

  for (const rawGroup of parsed.disputed) {
    if (!isRecord(rawGroup) || !Array.isArray(rawGroup.positions) || rawGroup.positions.length === 0 || rawGroup.positions.length > 12) return null;
    const topic = boundedString(rawGroup.topic, 1_000);
    if (!topic) return null;
    const positions: DisputeGroup["positions"] = [];
    for (const raw of rawGroup.positions) {
      const item = validateClaimItem(raw, claims, citations, new Set(["disputed", "refuted"]));
      if (!item) return null;
      positions.push({
        party: claimParty(item.claim) || "other",
        text: item.text,
        number: item.claim.subjectNumber,
        asOf: item.claim.asOf,
        citation: item.citations[0] || null,
      });
    }
    disputed.push({ topic, positions });
  }

  const whyText = parsed.whyItMatters === null ? null : boundedString(parsed.whyItMatters, 1_200);
  if (parsed.whyItMatters !== null && whyText === null) return null;
  if (input.claims.length > 0 && confirmed.length + statements.reduce((n, group) => n + group.items.length, 0) + unverified.length + disputed.length === 0) return null;

  return {
    oneLiner,
    confirmed,
    statements,
    unverified,
    disputed,
    whyItMatters: whyText ? { text: whyText, generatedBy: "ai" } : null,
  };
}

function eventSummaryPrompt(input: EventSummaryInput): string {
  const claimData = input.claims.map((claim) => ({
    claimId: claim.id,
    text: claim.text,
    type: claim.type,
    claimedBy: claim.claimedBy,
    party: claim.party,
    status: claim.status,
    number: claim.subjectNumber,
    unit: claim.numberUnit,
    asOf: claim.asOf,
    evidence: claim.evidence.map((evidence) => ({
      articleId: evidence.articleId,
      stance: evidence.stance,
      note: evidence.note,
    })),
  }));
  const blocks = [
    "请整理以下事件。confirmed 只能放 status=corroborated 且无当事方归属的 claim；statements 按 claim 自带 party 分组；unverified 只能放 reported/unverified/partially_corroborated；disputed 只能引用 disputed/refuted。每项 articleIds 必须来自该 claim 的 evidence。",
    untrustedRecordBlock(
      {
        eventId: input.eventId,
        title: input.title,
        importance: input.importance ?? null,
        topics: input.topics || [],
        countries: input.countries || [],
      },
      "事件元数据"
    ),
    untrustedRecordBlock(claimData, "主张与证据索引"),
  ];
  for (const [index, article] of (input.articles || []).entries()) blocks.push(articlePromptBlock(article, index));
  return blocks.join("\n\n");
}

/** 优先使用 AI；拒绝、网络错误、截断、非法 JSON 或伪造引用都会自动回退 */
export async function generateEventSummary(
  input: EventSummaryInput,
  provider?: AIProvider | null
): Promise<GeneratedEventSummary> {
  const fallback = () => buildExtractiveEventSummary(input);
  if (input.claims.length === 0) return { summary: fallback(), engine: "extractive" };
  const result = await runAIOrExtractive(
    provider,
    {
      system: EVENT_SUMMARY_SYSTEM_PROMPT,
      prompt: eventSummaryPrompt(input),
      mode: "json",
      jsonSchema: EVENT_SUMMARY_SCHEMA,
      maxTokens: 8_192,
      cacheSystem: true,
    },
    (text) => validateAIEventSummary(text, input),
    fallback
  );
  return { summary: result.value, engine: result.engine, aiError: result.aiError };
}

export const summarizeEvent = generateEventSummary;
