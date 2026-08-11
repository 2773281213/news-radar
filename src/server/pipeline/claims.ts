import type { ClaimRationale, ClaimStatus, ClaimType, EvidenceStance, SourceCategory } from "../../shared/types";
import { claimEvidence, claims, sources } from "../db/schema";
import { extractEntities } from "../lib/entities";
import { entityLabel, GAZETTEER_BY_SLUG } from "../lib/gazetteer";
import { shortId } from "../lib/hash";
import { normalizeText } from "../lib/textsim";
import { parseDate } from "../lib/time";
import { foldUnicodeDigits } from "./dedupe";

export type ClaimRow = typeof claims.$inferSelect;
export type ClaimInsert = typeof claims.$inferInsert;
export type ClaimEvidenceInsert = typeof claimEvidence.$inferInsert;
export type SourceRow = typeof sources.$inferSelect;

export type ClaimedByKind = "gov" | "military" | "party" | "media" | "org" | "social" | "unknown";
export type NumberQualifier = "exact" | "at_least" | "more_than" | "about" | "up_to";
export type CasualtyUnit =
  | "deaths"
  | "injuries"
  | "missing"
  | "casualties"
  | "civilian_deaths"
  | "civilian_injuries"
  | "civilian_missing"
  | "civilian_casualties"
  | "military_deaths"
  | "military_injuries"
  | "military_missing"
  | "military_casualties";

export interface ClaimSourceContext {
  id: string;
  name: string;
  category: SourceCategory | string;
  adapter?: string | null;
  isParty: boolean;
  partyOf?: string | null;
  isPrimary: boolean;
}

export interface ClaimExtractionInput {
  eventId: string;
  articleId: string;
  title: string;
  bodyText?: string | null;
  excerpt?: string | null;
  publishedAt?: string | null;
  firstSeenAt: string;
  source: ClaimSourceContext;
  familyKey?: string | null;
  maxClaims?: number;
}

export interface ClaimAttribution {
  claimedBy: string | null;
  claimedByKind: ClaimedByKind;
  party: string | null;
  isAttributedStatement: boolean;
}

export interface CasualtyMention {
  number: number;
  unit: CasualtyUnit;
  qualifier: NumberQualifier;
  rawNumber: string;
  rawUnit: string;
  start: number;
  end: number;
}

export interface NumberMention {
  number: number;
  unit: string;
  qualifier: NumberQualifier;
  rawNumber: string;
  rawUnit: string;
  start: number;
  end: number;
}

export interface ExtractedClaim extends Omit<ClaimInsert, "type" | "status" | "rationale"> {
  type: ClaimType;
  status: ClaimStatus;
  rationale: ClaimRationale;
  evidenceStance: EvidenceStance;
  evidenceHasPrimary: boolean;
  sourceSentence: string;
  qualifier: NumberQualifier | null;
  proposition: "statement" | "underlying_fact";
}

