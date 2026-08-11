import type { FetchedItem } from "../adapters/types";
import { articleVersions, articles, sources } from "../db/schema";
import { sha256Hex, shortId } from "../lib/hash";
import { yieldToEventLoop } from "../lib/async";
import { detectLang } from "../lib/lang";
import { isPaywalledDomain } from "../lib/paywall";
import { stripHtml, textExcerpt } from "../lib/sanitize";
import { hamming, simhash64 } from "../lib/simhash";
import { extractNumbers, normalizeText, normalizeTitle, tokensOf } from "../lib/textsim";
import { baseDomain, domainOf, normalizeUrl } from "../lib/urls";

export type ArticleRow = typeof articles.$inferSelect;
export type ArticleInsert = typeof articles.$inferInsert;
export type ArticleVersionInsert = typeof articleVersions.$inferInsert;
export type SourceRow = typeof sources.$inferSelect;

export type DuplicateKind = "exact" | "update" | "reprint" | "distinct";

export interface ArticlePreparationSource {
  id: string;
  lang?: string | null;
  paywalled?: boolean;
}

export interface PrepareArticleOptions {
  /** 抓取发生时间必须由调用方注入，避免隐藏时钟影响测试 */
  seenAt: string;
  canonicalUrl?: string | null;
}

export interface ComparableArticle {
  id: string;
  sourceId?: string;
  url?: string;
  canonicalUrl?: string | null;
  normalizedUrl: string;
  guid?: string | null;
  title: string;
  titleNorm?: string;
  bodyText?: string | null;
  excerpt?: string | null;
  contentHash?: string | null;
  simhash?: string | null;
  publishedAt?: string | null;
  firstSeenAt?: string | null;
  srcUpdatedAt?: string | null;
  isReprint?: boolean;
  reprintOf?: string | null;
  wireFamily?: string | null;
}

export interface DedupeOptions {
  /** 近似转载允许的最大发布间隔 */
  maxReprintHours?: number;
  /** 正文哈希相同仍允许判为转载的最大发布间隔 */
  maxExactHashHours?: number;
  /** 近似转载允许的最大 SimHash 汉明距离 */
  maxHamming?: number;
  /** 近似转载最低综合分 */
  minReprintScore?: number;
}

export interface DuplicateDecision {
  kind: DuplicateKind;
  score: number;
  reasons: string[];
  candidateId: string;
  reprintOf: string | null;
  wireFamily: string | null;
}

export interface ReprintCandidate {
  article: ComparableArticle;
  source?: Pick<SourceRow, "id" | "familyId"> & { familyKind?: string | null };
}

export interface ReprintFamilyResult {
  isReprint: boolean;
  reprintOf: string | null;
  wireFamily: string | null;
  score: number;
  reasons: string[];
  matchedArticleId: string | null;
  /** 首次建立转载家族时应同步写回根稿的 family 值 */
  rootFamilyPatch: { articleId: string; wireFamily: string } | null;
}

export interface ArticleAnchors {
  numbers: string[];
  dates: string[];
  identityNumbers: string[];
  casualtyNumbers: string[];
}

const DEFAULT_REPRINT_HOURS = 96;
const DEFAULT_EXACT_HASH_HOURS = 336;
const DEFAULT_MAX_HAMMING = 5;
const DEFAULT_MIN_REPRINT_SCORE = 0.78;
const DEFAULT_COMPARISON_BATCH_SIZE = 64;
const VALID_SIMHASH_RE = /^[0-9a-f]{16}$/i;
const DATE_TOKEN_RE = /\b(?:19|20)\d{2}[\-/.](?:0?[1-9]|1[0-2])[\-/.](?:0?[1-9]|[12]\d|3[01])\b|(?:19|20)\d{2}年(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\d|3[01])日|\b(?:0?[1-9]|1[0-2])[\-/.](?:0?[1-9]|[12]\d|3[01])\b|(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\d|3[01])日/gi;
const IDENTITY_PAIR_RE = /(航班|班次|法案|议案|决议|公路|国道|省道|型号|机型|舰号|震级|magnitude|flight|bill|resolution|route|model)\s*(?:编号|号码|no\.?|number|第)?\s*([a-z]{0,4}\d+(?:\.\d+)?)/gi;
const REVERSE_IDENTITY_PAIR_RE = /([a-z]{0,4}\d+(?:\.\d+)?)\s*(?:号)?\s*(航班|班次|法案|议案|决议|公路|国道|省道|型号|机型|舰号)/gi;
const CASUALTY_CONTEXT_RE = /死亡|遇难|丧生|受伤|伤亡|失踪|死者|伤者|killed|dead|deaths?|injured|wounded|casualt(?:y|ies)|missing/i;

