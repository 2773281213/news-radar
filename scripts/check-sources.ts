import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, loadDotenv } from "../src/server/config";
import { runAdapter } from "../src/server/adapters";
import type { KV } from "../src/server/lib/kv";
import { loadSourceRegistry, type SourceSeed } from "./seed-sources";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET_QUERY_KEY =
  /^(?:api[-_]?key|access[-_]?token|token|secret|signature|sig|password|passwd|auth|authorization|appname)$/i;
const SECRET_QUERY_VALUE = /([?&][^=&]*(?:key|token|secret|signature|password|auth|appname)[^=]*=)[^&\s]+/gi;

interface CheckCliArgs {
  familiesPath?: string;
  sourcesPath?: string;
  includeDisabled: boolean;
  selectedIds: Set<string>;
  concurrency?: number;
  timeoutMs?: number;
  strict: boolean;
  json: boolean;
}

type ProbeState = "ok" | "empty" | "failed";

interface ProbeResult {
  id: string;
  name: string;
  adapter: SourceSeed["adapter"];
  state: ProbeState;
  httpStatus: number;
  items: number;
  elapsedMs: number;
  error: string | null;
}

interface CacheValue {
  value: string;
  expiresAt: number | null;
}

/** 检查脚本只需要进程内缓存，避免为探测创建或修改数据库。 */
class MemoryKv {
  private readonly values = new Map<string, CacheValue>();

  async get(key: string): Promise<string | null> {
    const current = this.values.get(key);
    if (!current) return null;
    if (current.expiresAt !== null && current.expiresAt <= Date.now()) {
      this.values.delete(key);
      return null;
    }
    return current.value;
  }

  async set(key: string, value: string, ttlSec?: number): Promise<void> {
    this.values.set(key, { value, expiresAt: ttlSec ? Date.now() + ttlSec * 1000 : null });
  }