const STATEMENT_RE = /声称|表示|(?<![名简俗])称(?!为|谓|号)|宣布|通报|发布声明|证实|否认|指责|警告|据.+?(?:称|表示|通报)|\b(?:said|says|stated|claimed|announced|reported|confirmed|denied|warned|according to)\b/i;
const INTENT_RE = /计划|拟议|准备|将会|将于|打算|寻求|承诺|威胁|呼吁|\b(?:plans? to|intends? to|will|would|seeks? to|pledged to|threatened to|called on)\b/i;
const QUESTION_RE = /[?？]\s*$/;
const UPDATE_RE = /修正|更正|更新为|上调至|下调至|此前为|\b(?:corrected|revised|updated to|raised to|lowered to|previously)\b/i;
const CURRENT_AS_OF_RE = /截至目前|截至发稿|目前为止|\b(?:as of now|so far|to date)\b/i;
const EXPLICIT_AS_OF_RE = /(?:截至|截止|as of)\s*([^，。；;,.]{2,30})/i;
const FULL_DATE_RE = /(?:19|20)\d{2}[年\-/.](?:0?[1-9]|1[0-2])[月\-/.](?:0?[1-9]|[12]\d|3[01])日?/;
const MONTH_DAY_RE = /(?:0?[1-9]|1[0-2])月(?:0?[1-9]|[12]\d|3[01])日/;
const ISO_MONTH_DAY_RE = /\b(?:0?[1-9]|1[0-2])[\-/.](?:0?[1-9]|[12]\d|3[01])\b/;
const ENGLISH_DATE_RE = /\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*(?:19|20)\d{2})?/i;
const CHINESE_NUMBER_CHARS = "零〇一二两三四五六七八九十百千万亿";
const HUMAN_NUMBER_SOURCE = `(?:[0-9٠-٩۰-۹][0-9٠-٩۰-۹,，.]*\\s*(?:k|m|bn|thousand|million|billion|万|億|亿)?|[${CHINESE_NUMBER_CHARS}]+)`;
const MILITARY_SLUGS = new Set(["pla", "idf", "ru-mod", "ua-af", "centcom", "pentagon", "cn-mod", "irgc"]);

interface ClaimDraft {
  text: string;
  type: ClaimType;
  attribution: ClaimAttribution;
  subjectNumber: number | null;
  numberUnit: string | null;
  qualifier: NumberQualifier | null;
  asOf: string | null;
  occurredAt: string | null;
  evidenceStance: EvidenceStance;
  evidenceHasPrimary: boolean;
  proposition: "statement" | "underlying_fact";
  factors: string[];
}

function compactSentence(value: string): string {
  return value.replace(/\s+/g, " ").replace(/^[，,。；;：:\-—\s]+|[\s]+$/g, "").trim();
}

/** 将标题和正文拆为稳定、去重的候选句 */
export function splitClaimSentences(text: string, maxSentences = 80): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of text.split(/(?<=[。！？!?；;])\s*|(?<=\.)\s+(?=[A-Z0-9"'])|\n+/u)) {
    const sentence = compactSentence(part);
    if (sentence.length < 4 || sentence.length > 800) continue;
    const key = normalizeText(sentence);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(sentence);
    if (out.length >= maxSentences) break;
  }
  return out;
}

function parseChineseInteger(input: string): number | null {
  if (input.endsWith("万亿")) {
    const prefix = input.slice(0, -2) || "一";
    const value = parseChineseInteger(prefix);
    const scaled = value === null ? null : value * 1_000_000_000_000;
    return scaled !== null && Number.isSafeInteger(scaled) ? scaled : null;
  }
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10_000, 亿: 100_000_000 };
  let total = 0;
  let section = 0;
  let number = 0;
  let recognized = false;
  for (const ch of input) {
    if (ch in digits) {
      number = digits[ch];
      recognized = true;
      continue;
    }
    const unit = units[ch];
    if (!unit) return null;
    recognized = true;
    if (unit < 10_000) {
      section += (number || 1) * unit;
    } else {
      section = (section + number) * unit;
      total += section;
      section = 0;
    }
    number = 0;
  }
  const value = total + section + number;
  return recognized && Number.isSafeInteger(value) ? value : null;
}

/** 解析带逗号、万亿、k/m/bn 或常见中文数字的数值 */
export function parseHumanNumber(raw: string): number | null {
  const folded = foldUnicodeDigits(raw).trim().toLowerCase().replace(/，/g, ",");
  if (!folded) return null;
  if (new RegExp(`^[${CHINESE_NUMBER_CHARS}]+$`).test(folded)) return parseChineseInteger(folded);
  const match = /^([0-9][0-9,]*(?:\.\d+)?)\s*(k|m|bn|thousand|million|billion|万|億|亿)?$/i.exec(folded);
  if (!match) return null;
  const base = Number(match[1].replace(/,/g, ""));
  if (!Number.isFinite(base)) return null;
  const multipliers: Record<string, number> = {
    k: 1_000,
    thousand: 1_000,
    m: 1_000_000,
    million: 1_000_000,
    bn: 1_000_000_000,
    billion: 1_000_000_000,
    万: 10_000,
    億: 100_000_000,
    亿: 100_000_000,
  };
  const value = base * (multipliers[match[2] || ""] || 1);
  return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? value : null;
}

