import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sql } from "drizzle-orm";
import type { AdapterKind, SourceCategory, SourceHealth, VerifStatus } from "../src/shared/types";
import { loadConfig, loadDotenv } from "../src/server/config";
import { openDb } from "../src/server/db/client";
import { sourceFamilies, sources } from "../src/server/db/schema";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_FAMILIES_PATH = resolve(PROJECT_ROOT, "seeds", "families.json");
export const DEFAULT_SOURCES_PATH = resolve(PROJECT_ROOT, "seeds", "sources.json");

const ADAPTERS = new Set<AdapterKind>(["rss", "jsonfeed", "gdelt", "mastodon", "bluesky", "telegramweb"]);
const CATEGORIES = new Set<SourceCategory>([
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
]);
const VERIF_STATUSES = new Set<VerifStatus>(["verified", "pending", "unverified"]);
const HEALTH_STATES = new Set<SourceHealth>(["ok", "degraded", "failing", "disabled", "unknown"]);
const FAMILY_KINDS = new Set<SourceFamilySeed["kind"]>(["ownership", "wire", "platform"]);
const SOURCE_KEYS = [
  "id",
  "name",
  "homepage",
  "feedUrl",
  "adapter",
  "config",
  "country",
  "region",
  "lang",
  "category",
  "owner",
  "ownershipNote",
  "isParty",
  "partyOf",
  "isPrimary",
  "paywalled",
  "fetchFulltext",
  "intervalMin",
  "verifStatus",
  "verifBasis",
  "lastReviewedAt",
  "familyId",
  "enabled",
  "lastFetchAt",
  "lastSuccessAt",
  "consecFails",
  "backoffUntil",
  "health",
  "corrections",
  "addedBy",
  "notes",
] as const;
const FAMILY_KEYS = ["id", "name", "kind", "note"] as const;

export interface SourceFamilySeed {
  id: string;
  name: string;
  kind: "ownership" | "wire" | "platform";
  note: string | null;
}

export interface SourceSeed {
  id: string;
  name: string;
  homepage: string;
  feedUrl: string | null;
  adapter: AdapterKind;
  config: Record<string, string> | null;
  country: string | null;
  region: string;
  lang: string;
  category: SourceCategory;
  owner: string;
  ownershipNote: string;
  isParty: boolean;
  partyOf: string | null;
  isPrimary: boolean;
  paywalled: boolean;
  fetchFulltext: boolean;
  intervalMin: number;
  verifStatus: VerifStatus;
  verifBasis: string;
  lastReviewedAt: string;
  familyId: string;
  enabled: boolean;
  lastFetchAt: string | null;
  lastSuccessAt: string | null;
  consecFails: number;
  backoffUntil: string | null;
  health: SourceHealth;
  corrections: number;
  addedBy: string;
  notes: string | null;
}

export interface LoadedSourceRegistry {
  families: SourceFamilySeed[];
  sources: SourceSeed[];
  familiesPath: string;
  sourcesPath: string;
}

interface SeedCliArgs {
  familiesPath?: string;
  sourcesPath?: string;
  dataDir?: string;
  dbFile: string;
  dryRun: boolean;
}

