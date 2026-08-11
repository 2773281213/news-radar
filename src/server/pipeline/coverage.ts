import { CATEGORY_LABELS, PARTY_LABELS } from "../../shared/constants";
import type { CoverageDTO, SourceCategory } from "../../shared/types";
import { articles, eventArticles, sources } from "../db/schema";
import { baseDomain } from "../lib/urls";

export type ArticleRow = typeof articles.$inferSelect;
export type SourceRow = typeof sources.$inferSelect;
export type EventArticleRow = typeof eventArticles.$inferSelect;

export const SOURCE_CATEGORIES = [
  "gov_cn",
  "official_media_cn",
  "market_media_cn",
  "social_cn",
  "gov_intl",
  "intl_org",
  "wire",
  "intl_media",
  "local_media",
  "party_media",
  "social",
  "data",
  "factcheck",
] as const satisfies readonly SourceCategory[];

export interface CoverageArticleRow {
  articleId: string;
  sourceId: string;
  url?: string | null;
  category: SourceCategory | string;
  familyKey?: string | null;
  sourceFamilyId?: string | null;
  sourceFamilyKind?: string | null;
  wireFamily?: string | null;
  reprintOf?: string | null;
  isReprint?: boolean;
  isParty?: boolean;
  partyOf?: string | null;
  role?: "report" | "statement" | "data" | "analysis" | string | null;
}

export interface CoverageRequirements {
  requiredCategories?: readonly SourceCategory[];
  requiredParties?: readonly string[];
  topics?: readonly string[];
  countries?: readonly string[];
}

export interface CoverageMatrixRow {
  category: SourceCategory;
  label: string;
  required: boolean;
  present: boolean;
  articleCount: number;
  originalArticleCount: number;
  independentFamilies: number;
  partyCount: number;
  roles: Record<string, number>;
}

export interface PartyCoverageRow {
  party: string;
  label: string;
  required: boolean;
  present: boolean;
  articleCount: number;
  statementCount: number;
  independentFamilies: number;
}

export interface EventCoverageMatrix {
  coverage: CoverageDTO;
  categories: CoverageMatrixRow[];
  parties: PartyCoverageRow[];
  totalArticles: number;
  originalArticles: number;
  reprints: number;
}

const CATEGORY_SET = new Set<string>(SOURCE_CATEGORIES);

export function isSourceCategory(value: string): value is SourceCategory {
  return CATEGORY_SET.has(value);
}

/** 从 Drizzle 查询到的 article/source/eventArticle 三行构造覆盖计算输入 */
export function coverageRowFromDb(
  article: Pick<ArticleRow, "id" | "sourceId" | "url" | "wireFamily" | "reprintOf" | "isReprint">,
  source: Pick<SourceRow, "id" | "category" | "familyId" | "isParty" | "partyOf"> & { familyKind?: string | null },
  relation?: Pick<EventArticleRow, "familyKey" | "role"> | null
): CoverageArticleRow {
  return {
    articleId: article.id,
    sourceId: article.sourceId || source.id,
    url: article.url,
    category: source.category,
    familyKey: relation?.familyKey || null,
    sourceFamilyId: source.familyId,
    sourceFamilyKind: source.familyKind || null,
    wireFamily: article.wireFamily,
    reprintOf: article.reprintOf,
    isReprint: article.isReprint,
    isParty: source.isParty,
    partyOf: source.partyOf,
    role: relation?.role || null,
  };
}

/** 生成覆盖矩阵中的独立家族键，转载稿和通讯社稿不会虚增独立来源数 */
export function familyKeyForCoverage(
  row: CoverageArticleRow,
  knownReprintRoots: ReadonlySet<string> = new Set()
): string {
  if (row.familyKey) return row.familyKey;
  if (row.wireFamily) return row.wireFamily.startsWith("wire:") || row.wireFamily.startsWith("reprint:")
    ? row.wireFamily
    : `wire:${row.wireFamily}`;
  if (row.reprintOf) return `reprint:${row.reprintOf}`;
  if (knownReprintRoots.has(row.articleId)) return `reprint:${row.articleId}`;
  if (row.sourceFamilyId && (row.sourceFamilyKind === "ownership" || row.sourceFamilyKind === "wire")) {
    return `family:${row.sourceFamilyId}`;
  }
  if (row.sourceId) return `source:${row.sourceId}`;
  const domain = row.url ? baseDomain(row.url) : "";
  return domain ? `domain:${domain}` : `article:${row.articleId}`;
}

