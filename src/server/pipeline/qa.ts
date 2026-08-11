import type { AskFilters, AskResponse, Citation, SourceCategory } from "../../shared/types";
import {
  appendCitationMarkers,
  articleAtOrBefore,
  citationFromArticle,
  dedupeCitations,
  rankArticles,
  type ReportArticle,
} from "../ai/extractive";
import { boundedString, boundedStringArray, isRecord, parseAIJson } from "../ai/json";
import { articlePromptBlock, QA_SYSTEM_PROMPT } from "../ai/prompts";
import { runAIOrExtractive, type AIProvider } from "../ai/provider";
import { detectLang } from "../lib/lang";
import { stripHtml } from "../lib/sanitize";

const OFFICIAL_CATEGORIES = new Set<SourceCategory>(["gov_cn", "official_media_cn", "gov_intl", "intl_org"]);

export interface NewsQuestionInput {
  question: string;
  articles: ReportArticle[];
  cutoff: string;
  filters?: AskFilters;
  maxSources?: number;
}

function filterDescription(filters: AskFilters): string[] {
  const descriptions: string[] = [];
  if (filters.onlyOfficial) descriptions.push("仅使用官方机构、官方媒体或国际组织来源");
  if (filters.onlyCivilian) descriptions.push("排除明确的冲突当事方或非平民来源");
  if (filters.excludeReprints) descriptions.push("排除转载稿");
  if (filters.onlyCrossVerified) descriptions.push("仅使用至少两条独立证据链支持的报道");
  return descriptions;
}

/** 所有问答筛选先在本地执行，模型看不到被排除的文章 */
export function applyAskFilters(
  articles: ReportArticle[],
  filters: AskFilters = {},
  cutoff = new Date().toISOString()
): ReportArticle[] {
  const seen = new Set<string>();
  return articles.filter((article) => {
    if (seen.has(article.id) || !articleAtOrBefore(article, cutoff)) return false;
    seen.add(article.id);
    if (filters.onlyOfficial && (!article.sourceCategory || !OFFICIAL_CATEGORIES.has(article.sourceCategory))) return false;
    if (filters.onlyCivilian && (article.isCivilian === false || article.isParty || article.sourceCategory === "party_media")) return false;
    if (filters.excludeReprints && article.isReprint) return false;
    if (filters.onlyCrossVerified && !article.crossVerified && (article.independentFamilies ?? 0) < 2) return false;
    return true;
  });
}

function baseCaveats(input: NewsQuestionInput, matched: number): string[] {
  const caveats = [`资料截止时间：${input.cutoff}。`];
  caveats.push(...filterDescription(input.filters || {}).map((description) => `筛选条件：${description}。`));
  if (matched === 0) caveats.push("当前筛选范围内没有足够资料支持明确回答。");
  return caveats;
}

function sourceSentence(article: ReportArticle, sentence: string, language: string): string {
  const source = stripHtml(article.sourceName || article.sourceId) || article.sourceId;
  const text = stripHtml(sentence).replace(/\s+/g, " ").trim();
  if (language === "en") return `According to ${source}, ${text}`;
  return `据${source}报道，${text}`;
}

/** 本地自然语言回答：相关句抽取、来源归属和引用编号全部确定性生成 */
export function buildExtractiveAnswer(input: NewsQuestionInput): AskResponse {
  const filters = input.filters || {};
  const available = applyAskFilters(input.articles, filters, input.cutoff);
  const maxSources = Math.max(1, Math.min(input.maxSources ?? 6, 20));
  const ranked = rankArticles(input.question, available, maxSources);
  const relevant = ranked.filter((entry) => entry.score > 0).length > 0 ? ranked.filter((entry) => entry.score > 0) : ranked.slice(0, Math.min(3, ranked.length));
  const language = detectLang(input.question);
  const citations = dedupeCitations(relevant.map((entry) => citationFromArticle(entry.article)));
  const citationNumbers = new Map(citations.map((citation, index) => [citation.articleId, index + 1]));
  const sentences: string[] = [];
  const seenText = new Set<string>();
  for (const entry of relevant) {
    const sentence = sourceSentence(entry.article, entry.bestSentence || entry.article.title, language);
    const key = sentence.toLowerCase();
    if (seenText.has(key)) continue;
    seenText.add(key);
    sentences.push(appendCitationMarkers(sentence, [citationNumbers.get(entry.article.id) || 0]));
    if (sentences.length >= 5) break;
  }

  let answer: string;
  if (sentences.length === 0) {
    answer = language === "en"
      ? `As of ${input.cutoff}, the selected sources do not contain enough information to answer this question.`
      : `截至 ${input.cutoff}，当前筛选范围内没有足够资料回答这个问题。`;
  } else if (language === "en") {
    answer = `As of ${input.cutoff}, the available reporting indicates: ${sentences.join(" ")}`;
  } else {
    answer = `截至 ${input.cutoff}，现有报道显示：${sentences.join(" ")}`;
  }

  return {
    answer,
    citations,
    cutoff: input.cutoff,
    caveats: [
      ...baseCaveats(input, sentences.length),
      "这是抽取式回答，仅复述现有报道；来源中的声明不等于已经独立证实。",
    ],
    engine: "extractive",
    relatedEventIds: [...new Set(relevant.map((entry) => entry.article.eventId).filter((id): id is string => Boolean(id)))],
  };
}