  async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function takeValue(argv: string[], index: number, option: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${option} 缺少参数`);
  return value;
}

function positiveInteger(value: string, label: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) fail(`${label} 必须是 ${min} 到 ${max} 之间的整数`);
  return parsed;
}

function parseArgs(argv: string[]): CheckCliArgs {
  const args: CheckCliArgs = {
    includeDisabled: false,
    selectedIds: new Set<string>(),
    strict: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--families") args.familiesPath = takeValue(argv, i++, arg);
    else if (arg === "--sources") args.sourcesPath = takeValue(argv, i++, arg);
    else if (arg === "--all") args.includeDisabled = true;
    else if (arg === "--source") {
      for (const id of takeValue(argv, i++, arg).split(",")) {
        if (id.trim()) args.selectedIds.add(id.trim());
      }
    } else if (arg === "--concurrency") args.concurrency = positiveInteger(takeValue(argv, i++, arg), arg, 1, 20);
    else if (arg === "--timeout-ms") args.timeoutMs = positiveInteger(takeValue(argv, i++, arg), arg, 1000, 60000);
    else if (arg === "--strict") args.strict = true;
    else if (arg === "--json") args.json = true;
    else if (arg === "--help") {
      console.log(
        "用法: tsx scripts/check-sources.ts [--families 路径] [--sources 路径] [--all] " +
          "[--source id[,id]] [--concurrency 1-20] [--timeout-ms 1000-60000] [--strict] [--json]"
      );
      process.exit(0);
    } else fail(`未知参数：${arg}`);
  }
  return args;
}

function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.username || url.password) {
      url.username = "[REDACTED]";
      url.password = "";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY_KEY.test(key)) url.searchParams.set(key, "[REDACTED]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return raw
      .replace(SECRET_QUERY_VALUE, "$1[REDACTED]")
      .replace(/\/\/[^/@\s]+@/g, "//[REDACTED]@");
  }
}

/** 错误只保留诊断所需的短文本，并清理 URL 中可能出现的凭据。 */
function sanitizeError(value: unknown): string {
  const message = String((value as Error)?.message || value || "未知错误").replace(/[\x00-\x1f\x7f]+/g, " ");
  const redacted = message.replace(/https?:\/\/[^\s"'<>]+/gi, (url) => redactUrl(url));
  return redacted.length > 320 ? `${redacted.slice(0, 317)}...` : redacted;
}

function sourceRow(source: SourceSeed) {
  return {
    ...source,
    createdAt: source.lastReviewedAt,
    updatedAt: source.lastReviewedAt,
  };
}

async function probeSource(
  source: SourceSeed,
  kv: MemoryKv,
  options: { timeoutMs: number; userAgent: string; rsshubBase: string }
): Promise<ProbeResult> {
  const startedAt = performance.now();
  try {
    const result = await runAdapter(
      sourceRow(source),
      kv as unknown as KV,
      {
        timeoutMs: options.timeoutMs,
        maxBytes: 3 * 1024 * 1024,
        maxRedirects: 5,
        userAgent: options.userAgent,
      },
      options.rsshubBase
    );
    const elapsedMs = Math.round(performance.now() - startedAt);
    if (result.error) {
      return {
        id: source.id,
        name: source.name,
        adapter: source.adapter,
        state: "failed",
        httpStatus: result.httpStatus,
        items: result.items.length,
        elapsedMs,
        error: sanitizeError(result.error),
      };
    }
    if (result.items.length === 0) {
      return {
        id: source.id,
        name: source.name,
        adapter: source.adapter,
        state: "empty",
        httpStatus: result.httpStatus,
        items: 0,
        elapsedMs,
        error: "请求成功，但未解析到任何条目",
      };
    }
    return {
      id: source.id,
      name: source.name,
      adapter: source.adapter,
      state: "ok",
      httpStatus: result.httpStatus,
      items: result.items.length,
      elapsedMs,
      error: null,
    };
  } catch (error) {
    return {
      id: source.id,
      name: source.name,
      adapter: source.adapter,
      state: "failed",
      httpStatus: 0,
      items: 0,
      elapsedMs: Math.round(performance.now() - startedAt),
      error: sanitizeError(error),
    };
  }
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function runWorker(): Promise<void> {
    for (;;) {
      const index = nextIndex++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => runWorker()));
  return results;
}

function printHumanSummary(results: ProbeResult[], skippedDisabled: number, elapsedMs: number): void {
  const stateLabel: Record<ProbeState, string> = { ok: "OK", empty: "EMPTY", failed: "FAIL" };
  for (const result of results) {
    const http = result.httpStatus > 0 ? String(result.httpStatus) : "-";
    const counts = `${http.padStart(3)} ${String(result.items).padStart(4)}`;
    const timing = `${String(result.elapsedMs).padStart(6)}ms`;
    console.log(`${stateLabel[result.state].padEnd(5)} ${counts} ${timing}  ${result.id}  ${result.name}`);
  }

  const ok = results.filter((result) => result.state === "ok").length;
  const empty = results.filter((result) => result.state === "empty").length;
  const failed = results.filter((result) => result.state === "failed").length;
  const summary = [
    `探测 ${results.length}`,
    `正常 ${ok}`,
    `空结果 ${empty}`,
    `失败 ${failed}`,
    `跳过停用 ${skippedDisabled}`,
    `总耗时 ${elapsedMs}ms`,
  ].join("，");
  console.log(`\n来源检查汇总：${summary}`);

  const externalErrors = results.filter((result) => result.state !== "ok");
  if (externalErrors.length > 0) {
    console.log("外部来源错误：");
    for (const result of externalErrors) {
      const http = result.httpStatus > 0 ? `HTTP ${result.httpStatus}` : "无 HTTP 状态";
      console.log(`- ${result.id}（${http}）：${result.error}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const registry = loadSourceRegistry({ familiesPath: args.familiesPath, sourcesPath: args.sourcesPath });
  loadDotenv(resolve(PROJECT_ROOT, ".env"));
  const config = loadConfig();
  const concurrency = args.concurrency ?? Math.min(config.fetchConcurrency, 20);
  const timeoutMs = args.timeoutMs ?? 15000;

  if (args.selectedIds.size > 0) {
    const knownIds = new Set(registry.sources.map((source) => source.id));
    const unknown = [...args.selectedIds].filter((id) => !knownIds.has(id));
    if (unknown.length > 0) fail(`未知来源 ID：${unknown.join(", ")}`);
  }

  const selected = registry.sources.filter((source) => {
    if (args.selectedIds.size > 0) return args.selectedIds.has(source.id);
    return args.includeDisabled || source.enabled;
  });
  if (selected.length === 0) fail("没有符合条件的来源可检查");

  const skippedDisabled = args.selectedIds.size > 0 || args.includeDisabled
    ? 0
    : registry.sources.filter((source) => !source.enabled).length;
  const kv = new MemoryKv();
  const startedAt = performance.now();
  const results = await mapConcurrent(selected, concurrency, (source) =>
    probeSource(source, kv, {
      timeoutMs,
      userAgent: config.userAgent,
      rsshubBase: config.rsshubBase,
    })
  );
  const elapsedMs = Math.round(performance.now() - startedAt);
  const counts = {
    total: results.length,
    ok: results.filter((result) => result.state === "ok").length,
    empty: results.filter((result) => result.state === "empty").length,
    failed: results.filter((result) => result.state === "failed").length,
    skippedDisabled,
  };

  if (args.json) {
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), elapsedMs, counts, results }, null, 2));
  } else {
    printHumanSummary(results, skippedDisabled, elapsedMs);
  }
  if (args.strict && (counts.failed > 0 || counts.empty > 0)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`来源检查失败：${sanitizeError(error)}`);
  process.exitCode = 1;
});