function qualifierAt(text: string, start: number, end = start): NumberQualifier {
  const windowStart = Math.max(0, start - 24);
  const prefix = text.slice(windowStart, start);
  const boundary = Math.max(
    prefix.lastIndexOf("，"),
    prefix.lastIndexOf(","),
    prefix.lastIndexOf("。"),
    prefix.lastIndexOf("；"),
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("！"),
    prefix.lastIndexOf("!"),
    prefix.lastIndexOf("？"),
    prefix.lastIndexOf("?")
  );
  const clauseStart = boundary >= 0 ? windowStart + boundary + 1 : windowStart;
  const local = text.slice(clauseStart, Math.min(text.length, end + 4)).toLowerCase();
  const patterns: readonly [NumberQualifier, RegExp][] = [
    ["up_to", /最多|不超过|至多|\b(?:up to|at most|no more than)\b/g],
    ["at_least", /至少|不低于|最少|\b(?:at least|no fewer than)\b/g],
    ["more_than", /(?<!不)超过|多于|逾|\b(?:more than|over)\b/g],
    ["about", /大约|约|近|左右|\b(?:about|around|approximately|roughly)\b/g],
  ];
  let best: { qualifier: NumberQualifier; index: number } | null = null;
  for (const [qualifier, pattern] of patterns) {
    for (const match of local.matchAll(pattern)) {
      const index = match.index || 0;
      if (!best || index > best.index) best = { qualifier, index };
    }
  }
  return best?.qualifier || "exact";
}

function casualtyScope(localText: string): "civilian" | "military" | null {
  if (/军人|军方人员|士兵|武装人员|战斗人员|\b(?:soldiers?|troops?|military personnel|combatants?|fighters?)\b/i.test(localText)) return "military";
  if (/平民|民众|居民|儿童|妇女|\b(?:civilians?|residents?|children|women)\b/i.test(localText)) return "civilian";
  return null;
}

function casualtyBaseUnit(rawUnit: string): "deaths" | "injuries" | "missing" | "casualties" {
  if (/受伤|伤者|^伤$|injur|wound/i.test(rawUnit)) return "injuries";
  if (/失踪|missing/i.test(rawUnit)) return "missing";
  if (/伤亡|casualt/i.test(rawUnit)) return "casualties";
  return "deaths";
}

function casualtyUnit(rawUnit: string, localText: string): CasualtyUnit {
  const base = casualtyBaseUnit(rawUnit);
  const scope = casualtyScope(localText);
  return scope ? `${scope}_${base}` as CasualtyUnit : base;
}