/** 将阿拉伯-印度数字与波斯数字折叠为 ASCII 数字 */
export function foldUnicodeDigits(input: string): string {
  return input
    .replace(/[٠-٩]/g, (ch) => String(ch.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (ch) => String(ch.charCodeAt(0) - 0x06f0));
}

function normalizedNumber(value: string): string {
  const compact = value.replace(/[,，\s]/g, "");
  const numeric = Number(compact);
  return Number.isFinite(numeric) ? String(numeric) : compact;
}

/** 提取规范化数字锚点，逗号分组数字不会被拆开 */
export function extractNumericAnchors(text: string): string[] {
  const folded = foldUnicodeDigits(text).replace(/(?<=\d)[,，](?=\d)/g, "");
  return [...new Set(extractNumbers(folded).map(normalizedNumber))].slice(0, 12);
}

/** 提取标题中的显式日期锚点 */
export function extractDateAnchors(text: string): string[] {
  const folded = foldUnicodeDigits(text);
  const matches = folded.match(DATE_TOKEN_RE) || [];
  return [...new Set(matches.map((value) => value.replace(/[年月/.]/g, "-").replace(/日/g, "").replace(/-+/g, "-").replace(/^-|-$/g, "")))].slice(0, 8);
}

function numbersNearContext(text: string, context: RegExp): string[] {
  const folded = foldUnicodeDigits(text);
  const out = new Set<string>();
  const numberRe = /\d[\d,，]*(?:\.\d+)?/g;
  for (const match of folded.matchAll(numberRe)) {
    const start = Math.max(0, (match.index || 0) - 28);
    const end = Math.min(folded.length, (match.index || 0) + match[0].length + 28);
    if (context.test(folded.slice(start, end))) out.add(normalizedNumber(match[0]));
  }
  return [...out].slice(0, 8);
}

function identityKind(raw: string): string {
  if (/航班|班次|flight/i.test(raw)) return "flight";
  if (/法案|议案|决议|bill|resolution/i.test(raw)) return "law";
  if (/公路|国道|省道|route/i.test(raw)) return "route";
  if (/震级|magnitude/i.test(raw)) return "magnitude";
  if (/舰号/i.test(raw)) return "vessel";
  return "model";
}

function identityAnchors(text: string): string[] {
  const folded = foldUnicodeDigits(text);
  const out = new Set<string>();
  for (const match of folded.matchAll(IDENTITY_PAIR_RE)) {
    out.add(`${identityKind(match[1])}:${normalizedNumber(match[2]).toLowerCase()}`);
  }
  for (const match of folded.matchAll(REVERSE_IDENTITY_PAIR_RE)) {
    out.add(`${identityKind(match[2])}:${normalizedNumber(match[1]).toLowerCase()}`);
  }
  return [...out].sort().slice(0, 8);
}

/** 提取用于去重和事件聚类的数字、日期与身份锚点 */
export function extractArticleAnchors(title: string, bodyText = ""): ArticleAnchors {
  const text = `${title}\n${bodyText}`.slice(0, 4000);
  return {
    numbers: extractNumericAnchors(text),
    dates: extractDateAnchors(title),
    identityNumbers: identityAnchors(title),
    casualtyNumbers: numbersNearContext(text, CASUALTY_CONTEXT_RE),
  };
}

function firstUsefulLine(text: string): string {
  for (const line of text.split(/\n+/)) {
    const clean = line.replace(/\s+/g, " ").trim();
    if (clean) return textExcerpt(clean, 120);
  }
  return "";
}

function normalizedIso(value?: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

/** 将适配器条目转换为可直接写入 articles 的稳定结构 */
export function prepareArticle(
  source: ArticlePreparationSource,
  item: FetchedItem,
  options: PrepareArticleOptions
): ArticleInsert {
  const summaryText = stripHtml(item.summaryHtml || "");
  const contentText = stripHtml(item.contentHtml || "");
  const bodyText = contentText || summaryText || null;
  const normalizedUrl = normalizeUrl(item.url);
  const canonicalUrl = options.canonicalUrl ? normalizeUrl(options.canonicalUrl) : null;
  const fallback = firstUsefulLine(bodyText || "") || domainOf(canonicalUrl || normalizedUrl) || "未命名内容";
  const title = item.title.replace(/\s+/g, " ").trim() || fallback;
  const titleNorm = normalizeTitle(title);
  const normalizedBody = normalizeText(bodyText || "");
  const similarityText = `${title}\n${bodyText || summaryText}`.trim();
  const enoughForSimhash = normalizeText(similarityText).length >= 24 && tokensOf(similarityText).length >= 6;
  const guid = item.guid?.trim() || null;
  const idSeed = canonicalUrl || normalizedUrl || `${source.id}:${guid || titleNorm}`;
  const firstSeenAt = normalizedIso(options.seenAt) || options.seenAt;

  return {
    id: shortId(idSeed),
    sourceId: source.id,
    url: item.url.trim(),
    canonicalUrl,
    normalizedUrl,
    guid,
    title,
    titleNorm,
    author: item.author?.trim() || null,
    lang: detectLang(`${title}\n${bodyText || ""}`, item.lang || source.lang || null),
    publishedAt: normalizedIso(item.publishedAt),
    srcUpdatedAt: normalizedIso(item.updatedAt),
    firstSeenAt,
    lastCrawledAt: firstSeenAt,
    bodyText,
    excerpt: textExcerpt(summaryText || bodyText || "", 280) || null,
    imageUrl: item.imageUrl || null,
    contentHash: normalizedBody.length >= 12 ? sha256Hex(normalizedBody) : null,
    simhash: enoughForSimhash ? simhash64(similarityText) : null,
    isReprint: false,
    reprintOf: null,
    wireFamily: null,
    paywalled: Boolean(source.paywalled || isPaywalledDomain(item.url)),
    eventId: null,
    status: "new",
    extra: item.extra || null,
  };
}

export const normalizeFetchedArticle = prepareArticle;

function effectiveTime(article: ComparableArticle): number | null {
  const raw = article.publishedAt || article.firstSeenAt;
  if (!raw) return null;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : null;
}

function hoursBetween(a: ComparableArticle, b: ComparableArticle): number | null {
  const left = effectiveTime(a);
  const right = effectiveTime(b);
  if (left === null || right === null) return null;
  return Math.abs(left - right) / 3_600_000;
}

function articleText(article: ComparableArticle): string {
  return `${article.title}\n${article.bodyText || article.excerpt || ""}`.trim();
}

interface ComparableFeatures {
  anchors: ArticleAnchors;
  bodyLength: number;
  articleTokens: Set<string>;
  titleTokens: Set<string>;
  bodyTokens: Set<string>;
}

const comparableFeatureCache = new WeakMap<object, ComparableFeatures>();

function comparableFeatures(article: ComparableArticle): ComparableFeatures {
  const cached = comparableFeatureCache.get(article);
  if (cached) return cached;
  const body = article.bodyText || article.excerpt || "";
  const features: ComparableFeatures = {
    anchors: extractArticleAnchors(article.title, body),
    bodyLength: normalizeText(body).length,
    articleTokens: new Set(tokensOf(articleText(article))),
    titleTokens: new Set(tokensOf(article.title)),
    bodyTokens: new Set(tokensOf(body)),
  };
  comparableFeatureCache.set(article, features);
  return features;
}

function tokenSetJaccard(left: ReadonlySet<string>, right: ReadonlySet<string>): number {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

function isSameUrlOrGuid(a: ComparableArticle, b: ComparableArticle): boolean {
  const leftUrls = new Set([a.canonicalUrl, a.normalizedUrl].filter((value): value is string => Boolean(value)));
  const rightUrls = new Set([b.canonicalUrl, b.normalizedUrl].filter((value): value is string => Boolean(value)));
  for (const value of leftUrls) if (rightUrls.has(value)) return true;
  return Boolean(a.sourceId && b.sourceId && a.sourceId === b.sourceId && a.guid && b.guid && a.guid === b.guid);
}

function articleChanged(a: ComparableArticle, b: ComparableArticle): boolean {
  if (a.contentHash && b.contentHash && a.contentHash !== b.contentHash) return true;
  if ((a.titleNorm || normalizeTitle(a.title)) !== (b.titleNorm || normalizeTitle(b.title))) return true;
  return Boolean(a.srcUpdatedAt && b.srcUpdatedAt && a.srcUpdatedAt !== b.srcUpdatedAt);
}

function shared(setA: string[], setB: string[]): boolean {
  const right = new Set(setB);
  return setA.some((value) => right.has(value));
}

function anchorPenalty(incoming: ComparableArticle, candidate: ComparableArticle): { penalty: number; reasons: string[]; blocked: boolean } {
  const left = comparableFeatures(incoming).anchors;
  const right = comparableFeatures(candidate).anchors;
  const reasons: string[] = [];
  let penalty = 0;
  let blocked = false;

  if (left.dates.length > 0 && right.dates.length > 0 && !shared(left.dates, right.dates)) {
    penalty += 0.35;
    reasons.push("显式日期锚点冲突");
  }
  if (left.identityNumbers.length > 0 && right.identityNumbers.length > 0 && !shared(left.identityNumbers, right.identityNumbers)) {
    penalty += 0.45;
    blocked = true;
    reasons.push("航班、法案、型号或灾害编号等身份数字冲突");
  } else if (left.numbers.length > 0 && right.numbers.length > 0 && !shared(left.numbers, right.numbers)) {
    const casualtyOnly = left.casualtyNumbers.length > 0 && right.casualtyNumbers.length > 0;
    penalty += casualtyOnly ? 0.08 : 0.2;
    reasons.push(casualtyOnly ? "伤亡数字存在更新差异" : "数字锚点不一致");
  }
  return { penalty, reasons, blocked };
}

/** 判定两个条目是同一 URL 更新、转载稿还是独立报道 */
export function classifyDuplicate(
  incoming: ComparableArticle,
  candidate: ComparableArticle,
  options: DedupeOptions = {}
): DuplicateDecision {
  const reasons: string[] = [];
  if (isSameUrlOrGuid(incoming, candidate)) {
    const changed = articleChanged(incoming, candidate);
    reasons.push(changed ? "规范 URL 或同源 GUID 相同，但内容发生变化" : "规范 URL 或同源 GUID 相同");
    return {
      kind: changed ? "update" : "exact",
      score: 1,
      reasons,
      candidateId: candidate.id,
      reprintOf: null,
      wireFamily: candidate.wireFamily || null,
    };
  }

  const maxHours = options.maxReprintHours ?? DEFAULT_REPRINT_HOURS;
  const gapHours = hoursBetween(incoming, candidate);
  const exactHashHours = options.maxExactHashHours ?? DEFAULT_EXACT_HASH_HOURS;
  const sameContentHash = Boolean(incoming.contentHash && candidate.contentHash && incoming.contentHash === candidate.contentHash);

  if (gapHours !== null && gapHours > maxHours && (!sameContentHash || gapHours > exactHashHours)) {
    return {
      kind: "distinct",
      score: 0,
      reasons: [`发布时间相差 ${gapHours.toFixed(1)} 小时，超出转载窗口`],
      candidateId: candidate.id,
      reprintOf: null,
      wireFamily: null,
    };
  }

  if (sameContentHash) {
    const left = comparableFeatures(incoming);
    const right = comparableFeatures(candidate);
    const anchors = anchorPenalty(incoming, candidate);
    const bodyLength = Math.min(left.bodyLength, right.bodyLength);
    const tokenCount = Math.min(left.articleTokens.size, right.articleTokens.size);
    const titleSimilarity = tokenSetJaccard(left.titleTokens, right.titleTokens);
    const invalidHashShortcut =
      anchors.blocked ||
      anchors.reasons.includes("显式日期锚点冲突") ||
      bodyLength < 64 ||
      tokenCount < 8 ||
      (gapHours !== null && gapHours > exactHashHours) ||
      (titleSimilarity < 0.15 && bodyLength < 300);
    if (!invalidHashShortcut) {
      reasons.push("不同 URL 的有效正文内容哈希完全相同");
      if (gapHours !== null) reasons.push(`发布时间相差 ${gapHours.toFixed(1)} 小时`);
      const root = candidate.reprintOf || candidate.id;
      return {
        kind: "reprint",
        score: 1,
        reasons,
        candidateId: candidate.id,
        reprintOf: root,
        wireFamily: candidate.wireFamily || `reprint:${root}`,
      };
    }
    reasons.push("正文哈希虽相同，但文本过短、时间过远或身份锚点冲突");
    reasons.push(...anchors.reasons);
  }

  if (gapHours !== null && gapHours > maxHours) {
    return {
      kind: "distinct",
      score: 0,
      reasons: [`发布时间相差 ${gapHours.toFixed(1)} 小时，超出转载窗口`],
      candidateId: candidate.id,
      reprintOf: null,
      wireFamily: null,
    };
  }

  const left = comparableFeatures(incoming);
  const right = comparableFeatures(candidate);
  const leftTokens = left.articleTokens.size;
  const rightTokens = right.articleTokens.size;
  if (Math.min(leftTokens, rightTokens) < 6) {
    return {
      kind: "distinct",
      score: 0,
      reasons: ["可比较文本过短，拒绝仅凭短标题判为转载"],
      candidateId: candidate.id,
      reprintOf: null,
      wireFamily: null,
    };
  }

  const anchors = anchorPenalty(incoming, candidate);
  const titleSimilarity = tokenSetJaccard(left.titleTokens, right.titleTokens);
  const bodySimilarity = tokenSetJaccard(left.bodyTokens, right.bodyTokens);
  let simhashSimilarity = 0;
  let distance: number | null = null;
  if (incoming.simhash && candidate.simhash && VALID_SIMHASH_RE.test(incoming.simhash) && VALID_SIMHASH_RE.test(candidate.simhash)) {
    distance = hamming(incoming.simhash, candidate.simhash);
    simhashSimilarity = 1 - distance / 64;
  }

  reasons.push(...anchors.reasons);
  const timeScore = gapHours === null ? 0.45 : Math.max(0, 1 - gapHours / maxHours);
  const score = Math.max(
    0,
    Math.min(1, titleSimilarity * 0.38 + bodySimilarity * 0.34 + simhashSimilarity * 0.2 + timeScore * 0.08 - anchors.penalty)
  );
  const maxHamming = options.maxHamming ?? DEFAULT_MAX_HAMMING;
  const contentSignal = bodySimilarity >= 0.82 || (distance !== null && distance <= maxHamming);
  const titleSignal = titleSimilarity >= 0.62;
  const accepted = !anchors.blocked && contentSignal && titleSignal && score >= (options.minReprintScore ?? DEFAULT_MIN_REPRINT_SCORE);

  reasons.push(`标题相似度 ${titleSimilarity.toFixed(3)}`);
  reasons.push(`正文相似度 ${bodySimilarity.toFixed(3)}`);
  if (distance !== null) reasons.push(`SimHash 汉明距离 ${distance}`);
  if (gapHours !== null) reasons.push(`发布时间相差 ${gapHours.toFixed(1)} 小时`);

  const root = candidate.reprintOf || candidate.id;
  return {
    kind: accepted ? "reprint" : "distinct",
    score: Number(score.toFixed(4)),
    reasons,
    candidateId: candidate.id,
    reprintOf: accepted ? root : null,
    wireFamily: accepted ? candidate.wireFamily || `reprint:${root}` : null,
  };
}

/** 从候选文章中选择最可信的转载根稿，分数相同时按文章 ID 稳定排序 */
export function detectReprintFamily(
  incoming: ComparableArticle,
  candidates: readonly ReprintCandidate[],
  options: DedupeOptions = {}
): ReprintFamilyResult {
  let best: DuplicateDecision | undefined;
  for (const { article } of candidates) {
    const decision = classifyDuplicate(incoming, article, options);
    if (decision.kind !== "reprint") continue;
    if (!best || decision.score > best.score || (decision.score === best.score && decision.candidateId < best.candidateId)) best = decision;
  }
  return reprintFamilyResult(best);
}

/** 大候选池的协作式版本；每批比较后让前台请求先获得一次事件循环。 */
export async function detectReprintFamilyAsync(
  incoming: ComparableArticle,
  candidates: readonly ReprintCandidate[],
  options: DedupeOptions = {},
  batchSize = DEFAULT_COMPARISON_BATCH_SIZE
): Promise<ReprintFamilyResult> {
  let best: DuplicateDecision | undefined;
  const size = Math.max(1, Math.floor(batchSize));
  for (let index = 0; index < candidates.length; index += 1) {
    const decision = classifyDuplicate(incoming, candidates[index].article, options);
    if (decision.kind === "reprint" && (!best || decision.score > best.score || (decision.score === best.score && decision.candidateId < best.candidateId))) {
      best = decision;
    }
    if ((index + 1) % size === 0 && index + 1 < candidates.length) await yieldToEventLoop();
  }
  return reprintFamilyResult(best);
}

function reprintFamilyResult(best: DuplicateDecision | undefined): ReprintFamilyResult {
  if (!best) {
    return {
      isReprint: false,
      reprintOf: null,
      wireFamily: null,
      score: 0,
      reasons: [],
      matchedArticleId: null,
      rootFamilyPatch: null,
    };
  }
  const rootFamilyPatch = best.reprintOf && best.wireFamily
    ? { articleId: best.reprintOf, wireFamily: best.wireFamily }
    : null;
  return {
    isReprint: true,
    reprintOf: best.reprintOf,
    wireFamily: best.wireFamily,
    score: best.score,
    reasons: best.reasons,
    matchedArticleId: best.candidateId,
    rootFamilyPatch,
  };
}

/** 将转载判定应用到待插入文章，不修改原对象 */
export function applyReprintDecision(article: ArticleInsert, result: ReprintFamilyResult): ArticleInsert {
  return {
    ...article,
    isReprint: result.isReprint,
    reprintOf: result.reprintOf,
    wireFamily: result.wireFamily,
  };
}

/** 返回需要同步写回转载根稿的字段，使根稿与转载稿使用同一证据家族 */
export function buildReprintRootPatch(
  result: ReprintFamilyResult
): Pick<ArticleInsert, "id" | "wireFamily"> | null {
  if (!result.rootFamilyPatch) return null;
  return { id: result.rootFamilyPatch.articleId, wireFamily: result.rootFamilyPatch.wireFamily };
}

/** 沿 reprintOf 链寻找根稿，并用 visited 防止损坏数据形成死循环 */
export function resolveReprintRoot(
  article: Pick<ComparableArticle, "id" | "reprintOf">,
  articlesById: ReadonlyMap<string, Pick<ComparableArticle, "id" | "reprintOf">>
): string {
  let current = article;
  const visited = new Set<string>();
  while (current.reprintOf && !visited.has(current.id)) {
    visited.add(current.id);
    const parent = articlesById.get(current.reprintOf);
    if (!parent) return current.reprintOf;
    current = parent;
  }
  return current.id;
}

export interface FamilyKeyArticle {
  id: string;
  url?: string | null;
  sourceId?: string | null;
  wireFamily?: string | null;
  reprintOf?: string | null;
}

export interface FamilyKeySource {
  id: string;
  familyId?: string | null;
  familyKind?: string | null;
}

/** 生成独立证据链键：通讯社稿族优先，其次转载根、所有权家族、来源自身 */
export function deriveFamilyKey(
  article: FamilyKeyArticle,
  source?: FamilyKeySource | null,
  knownReprintRoots: ReadonlySet<string> = new Set()
): string {
  if (article.wireFamily) return article.wireFamily.startsWith("wire:") || article.wireFamily.startsWith("reprint:")
    ? article.wireFamily
    : `wire:${article.wireFamily}`;
  if (article.reprintOf) return `reprint:${article.reprintOf}`;
  if (knownReprintRoots.has(article.id)) return `reprint:${article.id}`;
  if (source?.familyId && (source.familyKind === "ownership" || source.familyKind === "wire")) return `family:${source.familyId}`;
  if (source?.id || article.sourceId) return `source:${source?.id || article.sourceId}`;
  const domain = article.url ? baseDomain(article.url) : "";
  return domain ? `domain:${domain}` : `article:${article.id}`;
}

export const familyKeyForArticle = deriveFamilyKey;

/** 内容更新时生成 article_versions 写入对象；无变化则返回 null */
export function buildArticleVersionInsert(
  existing: ComparableArticle,
  incoming: ComparableArticle,
  seenAt: string,
  note: "modified" | "corrected" | "deleted" = "modified"
): ArticleVersionInsert | null {
  if (!articleChanged(existing, incoming) && note !== "deleted") return null;
  return {
    articleId: existing.id,
    seenAt,
    title: incoming.title || existing.title,
    contentHash: incoming.contentHash || null,
    note,
  };
}
