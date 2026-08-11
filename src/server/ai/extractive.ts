import type { Citation, SourceCategory } from "../../shared/types";
import { stripHtml, textExcerpt } from "../lib/sanitize";
import { tokensOf } from "../lib/textsim";

/** 报告层所需的最小文章视图，可由数据库联表或 ArticleDTO 转换得到 */
export interface ReportArticle {
  id: string;
  sourceId: string;
  sourceName?: string;
  sourceCategory?: SourceCategory;
  url: string;
  title: string;
  lang?: string | null;
  publishedAt?: string | null;
  firstSeenAt?: string | null;
  excerpt?: string | null;
  bodyText?: string | null;
  isReprint?: boolean;
  wireFamily?: string | null;
  eventId?: string | null;
  isParty?: boolean;
  partyOf?: string | null;
  familyKey?: string | null;
  isCivilian?: boolean;
  crossVerified?: boolean;
  independentFamilies?: number;
}

export function cleanArticleText(article: ReportArticle): string {
  const body = stripHtml(article.bodyText || "");
  const excerpt = stripHtml(article.excerpt || "");
  return body || excerpt || stripHtml(article.title);
}

export function citationFromArticle(article: ReportArticle): Citation {
  return {
    articleId: article.id,
    title: stripHtml(article.title) || article.id,
    url: article.url,
    sourceId: article.sourceId,
    sourceName: stripHtml(article.sourceName || article.sourceId) || article.sourceId,
    sourceCategory: article.sourceCategory || (article.isParty ? "party_media" : "intl_media"),
    lang: article.lang ?? null,
    publishedAt: article.publishedAt ?? null,
    isParty: article.isParty,
    partyOf: article.partyOf ?? null,
  };
}

export function dedupeCitations(citations: Iterable<Citation | null | undefined>): Citation[] {
  const out: Citation[] = [];
  const seen = new Set<string>();
  for (const citation of citations) {
    if (!citation || seen.has(citation.articleId)) continue;
    seen.add(citation.articleId);
    out.push(citation);
  }
  return out;
}

/** 把纯文本切成可引用的短句，兼容中英文与常见多语言终止符 */
export function splitSentences(text: string, max = 80): string[] {
  const clean = stripHtml(text).replace(/\r/g, "\n").trim();
  if (!clean) return [];
  const matches = clean.match(/[^。！？!?\n.]+(?:[。！？!?.]+|$)/gu) || [];
  const out: string[] = [];
  for (const raw of matches) {
    const sentence = raw.replace(/\s+/g, " ").trim();
    if (sentence.length < 12) continue;
    out.push(sentence.length > 500 ? textExcerpt(sentence, 500) : sentence);
    if (out.length >= max) break;
  }
  return out;
}

function tokenSet(text: string): Set<string> {
  return new Set(tokensOf(text).filter((token) => token.length > 1 || /\d/.test(token)));
}

export function textRelevance(question: string, text: string): number {
  const query = tokenSet(question);
  if (query.size === 0) return 0;
  const target = tokenSet(text);
  let overlap = 0;
  for (const token of query) if (target.has(token)) overlap++;
  return overlap / query.size;
}

export interface RankedArticle {
  article: ReportArticle;
  score: number;
  bestSentence: string;
}

/** 纯本地相关性排序：标题权重最高，正文只用于补充证据句 */
export function rankArticles(question: string, articles: ReportArticle[], limit = 12): RankedArticle[] {
  const ranked: RankedArticle[] = [];
  for (const article of articles) {
    const title = stripHtml(article.title);
    const excerpt = stripHtml(article.excerpt || "");
    const body = cleanArticleText(article);
    const sentences = splitSentences(body, 60);
    let bestSentence = excerpt || title;
    let bestSentenceScore = textRelevance(question, bestSentence);
    for (const sentence of sentences) {
      const score = textRelevance(question, sentence);
      if (score > bestSentenceScore) {
        bestSentence = sentence;
        bestSentenceScore = score;
      }
    }
    const titleScore = textRelevance(question, title);
    const excerptScore = textRelevance(question, excerpt);
    let score = titleScore * 5 + excerptScore * 2 + bestSentenceScore * 3;
    if (article.crossVerified || (article.independentFamilies ?? 0) >= 2) score += 0.35;
    if (!article.isReprint) score += 0.05;
    ranked.push({ article, score, bestSentence: bestSentence || title });
  }
  return ranked
    .sort((a, b) => b.score - a.score || String(b.article.publishedAt || "").localeCompare(String(a.article.publishedAt || "")))
    .slice(0, Math.max(0, limit));
}

export function articleAtOrBefore(article: ReportArticle, cutoff: string): boolean {
  const at = article.publishedAt || article.firstSeenAt;
  if (!at) return true;
  const parsed = Date.parse(at);
  const cutoffMs = Date.parse(cutoff);
  return !Number.isFinite(parsed) || !Number.isFinite(cutoffMs) || parsed <= cutoffMs;
}

export function appendCitationMarkers(text: string, citationIndexes: number[]): string {
  const markers = [...new Set(citationIndexes)]
    .filter((index) => Number.isInteger(index) && index > 0)
    .map((index) => `[${index}]`)
    .join("");
  return `${text.trim()}${markers ? ` ${markers}` : ""}`;
}
