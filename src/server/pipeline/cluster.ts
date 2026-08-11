import type { EventStatus, TrackMode } from "../../shared/types";
import { eventArticles, events } from "../db/schema";
import { countriesOf, extractEntities, type EntityHit } from "../lib/entities";
import { GAZETTEER_BY_SLUG } from "../lib/gazetteer";
import { shortId } from "../lib/hash";
import { yieldToEventLoop } from "../lib/async";
import { jaccard, normalizeTitle } from "../lib/textsim";
import { extractArticleAnchors } from "./dedupe";
import { classifyTopics, mergeTopics, TOPIC_KEYS, type TopicKey } from "./topics";

export type EventRow = typeof events.$inferSelect;
export type EventInsert = typeof events.$inferInsert;
export type EventArticleInsert = typeof eventArticles.$inferInsert;

export interface ClusterArticleInput {
  id: string;
  title: string;
  titleNorm?: string;
  bodyText?: string | null;
  excerpt?: string | null;
  publishedAt?: string | null;
  firstSeenAt: string;
  topics?: readonly string[] | null;
  entities?: readonly EntityHit[] | null;
  countries?: readonly string[] | null;
  reprintOf?: string | null;
}

export interface ClusterEventInput {
  id: string;
  title: string;
  oneLiner?: string | null;
  status?: EventStatus | string;
  trackMode?: TrackMode | string;
  topics?: readonly string[] | null;
  countries?: readonly string[] | null;
  entities?: readonly EntityHit[] | null;
  firstAt: string;
  lastUpdateAt: string;
}

export interface EventMatchOptions {
  minScore?: number;
  maxGapHours?: number;
  closedEventMaxGapHours?: number;
  /** 最佳候选与次佳候选的最小分差，低于该值时保守新建事件 */
  minLeadScoreGap?: number;
}

export interface EventMatchComponents {
  title: number;
  entities: number;
  topics: number;
  countries: number;
  time: number;
  anchorPenalty: number;
}

export interface EventMatchScore {
  eventId: string;
  accepted: boolean;
  score: number;
  components: EventMatchComponents;
  reasons: string[];
  blockers: string[];
  sharedEntities: string[];
  sharedTopics: string[];
  gapHours: number | null;
}

export interface EventResolution {
  action: "attach" | "create";
  eventId: string | null;
  createNew: boolean;
  score: number;
  reasons: string[];
  bestMatch: EventMatchScore | null;
  candidateScores: EventMatchScore[];
}

export interface EventCreationOptions {
  id?: string;
  trackMode?: TrackMode;
  importance?: number;
  heat?: number;
}

export interface AnchorComparison {
  penalty: number;
  hardConflict: boolean;
  reasons: string[];
}

const DEFAULT_MIN_SCORE = 0.6;
const DEFAULT_MIN_LEAD_SCORE_GAP = 0.08;
const DEFAULT_MAX_GAP_HOURS = 96;
const CLOSED_EVENT_MAX_GAP_HOURS = 36;
const DEFAULT_SCORING_BATCH_SIZE = 64;
const CASUALTY_RE = /死亡|遇难|丧生|受伤|伤亡|失踪|killed|dead|deaths?|injured|wounded|casualt(?:y|ies)|missing/i;
const IDENTITY_RE = /航班|法案|议案|决议|型号|机型|舰号|台风|飓风|地震|震级|flight|bill|resolution|model|hurricane|typhoon|magnitude/i;

interface ArticleFeatures {
  topics: TopicKey[];
  entities: EntityHit[];
  countries: string[];
}

const articleFeatureCache = new WeakMap<object, ArticleFeatures>();

function finiteTime(value?: string | null): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function eventGapHours(article: ClusterArticleInput, event: ClusterEventInput): number | null {
  const at = finiteTime(article.publishedAt || article.firstSeenAt);
  const first = finiteTime(event.firstAt);
  const last = finiteTime(event.lastUpdateAt);
  if (at === null || first === null || last === null) return null;
  if (at >= first && at <= last) return 0;
  return Math.min(Math.abs(at - first), Math.abs(at - last)) / 3_600_000;
}