/** 根据事件主题推导最小覆盖要求，不会默认要求全部十三类来源 */
export function coverageRequirementsForTopics(
  topics: readonly string[] = [],
  countries: readonly string[] = []
): SourceCategory[] {
  const required = new Set<SourceCategory>();
  const topicSet = new Set(topics);
  const domesticCn = countries.includes("cn");

  if (topicSet.has("conflict") || topicSet.has("defense")) {
    required.add("wire");
    required.add("local_media");
    required.add("intl_org");
  }
  if (topicSet.has("diplomacy") || topicSet.has("intl_politics") || topicSet.has("election") || topicSet.has("sanctions")) {
    required.add("gov_intl");
    required.add("wire");
    required.add("intl_media");
  }
  if (topicSet.has("investigation")) {
    required.add("factcheck");
    required.add("data");
  }
  if (topicSet.has("disaster") || topicSet.has("security") || topicSet.has("health") || topicSet.has("climate")) {
    required.add("local_media");
    required.add("data");
  }
  if (domesticCn && (topicSet.has("domestic_politics") || topicSet.has("policy") || topicSet.has("economy") || topicSet.has("finance"))) {
    required.add("gov_cn");
    required.add("market_media_cn");
  }
  if (topicSet.has("economy") || topicSet.has("finance") || topicSet.has("energy")) required.add("data");
  return SOURCE_CATEGORIES.filter((category) => required.has(category));
}

function normalizedRequirements(requirements: CoverageRequirements): { categories: SourceCategory[]; parties: string[] } {
  const inferred = coverageRequirementsForTopics(requirements.topics, requirements.countries);
  const categories = requirements.requiredCategories
    ? SOURCE_CATEGORIES.filter((category) => requirements.requiredCategories?.includes(category))
    : inferred;
  return {
    categories,
    parties: [...new Set(requirements.requiredParties || [])].sort(),
  };
}

function emptyCounts(): Record<string, number> {
  return Object.fromEntries(SOURCE_CATEGORIES.map((category) => [category, 0]));
}

/** 构建事件来源覆盖矩阵，并分别统计文章数与独立来源家族数 */
export function buildCoverageMatrix(
  input: readonly CoverageArticleRow[],
  requirements: CoverageRequirements = {}
): EventCoverageMatrix {
  const uniqueRows = new Map<string, CoverageArticleRow>();
  for (const row of input) {
    if (!uniqueRows.has(row.articleId)) uniqueRows.set(row.articleId, row);
  }
  const rows = [...uniqueRows.values()].filter((row) => isSourceCategory(row.category));
  const reprintRoots = new Set(rows.map((row) => row.reprintOf).filter((value): value is string => Boolean(value)));
  const familyOf = (row: CoverageArticleRow) => familyKeyForCoverage(row, reprintRoots);
  const required = normalizedRequirements(requirements);
  const requiredCategorySet = new Set(required.categories);
  const requiredPartySet = new Set(required.parties);
  const globalFamilies = new Set<string>();
  const byCategory = emptyCounts();

  const categories = SOURCE_CATEGORIES.map<CoverageMatrixRow>((category) => {
    const categoryRows = rows.filter((row) => row.category === category);
    const families = new Set(categoryRows.map(familyOf));
    const roles: Record<string, number> = {};
    for (const row of categoryRows) {
      const role = row.role || "report";
      roles[role] = (roles[role] || 0) + 1;
      globalFamilies.add(familyOf(row));
    }
    byCategory[category] = categoryRows.length;
    return {
      category,
      label: CATEGORY_LABELS[category],
      required: requiredCategorySet.has(category),
      present: categoryRows.length > 0,
      articleCount: categoryRows.length,
      originalArticleCount: categoryRows.filter((row) => !row.isReprint).length,
      independentFamilies: families.size,
      partyCount: new Set(categoryRows.filter((row) => row.partyOf).map((row) => row.partyOf as string)).size,
      roles,
    };
  });

  const discoveredParties = rows.filter((row) => row.partyOf).map((row) => row.partyOf as string);
  const partyKeys = [...new Set([...required.parties, ...discoveredParties])].sort();
  const parties = partyKeys.map<PartyCoverageRow>((party) => {
    const partyRows = rows.filter((row) => row.partyOf === party || (row.isParty && row.sourceId === party));
    const statementRows = partyRows.filter((row) => row.role === "statement");
    return {
      party,
      label: PARTY_LABELS[party] || party,
      required: requiredPartySet.has(party),
      present: statementRows.length > 0,
      articleCount: partyRows.length,
      statementCount: statementRows.length,
      independentFamilies: new Set(statementRows.map(familyOf)).size,
    };
  });

  const present = categories.filter((row) => row.originalArticleCount > 0).map((row) => row.label);
  const gaps = categories.filter((row) => row.required && row.originalArticleCount === 0).map((row) => row.label);
  for (const party of parties) {
    const label = `当事方声明：${party.label}`;
    if (party.present) present.push(label);
    else if (party.required) gaps.push(label);
  }

  const originalArticles = rows.filter((row) => !row.isReprint).length;
  return {
    coverage: {
      present,
      gaps,
      byCategory,
      independentFamilies: globalFamilies.size,
    },
    categories,
    parties,
    totalArticles: rows.length,
    originalArticles,
    reprints: rows.length - originalArticles,
  };
}

/** 兼容直接传 requiredCategories 的简化调用 */
export function buildCoverage(
  input: readonly CoverageArticleRow[],
  requirements: CoverageRequirements | readonly SourceCategory[] = {}
): CoverageDTO {
  const normalized: CoverageRequirements = Array.isArray(requirements)
    ? { requiredCategories: [...requirements] as SourceCategory[] }
    : requirements as CoverageRequirements;
  return buildCoverageMatrix(input, normalized).coverage;
}

export const buildEventCoverage = buildCoverage;