function fail(message: string): never {
  throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  const missing = expected.filter((key) => !(key in value));
  const extra = Object.keys(value).filter((key) => !expectedSet.has(key));
  if (missing.length > 0) fail(`${label} 缺少字段：${missing.join(", ")}`);
  if (extra.length > 0) fail(`${label} 包含未知字段：${extra.join(", ")}`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${label} 必须是非空字符串`);
  return value.trim();
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return requiredString(value, label);
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") fail(`${label} 必须是布尔值`);
  return value;
}

function requiredInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value)) fail(`${label} 必须是整数`);
  return value as number;
}

function stringMap(value: unknown, label: string): Record<string, string> | null {
  if (value === null) return null;
  if (!isRecord(value)) fail(`${label} 必须是字符串键值对象或 null`);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) result[key] = requiredString(item, `${label}.${key}`);
  return result;
}

function enumValue<T extends string>(value: unknown, allowed: Set<T>, label: string): T {
  if (typeof value !== "string" || !allowed.has(value as T)) fail(`${label} 取值无效：${String(value)}`);
  return value as T;
}

function assertId(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(value)) fail(`${label} 只能使用小写字母、数字与连字符`);
}

function assertIsoUtc(value: string, label: string): void {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) fail(`${label} 必须是规范 UTC ISO8601 时间`);
}

function assertHttpUrl(value: string, label: string, allowRsshubPlaceholder = false): void {
  if (value.includes("{RSSHUB}") && (!allowRsshubPlaceholder || !value.startsWith("{RSSHUB}/"))) {
    fail(`${label} 的 {RSSHUB} 占位符位置无效`);
  }
  const normalized = value.replace("{RSSHUB}", "https://rsshub.example");
  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    fail(`${label} 不是有效 URL`);
  }
  if (!["http:", "https:"].includes(url.protocol)) fail(`${label} 只允许 HTTP(S)`);
  if (url.username || url.password) fail(`${label} 不得携带凭据`);
}

function assertConfigKeys(config: Record<string, string>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const extra = Object.keys(config).filter((key) => !allowedSet.has(key));
  if (extra.length > 0) fail(`${label} 包含不支持的配置字段：${extra.join(", ")}`);
}

function readCollection(path: string, key: "families" | "sources"): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (error) {
    fail(`无法读取种子文件 ${path}：${String((error as Error).message || error)}`);
  }
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) fail(`${path} 顶层必须是数组或对象`);
  if (parsed.schemaVersion !== 1) fail(`${path} 的 schemaVersion 必须为 1`);
  const values = parsed[key];
  if (!Array.isArray(values)) fail(`${path} 缺少 ${key} 数组`);
  return values;
}

function parseFamily(value: unknown, index: number): SourceFamilySeed {
  const label = `families[${index}]`;
  if (!isRecord(value)) fail(`${label} 必须是对象`);
  assertExactKeys(value, FAMILY_KEYS, label);
  const family: SourceFamilySeed = {
    id: requiredString(value.id, `${label}.id`),
    name: requiredString(value.name, `${label}.name`),
    kind: enumValue(value.kind, FAMILY_KINDS, `${label}.kind`),
    note: nullableString(value.note, `${label}.note`),
  };
  assertId(family.id, `${label}.id`);
  return family;
}

function parseSource(value: unknown, index: number): SourceSeed {
  const label = `sources[${index}]`;
  if (!isRecord(value)) fail(`${label} 必须是对象`);
  assertExactKeys(value, SOURCE_KEYS, label);
  const source: SourceSeed = {
    id: requiredString(value.id, `${label}.id`),
    name: requiredString(value.name, `${label}.name`),
    homepage: requiredString(value.homepage, `${label}.homepage`),
    feedUrl: nullableString(value.feedUrl, `${label}.feedUrl`),
    adapter: enumValue(value.adapter, ADAPTERS, `${label}.adapter`),
    config: stringMap(value.config, `${label}.config`),
    country: nullableString(value.country, `${label}.country`),
    region: requiredString(value.region, `${label}.region`),
    lang: requiredString(value.lang, `${label}.lang`),
    category: enumValue(value.category, CATEGORIES, `${label}.category`),
    owner: requiredString(value.owner, `${label}.owner`),
    ownershipNote: requiredString(value.ownershipNote, `${label}.ownershipNote`),
    isParty: requiredBoolean(value.isParty, `${label}.isParty`),
    partyOf: nullableString(value.partyOf, `${label}.partyOf`),
    isPrimary: requiredBoolean(value.isPrimary, `${label}.isPrimary`),
    paywalled: requiredBoolean(value.paywalled, `${label}.paywalled`),
    fetchFulltext: requiredBoolean(value.fetchFulltext, `${label}.fetchFulltext`),
    intervalMin: requiredInteger(value.intervalMin, `${label}.intervalMin`),
    verifStatus: enumValue(value.verifStatus, VERIF_STATUSES, `${label}.verifStatus`),
    verifBasis: requiredString(value.verifBasis, `${label}.verifBasis`),
    lastReviewedAt: requiredString(value.lastReviewedAt, `${label}.lastReviewedAt`),
    familyId: requiredString(value.familyId, `${label}.familyId`),
    enabled: requiredBoolean(value.enabled, `${label}.enabled`),
    lastFetchAt: nullableString(value.lastFetchAt, `${label}.lastFetchAt`),
    lastSuccessAt: nullableString(value.lastSuccessAt, `${label}.lastSuccessAt`),
    consecFails: requiredInteger(value.consecFails, `${label}.consecFails`),
    backoffUntil: nullableString(value.backoffUntil, `${label}.backoffUntil`),
    health: enumValue(value.health, HEALTH_STATES, `${label}.health`),
    corrections: requiredInteger(value.corrections, `${label}.corrections`),
    addedBy: requiredString(value.addedBy, `${label}.addedBy`),
    notes: nullableString(value.notes, `${label}.notes`),
  };

  assertId(source.id, `${label}.id`);
  assertId(source.familyId, `${label}.familyId`);
  assertHttpUrl(source.homepage, `${label}.homepage`);
  if (source.feedUrl) assertHttpUrl(source.feedUrl, `${label}.feedUrl`, true);
  assertIsoUtc(source.lastReviewedAt, `${label}.lastReviewedAt`);
  if (source.country && !/^[a-z]{2}$/.test(source.country)) fail(`${label}.country 必须是小写 ISO 3166-1 alpha-2 代码或 null`);
  if (source.intervalMin < 5 || source.intervalMin > 1440) fail(`${label}.intervalMin 必须在 5 到 1440 之间`);
  if (source.verifStatus !== "verified") fail(`${label} 必须完成来源身份核验后才能进入正式种子`);
  if (source.isParty !== (source.partyOf !== null)) fail(`${label}.isParty 与 partyOf 必须一致`);
  if (source.lastFetchAt !== null || source.lastSuccessAt !== null || source.backoffUntil !== null) {
    fail(`${label} 的运行时健康时间必须以 null 初始化`);
  }
  if (source.consecFails !== 0 || source.corrections !== 0) fail(`${label} 的运行时计数必须以 0 初始化`);
  const expectedHealth: SourceHealth = source.enabled ? "unknown" : "disabled";
  if (source.health !== expectedHealth) fail(`${label}.health 应为 ${expectedHealth}`);
  if (source.feedUrl?.startsWith("{RSSHUB}") && source.enabled) fail(`${label} 使用 RSSHub 路由时必须默认停用`);

  if (source.adapter === "rss" || source.adapter === "jsonfeed") {
    if (!source.feedUrl) fail(`${label} 的 ${source.adapter} 适配器需要 feedUrl`);
    if (source.config !== null) fail(`${label} 的 ${source.adapter} 适配器不应设置 config`);
  } else {
    if (source.feedUrl !== null) fail(`${label} 的 ${source.adapter} 适配器应通过 config 定位来源`);
    if (!source.config) fail(`${label} 的 ${source.adapter} 适配器需要 config`);
  }

  if (source.adapter === "gdelt" && source.config) {
    assertConfigKeys(source.config, ["query", "timespan"], `${label}.config`);
    requiredString(source.config.query, `${label}.config.query`);
    if (source.config.timespan && !/^\d+[mhd]$/i.test(source.config.timespan)) fail(`${label}.config.timespan 格式无效`);
  }
  if (source.adapter === "mastodon" && source.config) {
    assertConfigKeys(source.config, ["instance", "acct"], `${label}.config`);
    assertHttpUrl(requiredString(source.config.instance, `${label}.config.instance`), `${label}.config.instance`);
    requiredString(source.config.acct, `${label}.config.acct`);
  }
  if (source.adapter === "bluesky" && source.config) {
    assertConfigKeys(source.config, ["actor"], `${label}.config`);
    requiredString(source.config.actor, `${label}.config.actor`);
  }
  if (source.adapter === "telegramweb" && source.config) {
    assertConfigKeys(source.config, ["channel"], `${label}.config`);
    const channel = requiredString(source.config.channel, `${label}.config.channel`);
    if (!/^[A-Za-z0-9_]{5,}$/.test(channel)) fail(`${label}.config.channel 不是有效公开频道名`);
  }
  return source;
}

function endpointKey(source: SourceSeed): string {
  if (source.feedUrl) return `feed:${source.feedUrl.toLowerCase()}`;
  const config = source.config || {};
  if (source.adapter === "mastodon") return `mastodon:${config.instance?.toLowerCase()}:${config.acct?.toLowerCase()}`;
  if (source.adapter === "bluesky") return `bluesky:${config.actor?.toLowerCase()}`;
  if (source.adapter === "telegramweb") return `telegram:${config.channel?.toLowerCase()}`;
  if (source.adapter === "gdelt") return `gdelt:${config.query}:${config.timespan || "1d"}`;
  return `${source.adapter}:${source.id}`;
}

function assertUnique<T>(values: T[], keyOf: (value: T) => string, label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) fail(`${label} 重复：${key}`);
    seen.add(key);
  }
}

export function loadSourceRegistry(
  options: { familiesPath?: string; sourcesPath?: string } = {}
): LoadedSourceRegistry {
  const familiesPath = options.familiesPath
    ? resolve(process.cwd(), options.familiesPath)
    : DEFAULT_FAMILIES_PATH;
  const sourcesPath = options.sourcesPath
    ? resolve(process.cwd(), options.sourcesPath)
    : DEFAULT_SOURCES_PATH;
  const families = readCollection(familiesPath, "families").map(parseFamily);
  const sourceRows = readCollection(sourcesPath, "sources").map(parseSource);

  assertUnique(families, (family) => family.id, "来源家族 ID");
  assertUnique(sourceRows, (source) => source.id, "来源 ID");
  assertUnique(sourceRows, endpointKey, "来源端点");
  const familyIds = new Set(families.map((family) => family.id));
  for (const source of sourceRows) {
    if (!familyIds.has(source.familyId)) fail(`来源 ${source.id} 引用了不存在的家族 ${source.familyId}`);
  }
  return { families, sources: sourceRows, familiesPath, sourcesPath };
}

function takeValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${option} 缺少参数`);
  return value;
}