function setSimilarity(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function intersection(left: readonly string[], right: readonly string[]): string[] {
  const values = new Set(right);
  return [...new Set(left.filter((value) => values.has(value)))].sort();
}

function hasSpecificSharedEntity(sharedEntities: readonly string[]): boolean {
  return sharedEntities.some((slug) => {
    const type = GAZETTEER_BY_SLUG.get(slug)?.type;
    return type === "place" || type === "group";
  });
}

function featuresOf(article: ClusterArticleInput): ArticleFeatures {
  const cached = articleFeatureCache.get(article);
  if (cached) return cached;
  const text = `${article.title}\n${article.excerpt || ""}\n${article.bodyText || ""}`.slice(0, 12000);
  const entities = article.entities ? [...article.entities] : extractEntities(text);
  const topics = article.topics
    ? mergeTopics(article.topics)
    : classifyTopics({ title: article.title, excerpt: article.excerpt, bodyText: article.bodyText });
  const countries = article.countries ? [...new Set(article.countries)] : countriesOf(entities);
  const features = { topics, entities, countries };
  articleFeatureCache.set(article, features);
  return features;
}

function maxGapFor(event: ClusterEventInput, options: EventMatchOptions): number {
  if (event.status === "closed" || event.status === "dormant") {
    return options.closedEventMaxGapHours ?? CLOSED_EVENT_MAX_GAP_HOURS;
  }
  if (options.maxGapHours !== undefined) return options.maxGapHours;
  if (event.trackMode === "slow") return 168;
  if (event.trackMode === "active") return 120;
  if (event.trackMode === "breaking") return 72;
  return DEFAULT_MAX_GAP_HOURS;
}

function sameAnchor(left: readonly string[], right: readonly string[]): boolean {
  const values = new Set(right);
  return left.some((value) => values.has(value));
}

/** 比较标题中的日期和数字锚点，伤亡更新只轻度降权，身份数字冲突强阻断 */
export function compareEventAnchors(articleText: string, eventText: string): AnchorComparison {
  const article = extractArticleAnchors(articleText);
  const event = extractArticleAnchors(eventText);
  const reasons: string[] = [];
  let penalty = 0;
  let hardConflict = false;

  if (article.dates.length > 0 && event.dates.length > 0 && !sameAnchor(article.dates, event.dates)) {
    penalty += 0.3;
    reasons.push("标题中的显式日期锚点不一致");
  }

  if (
    article.identityNumbers.length > 0 &&
    event.identityNumbers.length > 0 &&
    !sameAnchor(article.identityNumbers, event.identityNumbers)
  ) {
    penalty += 0.45;
    hardConflict = true;
    reasons.push("航班、法案、型号或灾害编号冲突");
  } else if (article.numbers.length > 0 && event.numbers.length > 0 && !sameAnchor(article.numbers, event.numbers)) {
    const casualtyContext = CASUALTY_RE.test(articleText) && CASUALTY_RE.test(eventText);
    const identityContext = IDENTITY_RE.test(articleText) || IDENTITY_RE.test(eventText);
    penalty += casualtyContext ? 0.07 : identityContext ? 0.35 : 0.16;
    if (identityContext) hardConflict = true;
    reasons.push(casualtyContext ? "伤亡数字可能是同一事件的后续更新" : "标题数字锚点不一致");
  }

  return { penalty, hardConflict, reasons };
}

/** 对单个候选事件打分；时间接近是硬前提，并要求至少两个独立正向信号 */
export function scoreEventMatch(
  article: ClusterArticleInput,
  event: ClusterEventInput,
  options: EventMatchOptions = {}
): EventMatchScore {
  const articleFeatures = featuresOf(article);
  const eventEntities = event.entities || [];
  const eventTopics = mergeTopics(event.topics || []);
  const eventCountries = event.countries || [];
  const articleEntitySlugs = articleFeatures.entities.map((item) => item.slug);
  const eventEntitySlugs = eventEntities.map((item) => item.slug);
  const sharedEntities = intersection(articleEntitySlugs, eventEntitySlugs);
  const sharedTopics = intersection(articleFeatures.topics, eventTopics);
  const sharedCountries = intersection(articleFeatures.countries, eventCountries);
  const titleText = `${event.title}\n${event.oneLiner || ""}`;
  const titleSimilarity = Math.max(jaccard(article.title, event.title), event.oneLiner ? jaccard(article.title, event.oneLiner) : 0);
  const entitySimilarity = setSimilarity(articleEntitySlugs, eventEntitySlugs);
  const topicSimilarity = setSimilarity(articleFeatures.topics, eventTopics);
  const countrySimilarity = setSimilarity(articleFeatures.countries, eventCountries);
  const gapHours = eventGapHours(article, event);
  const maxGapHours = maxGapFor(event, options);
  const timeScore = gapHours === null ? 0 : Math.max(0, 1 - gapHours / maxGapHours);
  const anchors = compareEventAnchors(article.title, titleText);
  const blockers: string[] = [];
  const reasons: string[] = [];

  if (gapHours === null) blockers.push("缺少可比较的事件时间，无法满足时间接近条件");
  else if (gapHours > maxGapHours) blockers.push(`与事件时间窗相差 ${gapHours.toFixed(1)} 小时`);
  if (anchors.hardConflict) blockers.push(...anchors.reasons);

  const titleSignal = titleSimilarity >= 0.38;
  const entitySignal = sharedEntities.length >= 1;
  const topicSignal = sharedTopics.length >= 1;
  const specificEntitySignal = hasSpecificSharedEntity(sharedEntities);
  const crossLanguageSignal =
    titleSimilarity < 0.2 &&
    sharedEntities.length >= 2 &&
    specificEntitySignal &&
    topicSignal &&
    (gapHours ?? Infinity) <= 24;
  const strongSignalCount = Number(titleSignal) + Number(entitySignal) + Number(topicSignal);

  if (!crossLanguageSignal && strongSignalCount < 2) blockers.push("标题、实体与主题信号不足两个");
  if (!crossLanguageSignal && !titleSignal && !entitySignal) blockers.push("缺少标题或实体锚点，拒绝仅凭宽泛主题合并");
  if (titleSimilarity < 0.2 && !crossLanguageSignal) blockers.push("标题几乎无关，且缺少共享地点或冲突组织等事件特定锚点");
  if (articleEntitySlugs.length === 0 && eventEntitySlugs.length === 0 && titleSimilarity < 0.58) {
    blockers.push("双方均无实体锚点且标题相似度不足");
  }

  const components: EventMatchComponents = {
    title: titleSimilarity,
    entities: entitySimilarity,
    topics: topicSimilarity,
    countries: countrySimilarity,
    time: timeScore,
    anchorPenalty: anchors.penalty,
  };
  const rawScore =
    titleSimilarity * 0.34 +
    entitySimilarity * 0.28 +
    topicSimilarity * 0.16 +
    countrySimilarity * 0.02 +
    timeScore * 0.2 -
    anchors.penalty;
  const score = Number(Math.max(0, Math.min(1, rawScore)).toFixed(4));
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;
  const accepted = blockers.length === 0 && score >= minScore;

  reasons.push(`标题相似度 ${titleSimilarity.toFixed(3)}`);
  reasons.push(`实体相似度 ${entitySimilarity.toFixed(3)}，共享 ${sharedEntities.length} 个实体`);
  reasons.push(`主题相似度 ${topicSimilarity.toFixed(3)}，共享 ${sharedTopics.length} 个主题`);
  if (sharedCountries.length > 0) reasons.push(`共享国家或地区：${sharedCountries.join("、")}`);
  if (gapHours !== null) reasons.push(`距离事件时间窗 ${gapHours.toFixed(1)} 小时`);
  reasons.push(...anchors.reasons);
  if (!accepted && blockers.length === 0) blockers.push(`综合分 ${score.toFixed(3)} 低于阈值 ${minScore.toFixed(3)}`);

  return {
    eventId: event.id,
    accepted,
    score,
    components,
    reasons,
    blockers,
    sharedEntities,
    sharedTopics,
    gapHours,
  };
}

/** 在候选事件中选择唯一最佳匹配；模糊情况保守创建新事件 */
export function resolveEvent(
  article: ClusterArticleInput,
  candidates: readonly ClusterEventInput[],
  options: EventMatchOptions = {}
): EventResolution {
  return resolveEventScores(candidates.map((event) => scoreEventMatch(article, event, options)), options);
}

/** 大候选池的协作式版本；评分批次之间让出事件循环，避免采集阻塞前台 API。 */
export async function resolveEventAsync(
  article: ClusterArticleInput,
  candidates: readonly ClusterEventInput[],
  options: EventMatchOptions = {},
  batchSize = DEFAULT_SCORING_BATCH_SIZE
): Promise<EventResolution> {
  const scores: EventMatchScore[] = [];
  const size = Math.max(1, Math.floor(batchSize));
  for (let index = 0; index < candidates.length; index += 1) {
    scores.push(scoreEventMatch(article, candidates[index], options));
    if ((index + 1) % size === 0 && index + 1 < candidates.length) await yieldToEventLoop();
  }
  return resolveEventScores(scores, options);
}

function resolveEventScores(scores: EventMatchScore[], options: EventMatchOptions): EventResolution {
  scores.sort((a, b) => b.score - a.score || a.eventId.localeCompare(b.eventId));
  const accepted = scores.filter((item) => item.accepted);
  const best = accepted[0] || null;
  if (!best) {
    return {
      action: "create",
      eventId: null,
      createNew: true,
      score: scores[0]?.score || 0,
      reasons: scores[0]?.blockers || ["没有候选事件"],
      bestMatch: scores[0] || null,
      candidateScores: scores,
    };
  }

  const second = accepted[1];
  const minLeadScoreGap = options.minLeadScoreGap ?? DEFAULT_MIN_LEAD_SCORE_GAP;
  if (second && best.score - second.score < minLeadScoreGap) {
    return {
      action: "create",
      eventId: null,
      createNew: true,
      score: best.score,
      reasons: [`最佳候选与次佳候选仅相差 ${(best.score - second.score).toFixed(3)}，拒绝任意归并`],
      bestMatch: best,
      candidateScores: scores,
    };
  }

  return {
    action: "attach",
    eventId: best.eventId,
    createNew: false,
    score: best.score,
    reasons: best.reasons,
    bestMatch: best,
    candidateScores: scores,
  };
}

export const resolveArticleEvent = resolveEvent;

/** 用首篇文章创建 events 写入对象，事件 ID 由文章 ID 稳定派生 */
export function buildEventInsert(article: ClusterArticleInput, options: EventCreationOptions = {}): EventInsert {
  const features = featuresOf(article);
  const at = article.publishedAt || article.firstSeenAt;
  const id = options.id || `evt_${shortId(`event:${article.id}:${normalizeTitle(article.title)}:${at}`)}`;
  return {
    id,
    title: article.title,
    oneLiner: null,
    status: "developing",
    trackMode: options.trackMode || "normal",
    importance: options.importance ?? 30,
    heat: options.heat ?? 0,
    prevHeat: 0,
    topics: features.topics,
    countries: features.countries,
    entities: features.entities,
    firstAt: at,
    lastUpdateAt: at,
    lastVerifiedAt: null,
    version: 1,
    summary: null,
    summaryEngine: "extractive",
    dirty: true,
    lastSummaryAt: null,
  };
}

function minIso(left: string, right: string): string {
  const a = finiteTime(left);
  const b = finiteTime(right);
  if (a === null) return right;
  if (b === null) return left;
  return a <= b ? left : right;
}

function maxIso(left: string, right: string): string {
  const a = finiteTime(left);
  const b = finiteTime(right);
  if (a === null) return right;
  if (b === null) return left;
  return a >= b ? left : right;
}

/** 合并实体计数并按显著性稳定排序 */
export function mergeEventEntities(
  current: readonly EntityHit[] | null | undefined,
  incoming: readonly EntityHit[] | null | undefined,
  maxEntities = 16
): EntityHit[] {
  const counts = new Map<string, number>();
  for (const item of [...(current || []), ...(incoming || [])]) {
    counts.set(item.slug, Math.min(999, (counts.get(item.slug) || 0) + Math.max(1, item.count)));
  }
  return [...counts.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count || a.slug.localeCompare(b.slug))
    .slice(0, maxEntities);
}

function stableEventTopics(current: readonly string[], incoming: readonly string[]): TopicKey[] {
  const all = new Set(mergeTopics(current, incoming));
  return TOPIC_KEYS.filter((topic) => all.has(topic)).slice(0, 8);
}

/** 生成将文章并入事件后的 Drizzle 更新字段 */
export function buildEventUpdate(event: EventRow, article: ClusterArticleInput): Partial<EventInsert> {
  const features = featuresOf(article);
  const at = article.publishedAt || article.firstSeenAt;
  return {
    firstAt: minIso(event.firstAt, at),
    lastUpdateAt: maxIso(event.lastUpdateAt, at),
    topics: stableEventTopics(event.topics || [], features.topics),
    countries: [...new Set([...(event.countries || []), ...features.countries])].sort().slice(0, 8),
    entities: mergeEventEntities(event.entities, features.entities),
    version: event.version + 1,
    dirty: true,
  };
}

export const eventUpdateForArticle = buildEventUpdate;

/** 生成 event_articles 写入对象 */
export function buildEventArticleInsert(
  eventId: string,
  articleId: string,
  addedAt: string,
  role: "report" | "statement" | "data" | "analysis" = "report",
  familyKey: string | null = null
): EventArticleInsert {
  return { eventId, articleId, addedAt, role, familyKey };
}