const QA_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    segments: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          text: { type: "string" },
          articleIds: { type: "array", items: { type: "string" } },
        },
        required: ["text", "articleIds"],
      },
    },
    caveats: { type: "array", items: { type: "string" } },
    relatedEventIds: { type: "array", items: { type: "string" } },
  },
  required: ["segments", "caveats", "relatedEventIds"],
};

function validateAIAnswer(text: string, input: NewsQuestionInput, selected: ReportArticle[]): AskResponse | null {
  const parsed = parseAIJson(text);
  if (!isRecord(parsed) || !Array.isArray(parsed.segments) || parsed.segments.length === 0 || parsed.segments.length > 12) return null;
  const articles = new Map(selected.map((article) => [article.id, article]));
  const allowedEvents = new Set(selected.map((article) => article.eventId).filter((id): id is string => Boolean(id)));
  const usedCitations: Citation[] = [];
  const rawSegments: { text: string; articleIds: string[] }[] = [];

  for (const raw of parsed.segments) {
    if (!isRecord(raw)) return null;
    const segmentText = boundedString(raw.text, 1_500);
    const articleIds = boundedStringArray(raw.articleIds, 6, 200);
    if (!segmentText || !articleIds || articleIds.length === 0 || articleIds.some((id) => !articles.has(id))) return null;
    const clean = stripHtml(segmentText).replace(/\s+/g, " ").trim();
    if (!clean) return null;
    rawSegments.push({ text: clean, articleIds });
    usedCitations.push(...articleIds.map((id) => citationFromArticle(articles.get(id)!)));
  }

  const citations = dedupeCitations(usedCitations);
  const numbers = new Map(citations.map((citation, index) => [citation.articleId, index + 1]));
  const answer = rawSegments
    .map((segment) => appendCitationMarkers(segment.text, segment.articleIds.map((id) => numbers.get(id) || 0)))
    .join("\n\n");
  const modelCaveats = boundedStringArray(parsed.caveats, 8, 500);
  const relatedEventIds = boundedStringArray(parsed.relatedEventIds, 20, 200);
  if (!modelCaveats || !relatedEventIds || relatedEventIds.some((id) => !allowedEvents.has(id))) return null;

  return {
    answer,
    citations,
    cutoff: input.cutoff,
    caveats: [...new Set([...baseCaveats(input, rawSegments.length), ...modelCaveats.map((item) => stripHtml(item).trim()).filter(Boolean)])],
    engine: "ai",
    relatedEventIds,
  };
}

function qaPrompt(input: NewsQuestionInput, selected: ReportArticle[]): string {
  const filters = filterDescription(input.filters || {});
  const blocks = [
    `问题：${input.question}\n截止时间：${input.cutoff}\n筛选条件：${filters.length ? filters.join("；") : "无额外筛选"}\n请把答案拆成 segments；每段 articleIds 必须是实际支持该段文字的输入文章。不要输出 URL，也不要使用输入外知识补全事实。`,
  ];
  selected.forEach((article, index) => blocks.push(articlePromptBlock(article, index)));
  return blocks.join("\n\n");
}

/** AI 回答经过文章 ID 白名单校验；任何失败都返回带截止时间和引用的本地答案 */
export async function answerNewsQuestion(
  input: NewsQuestionInput,
  provider?: AIProvider | null
): Promise<AskResponse & { aiError?: string }> {
  const available = applyAskFilters(input.articles, input.filters || {}, input.cutoff);
  const selected = rankArticles(input.question, available, Math.max(1, Math.min(input.maxSources ?? 12, 20))).map((entry) => entry.article);
  const fallback = () => buildExtractiveAnswer(input);
  if (selected.length === 0) return fallback();

  const result = await runAIOrExtractive(
    provider,
    {
      system: QA_SYSTEM_PROMPT,
      prompt: qaPrompt(input, selected),
      mode: "json",
      jsonSchema: QA_SCHEMA,
      maxTokens: 8_192,
      cacheSystem: true,
    },
    (text) => validateAIAnswer(text, input, selected),
    fallback
  );
  result.value.engine = result.engine;
  return result.aiError ? { ...result.value, aiError: result.aiError } : result.value;
}

export const answerQuestion = answerNewsQuestion;