function parseArgs(argv: string[]): SeedCliArgs {
  const args: SeedCliArgs = { dbFile: "news.db", dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--families") args.familiesPath = takeValue(argv, i++, arg);
    else if (arg === "--sources") args.sourcesPath = takeValue(argv, i++, arg);
    else if (arg === "--data-dir") args.dataDir = takeValue(argv, i++, arg);
    else if (arg === "--db-file") args.dbFile = takeValue(argv, i++, arg);
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--help") {
      console.log(
        "用法: tsx scripts/seed-sources.ts [--families 路径] [--sources 路径] " +
          "[--data-dir 目录] [--db-file 文件名] [--dry-run]"
      );
      process.exit(0);
    } else fail(`未知参数：${arg}`);
  }
  if (!/^[^/\\]+\.db$/.test(args.dbFile)) fail("--db-file 必须是当前数据目录中的 .db 文件名");
  return args;
}

function resolveDataDir(value: string, fromCli: boolean): string {
  if (value === ":memory:") return value;
  return resolve(fromCli ? process.cwd() : PROJECT_ROOT, value);
}

export function seedSourceRegistry(args: SeedCliArgs): void {
  const registry = loadSourceRegistry({ familiesPath: args.familiesPath, sourcesPath: args.sourcesPath });
  const enabledCount = registry.sources.filter((source) => source.enabled).length;
  const disabledCount = registry.sources.length - enabledCount;
  console.log(
    `种子校验完成：${registry.families.length} 个来源家族，${registry.sources.length} 个来源` +
      `（启用 ${enabledCount}，停用 ${disabledCount}）`
  );
  if (args.dryRun) return;

  loadDotenv(resolve(PROJECT_ROOT, ".env"));
  const config = loadConfig();
  const dataDir = resolveDataDir(args.dataDir ?? config.dataDir, args.dataDir !== undefined);
  const { db, raw } = openDb(dataDir, resolve(PROJECT_ROOT, "migrations"), args.dbFile);
  try {
    const existingFamilyIds = new Set(
      db.select({ id: sourceFamilies.id }).from(sourceFamilies).all().map((row) => row.id)
    );
    const existingSourceIds = new Set(
      db.select({ id: sources.id }).from(sources).all().map((row) => row.id)
    );
    const now = new Date().toISOString();

    db.transaction((tx) => {
      for (const family of registry.families) {
        tx.insert(sourceFamilies)
          .values(family)
          .onConflictDoUpdate({
            target: sourceFamilies.id,
            set: { name: family.name, kind: family.kind, note: family.note },
          })
          .run();
      }

      for (const source of registry.sources) {
        const row: typeof sources.$inferInsert = { ...source, createdAt: now, updatedAt: now };
        tx.insert(sources)
          .values(row)
          .onConflictDoUpdate({
            target: sources.id,
            set: {
              name: source.name,
              homepage: source.homepage,
              feedUrl: source.feedUrl,
              adapter: source.adapter,
              config: source.config,
              country: source.country,
              region: source.region,
              lang: source.lang,
              category: source.category,
              owner: source.owner,
              ownershipNote: source.ownershipNote,
              isParty: source.isParty,
              partyOf: source.partyOf,
              isPrimary: source.isPrimary,
              paywalled: source.paywalled,
              fetchFulltext: source.fetchFulltext,
              intervalMin: source.intervalMin,
              verifStatus: source.verifStatus,
              verifBasis: source.verifBasis,
              lastReviewedAt: source.lastReviewedAt,
              familyId: source.familyId,
              enabled: source.enabled,
              health: source.enabled
                ? sql`CASE WHEN ${sources.health} = 'disabled' THEN 'unknown' ELSE ${sources.health} END`
                : "disabled",
              addedBy: source.addedBy,
              notes: source.notes,
              updatedAt: now,
            },
          })
          .run();
      }
    });

    const newFamilies = registry.families.filter((family) => !existingFamilyIds.has(family.id)).length;
    const newSources = registry.sources.filter((source) => !existingSourceIds.has(source.id)).length;
    const updatedFamilies = registry.families.length - newFamilies;
    const updatedSources = registry.sources.length - newSources;
    console.log(
      `幂等写入完成：家族新增 ${newFamilies} / 更新 ${updatedFamilies}，` +
        `来源新增 ${newSources} / 更新 ${updatedSources}`
    );
  } finally {
    raw.close();
  }
}

function isMainModule(): boolean {
  return Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
}

if (isMainModule()) {
  try {
    seedSourceRegistry(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(`来源种子失败：${String((error as Error).message || error)}`);
    process.exitCode = 1;
  }
}