function collectCasualtyMatches(sentence: string): CasualtyMention[] {
  const zhScope = "(?:平民|民众|居民|儿童|妇女|军人|军方人员|士兵|武装人员|战斗人员)";
  const enScope = "(?:civilians?|residents?|children|women|soldiers?|troops?|military personnel|combatants?|fighters?|people|persons?)";
  const zhUnit = "(?:死亡|遇难|丧生|受伤|伤亡|失踪|死|伤)";
  const enUnit = "(?:killed|dead|deaths?|injured|wounded|missing|casualties)";
  const patterns = [
    new RegExp(`(?<number>${HUMAN_NUMBER_SOURCE})\\s*(?:余|多)?\\s*(?:名|人|位)?\\s*(?<scope>${zhScope})?\\s*(?<unit>${zhUnit})`, "giu"),
    new RegExp(`(?<scope>${zhScope})\\s*(?<number>${HUMAN_NUMBER_SOURCE})\\s*(?:余|多)?\\s*(?:名|人|位)?\\s*(?<unit>${zhUnit})`, "giu"),
    new RegExp(`(?<unit>${zhUnit})(?:人数|人员|者|达到|为|共计|累计|至少|约|超过|多达|增至|升至)*\\s*(?<number>${HUMAN_NUMBER_SOURCE})\\s*(?:余|多)?\\s*(?:名|人|位)?`, "giu"),
    new RegExp(`(?<number>${HUMAN_NUMBER_SOURCE})\\s+(?<scope>${enScope})?\\s*(?:were|was|are|is|have been|has been)?\\s*(?<unit>${enUnit})`, "giu"),
    new RegExp(`(?<unit>death toll|deaths?|injuries|injured|wounded|missing|casualties)(?:\\s+(?:rose|rises|stands|reached|at|to|of|were|was|is))*\\s+(?<number>${HUMAN_NUMBER_SOURCE})`, "giu"),
  ];
  const out: CasualtyMention[] = [];
  const seen = new Set<string>();
  for (const [patternIndex, pattern] of patterns.entries()) {
    for (const match of sentence.matchAll(pattern)) {
      const rawNumber = match.groups?.number || "";
      const rawUnit = match.groups?.unit || "";
      const number = parseHumanNumber(rawNumber);
      if (number === null || number < 0 || !rawUnit) continue;
      const start = match.index || 0;
      const end = start + match[0].length;
      if (patternIndex > 0 && out.some((item) => item.start < end && item.end > start)) continue;
      const localText = `${match.groups?.scope || ""} ${match[0]}`;
      const unit = casualtyUnit(rawUnit, localText);
      const key = `${start}:${number}:${unit}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        number,
        unit,
        qualifier: qualifierAt(sentence, start, end),
        rawNumber,
        rawUnit,
        start,
        end,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start || a.unit.localeCompare(b.unit));
}

/** 提取一句话中的死亡、受伤、失踪与总伤亡数字 */
export function extractCasualtyMentions(sentence: string): CasualtyMention[] {
  return collectCasualtyMatches(foldUnicodeDigits(sentence));
}

function normalizedNumberUnit(raw: string): string {
  const value = raw.toLowerCase();
  if (/%|percent|percentage|个百分点|百分比/.test(value)) return "percent";
  if (/美元|usd|dollars?/.test(value)) return "usd";
  if (/人民币|元|rmb|yuan/.test(value)) return "cny";
  if (/欧元|eur|euros?/.test(value)) return "eur";
  if (/枚|发|missiles?|rockets?/.test(value)) return "projectiles";
  if (/架|aircraft|planes?|drones?/.test(value)) return "aircraft";
  if (/艘|ships?|vessels?/.test(value)) return "vessels";
  if (/人|people|persons?/.test(value)) return "people";
  if (/公里|千米|kilometers?|km/.test(value)) return "km";
  if (/吨|tonnes?|tons?/.test(value)) return "tonnes";
  if (/小时|hours?/.test(value)) return "hours";
  if (/天|days?/.test(value)) return "days";
  return normalizeText(raw).replace(/\s+/g, "_").slice(0, 40) || "number";
}

function numberWithUnitMultiplier(rawNumber: string, rawUnit: string): number | null {
  const base = parseHumanNumber(rawNumber);
  if (base === null) return null;
  if (/(?:k|m|bn|thousand|million|billion|万|億|亿)\s*$/i.test(rawNumber.trim())) return base;
  const unit = rawUnit.toLowerCase();
  let multiplier = 1;
  if (/^亿/.test(unit)) multiplier = 100_000_000;
  else if (/\bbillion\b/.test(unit)) multiplier = 1_000_000_000;
  else if (/^万/.test(unit)) multiplier = 10_000;
  else if (/\bmillion\b/.test(unit)) multiplier = 1_000_000;
  else if (/\bthousand\b/.test(unit)) multiplier = 1_000;
  const value = base * multiplier;
  return Number.isFinite(value) && (!Number.isInteger(value) || Number.isSafeInteger(value)) ? value : null;
}

/** 提取非伤亡定量主张中的常见数值与单位 */
export function extractNumberMentions(sentence: string): NumberMention[] {
  const folded = foldUnicodeDigits(sentence);
  const unitSource = "%|percent(?:age)?|个百分点|美元|亿元|万元|人民币|欧元|元|(?:thousand|million|billion)\\s+(?:dollars?|usd|euros?|eur|yuan|rmb)|dollars?|usd|euros?|eur|yuan|rmb|枚|发|架|艘|人|公里|千米|吨|小时|天|missiles?|rockets?|aircraft|planes?|drones?|ships?|vessels?|people|persons?|kilometers?|km|tonnes?|tons?|hours?|days?";
  const pattern = new RegExp(`(${HUMAN_NUMBER_SOURCE})\\s*(${unitSource})`, "giu");
  const out: NumberMention[] = [];
  for (const match of folded.matchAll(pattern)) {
    const number = numberWithUnitMultiplier(match[1], match[2]);
    if (number === null || number < 0) continue;
    const start = match.index || 0;
    const end = start + match[0].length;
    out.push({
      number,
      unit: normalizedNumberUnit(match[2]),
      qualifier: qualifierAt(folded, start, end),
      rawNumber: match[1],
      rawUnit: match[2],
      start,
      end,
    });
  }
  return out.slice(0, 5);
}

function referenceYear(referenceIso?: string | null): number | null {
  if (!referenceIso) return null;
  const time = Date.parse(referenceIso);
  return Number.isFinite(time) ? new Date(time).getUTCFullYear() : null;
}

/** 从文本提取最明确的日期，并用参考时间补全年份 */
export function extractClaimDate(text: string, referenceIso?: string | null): string | null {
  const full = FULL_DATE_RE.exec(text)?.[0];
  if (full) return parseDate(full);
  const english = ENGLISH_DATE_RE.exec(text)?.[0];
  if (english) {
    const year = referenceYear(referenceIso);
    const value = /\d{4}/.test(english) || year === null ? english : `${english}, ${year}`;
    return parseDate(value);
  }
  const year = referenceYear(referenceIso);
  if (year === null) return null;
  const monthDay = MONTH_DAY_RE.exec(text)?.[0];
  if (monthDay) return parseDate(`${year}年${monthDay}`);
  const isoMonthDay = ISO_MONTH_DAY_RE.exec(text)?.[0];
  if (isoMonthDay) return parseDate(`${year}-${isoMonthDay}`);
  return null;
}

function extractAsOf(text: string, referenceIso?: string | null): string | null {
  if (CURRENT_AS_OF_RE.test(text)) return referenceIso || null;
  const match = EXPLICIT_AS_OF_RE.exec(text);
  if (!match) return null;
  return extractClaimDate(match[1], referenceIso) || (CURRENT_AS_OF_RE.test(match[1]) ? referenceIso || null : null);
}

function sourceKind(source: ClaimSourceContext): ClaimedByKind {
  if (source.adapter === "mastodon" || source.adapter === "bluesky" || source.adapter === "telegramweb") return "social";
  if (source.category === "gov_cn" || source.category === "gov_intl") return "gov";
  if (source.category === "intl_org" || source.category === "data" || source.category === "factcheck") return "org";
  if (source.category === "party_media") return source.isParty ? "party" : "media";
  if (source.category.includes("media") || source.category === "wire") return "media";
  if (source.category === "social" || source.category === "social_cn") return "social";
  return source.isParty ? "party" : "unknown";
}

function kindForEntity(slug: string): ClaimedByKind {
  const entity = GAZETTEER_BY_SLUG.get(slug);
  if (!entity) return "unknown";
  if (MILITARY_SLUGS.has(slug)) return "military";
  if (entity.party) return entity.type === "group" ? "party" : "gov";
  if (entity.type === "org") return "org";
  return "unknown";
}

/** 推断一句声明的发布者；优先使用词表中的当事方实体，其次使用来源身份 */
export function inferClaimAttribution(sentence: string, source: ClaimSourceContext): ClaimAttribution {
  const statement = STATEMENT_RE.test(sentence) || source.isParty;
  const partyEntities = extractEntities(sentence)
    .map((hit) => ({ hit, entity: GAZETTEER_BY_SLUG.get(hit.slug) }))
    .filter((item) => Boolean(item.entity?.party));
  const firstParty = partyEntities[0];
  if (firstParty?.entity) {
    return {
      claimedBy: entityLabel(firstParty.hit.slug),
      claimedByKind: kindForEntity(firstParty.hit.slug),
      party: firstParty.entity.party || null,
      isAttributedStatement: statement,
    };
  }

  if (source.isParty || (statement && source.isPrimary)) {
    return {
      claimedBy: source.name,
      claimedByKind: sourceKind(source),
      party: source.partyOf || null,
      isAttributedStatement: statement,
    };
  }

  const chineseActor = /([^，。；;：:\n]{1,36}?)(?:声称|表示|(?<![名简俗])称(?!为|谓|号)|宣布|通报|证实|否认|指责|警告)/.exec(sentence)?.[1];
  const englishActor = /\b([A-Z][A-Za-z0-9 .'-]{1,50}?)\s+(?:said|stated|claimed|announced|confirmed|denied|warned)\b/.exec(sentence)?.[1];
  const actor = compactSentence(chineseActor || englishActor || "");
  return {
    claimedBy: actor || null,
    claimedByKind: actor ? "unknown" : sourceKind(source),
    party: source.partyOf || null,
    isAttributedStatement: statement,
  };
}

/** 判断句子是否应按“某方进行了表述”处理，而不是直接当成已确认事实 */
export function isStatementSentence(sentence: string, source: ClaimSourceContext): boolean {
  return source.isParty || STATEMENT_RE.test(sentence);
}

function initialRationale(draft: ClaimDraft): ClaimRationale {
  return {
    factors: [...new Set(draft.factors)],
    independentChains: 1,
    hasPrimary: draft.evidenceHasPrimary,
    hasRefutation: false,
  };
}

function claimStatusFor(draft: ClaimDraft): ClaimStatus {
  if (draft.proposition === "statement") return "reported";
  if (draft.attribution.party) return "unverified";
  return "reported";
}

/** Claim 去重键包含归属方、时间与数值口径，避免把争议双方折叠在一起 */
export function claimDedupeKey(eventId: string, draft: Pick<ClaimDraft, "text" | "type" | "attribution" | "subjectNumber" | "numberUnit" | "asOf" | "qualifier">): string {
  return [
    eventId,
    draft.type,
    normalizeText(draft.text),
    draft.attribution.party || "",
    draft.attribution.claimedBy || "",
    draft.subjectNumber ?? "",
    draft.numberUnit || "",
    draft.asOf || "",
    draft.qualifier || "",
  ].join("|");
}

function materializeClaim(input: ClaimExtractionInput, sentence: string, draft: ClaimDraft): ExtractedClaim {
  const text = compactSentence(draft.text);
  const textNorm = normalizeText(text);
  const key = claimDedupeKey(input.eventId, draft);
  return {
    id: `clm_${shortId(key)}`,
    eventId: input.eventId,
    text,
    textNorm,
    type: draft.type,
    claimedBy: draft.attribution.claimedBy,
    claimedByKind: draft.attribution.claimedByKind,
    party: draft.attribution.party,
    subjectNumber: draft.subjectNumber,
    numberUnit: draft.numberUnit,
    asOf: draft.asOf,
    occurredAt: draft.occurredAt,
    publishedAt: input.publishedAt || null,
    firstSeenAt: input.firstSeenAt,
    status: claimStatusFor(draft),
    rationale: initialRationale(draft),
    lastCheckedAt: null,
    supersededBy: null,
    evidenceStance: draft.evidenceStance,
    evidenceHasPrimary: draft.evidenceHasPrimary,
    sourceSentence: sentence,
    qualifier: draft.qualifier,
    proposition: draft.proposition,
  };
}

function statementDraft(sentence: string, attribution: ClaimAttribution, input: ClaimExtractionInput): ClaimDraft {
  const primary = Boolean(input.source.isPrimary || input.source.isParty);
  return {
    text: sentence,
    type: "statement",
    attribution,
    subjectNumber: null,
    numberUnit: null,
    qualifier: null,
    asOf: extractAsOf(sentence, input.publishedAt),
    occurredAt: null,
    evidenceStance: primary ? "supports" : "reports",
    evidenceHasPrimary: primary,
    proposition: "statement",
    factors: [
      "该条目只确认相关表述被发布，不等同于表述内容已获事实确认",
      primary ? "证据来自声明方原文或第一手发布渠道" : "当前证据为媒体或第三方转述",
    ],
  };
}

function factualEvidence(input: ClaimExtractionInput, attributedStatement: boolean): Pick<ClaimDraft, "evidenceStance" | "evidenceHasPrimary" | "factors"> {
  if (attributedStatement || input.source.isParty) {
    return {
      evidenceStance: "reports",
      evidenceHasPrimary: false,
      factors: ["来源证明某方提出了该主张，但不能单独证明底层事实"],
    };
  }
  const primaryData = input.source.isPrimary && ["data", "factcheck", "intl_org"].includes(input.source.category);
  return {
    evidenceStance: primaryData ? "supports" : "reports",
    evidenceHasPrimary: primaryData,
    factors: [primaryData ? "来源提供与该主张直接相关的第一手数据或核查材料" : "当前仅有来源报道，仍需独立证据链核验"],
  };
}

function qualifierFactor(qualifier: NumberQualifier): string {
  return `数值限定词：${qualifier}`;
}

function casualtyDrafts(
  sentence: string,
  mentions: readonly CasualtyMention[],
  attribution: ClaimAttribution,
  input: ClaimExtractionInput
): ClaimDraft[] {
  const evidence = factualEvidence(input, attribution.isAttributedStatement);
  const asOf = extractAsOf(sentence, input.publishedAt);
  const occurredAt = extractClaimDate(sentence, input.publishedAt);
  return mentions.map((mention) => ({
    text: sentence,
    type: "casualty",
    attribution,
    subjectNumber: mention.number,
    numberUnit: mention.unit,
    qualifier: mention.qualifier,
    asOf,
    occurredAt,
    evidenceStance: evidence.evidenceStance,
    evidenceHasPrimary: evidence.evidenceHasPrimary,
    proposition: "underlying_fact",
    factors: [
      ...evidence.factors,
      qualifierFactor(mention.qualifier),
      "伤亡数字按来源、口径和截至时间分别保存，不进行平均或取最大值",
    ],
  }));
}

function numberDrafts(
  sentence: string,
  mentions: readonly NumberMention[],
  attribution: ClaimAttribution,
  input: ClaimExtractionInput
): ClaimDraft[] {
  const evidence = factualEvidence(input, attribution.isAttributedStatement);
  return mentions.map((mention) => ({
    text: sentence,
    type: "number",
    attribution,
    subjectNumber: mention.number,
    numberUnit: mention.unit,
    qualifier: mention.qualifier,
    asOf: extractAsOf(sentence, input.publishedAt),
    occurredAt: extractClaimDate(sentence, input.publishedAt),
    evidenceStance: evidence.evidenceStance,
    evidenceHasPrimary: evidence.evidenceHasPrimary,
    proposition: "underlying_fact",
    factors: [...evidence.factors, qualifierFactor(mention.qualifier)],
  }));
}

function genericDraft(sentence: string, attribution: ClaimAttribution, input: ClaimExtractionInput): ClaimDraft {
  const evidence = factualEvidence(input, false);
  return {
    text: sentence,
    type: INTENT_RE.test(sentence) ? "intent" : "event",
    attribution,
    subjectNumber: null,
    numberUnit: null,
    qualifier: null,
    asOf: null,
    occurredAt: extractClaimDate(sentence, input.publishedAt),
    evidenceStance: evidence.evidenceStance,
    evidenceHasPrimary: evidence.evidenceHasPrimary,
    proposition: "underlying_fact",
    factors: evidence.factors,
  };
}

/** 确定性抽取声明、伤亡、一般数值与核心事件主张 */
export function extractClaims(input: ClaimExtractionInput): ExtractedClaim[] {
  const title = compactSentence(input.title);
  const combined = [title, input.excerpt || "", input.bodyText || ""].filter(Boolean).join("\n");
  const sentences = splitClaimSentences(combined);
  const titleKey = normalizeText(title);
  const out: ExtractedClaim[] = [];
  const seen = new Set<string>();
  const maxClaims = Math.max(1, input.maxClaims ?? 12);

  const push = (sentence: string, draft: ClaimDraft) => {
    if (out.length >= maxClaims) return;
    const claim = materializeClaim(input, sentence, draft);
    const key = claimDedupeKey(input.eventId, draft);
    if (!claim.textNorm || seen.has(key)) return;
    seen.add(key);
    out.push(claim);
  };

  for (let index = 0; index < sentences.length && out.length < maxClaims; index += 1) {
    const sentence = sentences[index];
    const attribution = inferClaimAttribution(sentence, input.source);
    const statement = isStatementSentence(sentence, input.source);
    const casualties = extractCasualtyMentions(sentence);
    const casualtyRanges = casualties.map((item) => [item.start, item.end] as const);
    const numbers = extractNumberMentions(sentence).filter(
      (item) => !casualtyRanges.some(([start, end]) => item.start < end && item.end > start)
    );

    if (statement) push(sentence, statementDraft(sentence, attribution, input));
    for (const draft of casualtyDrafts(sentence, casualties, attribution, input)) push(sentence, draft);
    for (const draft of numberDrafts(sentence, numbers, attribution, input)) push(sentence, draft);

    const isLead = index < 2 || normalizeText(sentence) === titleKey;
    if (!statement && casualties.length === 0 && numbers.length === 0 && isLead && !QUESTION_RE.test(sentence)) {
      push(sentence, genericDraft(sentence, attribution, input));
    }
  }

  return out;
}

/** 仅返回底层伤亡主张，不返回同句生成的 statement 主张 */
export function extractCasualtyClaims(input: ClaimExtractionInput): ExtractedClaim[] {
  return extractClaims({ ...input, maxClaims: Math.max(input.maxClaims ?? 12, 24) }).filter((claim) => claim.type === "casualty");
}

/** 去除抽取阶段的解释字段，得到可直接写入 claims 的对象 */
export function toClaimInsert(claim: ExtractedClaim): ClaimInsert {
  const { evidenceStance: _stance, evidenceHasPrimary: _primary, sourceSentence: _sentence, qualifier: _qualifier, proposition: _proposition, ...insert } = claim;
  return insert;
}

/** 生成 claim_evidence 写入对象，证据立场沿用 claim-specific 判定 */
export function buildClaimEvidenceInsert(
  claim: ExtractedClaim,
  articleId: string,
  createdAt: string,
  familyKey: string | null = null,
  note: string | null = null
): ClaimEvidenceInsert {
  return {
    claimId: claim.id,
    articleId,
    stance: claim.evidenceStance,
    familyKey,
    hasPrimary: claim.evidenceHasPrimary,
    note,
    createdAt,
  };
}

/** 判断文本是否明确表示数字修正或更新 */
export function isClaimCorrection(text: string): boolean {
  return UPDATE_RE.test(text);
}
