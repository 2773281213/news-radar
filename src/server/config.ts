import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** 运行配置（全部来自环境变量 / .env 文件） */
export interface Config {
  host: string;
  port: number;
  dataDir: string;
  publicBaseUrl: string;
  defaultTz: string;
  adminToken: string;
  rsshubBase: string;
  fetchConcurrency: number;
  userAgent: string;
  /** 本地透明代理使用 198.18.0.0/15 fake-ip DNS 时显式开启；生产默认关闭 */
  allowProxyFakeIp: boolean;
  aiProvider: "none" | "anthropic" | "openai" | "ollama";
  aiDailyBudget: number;
  anthropicApiKey: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  openaiModel: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  telegramBotToken: string;
  telegramChatId: string;
  resendApiKey: string;
  alertEmailFrom: string;
  alertEmailTo: string;
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
  workflowBatchSize: number;
  workflowLeaseSec: number;
  workflowMaxAttempts: number;
  version: string;
}

/** 轻量 .env 解析（避免额外依赖）；不覆盖已有环境变量 */
export function loadDotenv(path = ".env"): void {
  const p = resolve(process.cwd(), path);
  if (!existsSync(p)) return;
  for (const raw of readFileSync(p, "utf-8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const num = (v: string | undefined, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const bounded = (v: string | undefined, d: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Math.round(num(v, d))));
  const provider = (env.AI_PROVIDER || "none").toLowerCase();
  return {
    host: env.HOST || "127.0.0.1",
    port: num(env.PORT, 8787),
    dataDir: env.DATA_DIR || "./data",
    publicBaseUrl: (env.PUBLIC_BASE_URL || "http://127.0.0.1:8787").replace(/\/$/, ""),
    defaultTz: env.DEFAULT_TZ || "Asia/Shanghai",
    adminToken: env.ADMIN_TOKEN || "",
    rsshubBase: (env.RSSHUB_BASE || "https://rsshub.app").replace(/\/$/, ""),
    fetchConcurrency: num(env.FETCH_CONCURRENCY, 4),
    userAgent: env.USER_AGENT || "NewsRadarBot/1.0",
    allowProxyFakeIp: env.ALLOW_PROXY_FAKE_IP === "1" || env.ALLOW_PROXY_FAKE_IP === "true",
    aiProvider: (["anthropic", "openai", "ollama"].includes(provider) ? provider : "none") as Config["aiProvider"],
    aiDailyBudget: num(env.AI_DAILY_BUDGET, 200),
    anthropicApiKey: env.ANTHROPIC_API_KEY || "",
    anthropicBaseUrl: (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/$/, ""),
    anthropicModel: env.ANTHROPIC_MODEL || "claude-opus-5",
    openaiBaseUrl: (env.OPENAI_BASE_URL || "").replace(/\/$/, ""),
    openaiApiKey: env.OPENAI_API_KEY || "",
    openaiModel: env.OPENAI_MODEL || "",
    ollamaBaseUrl: (env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, ""),
    ollamaModel: env.OLLAMA_MODEL || "",
    telegramBotToken: env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: env.TELEGRAM_CHAT_ID || "",
    resendApiKey: env.RESEND_API_KEY || "",
    alertEmailFrom: env.ALERT_EMAIL_FROM || "",
    alertEmailTo: env.ALERT_EMAIL_TO || "",
    vapidPublicKey: env.VAPID_PUBLIC_KEY || "",
    vapidPrivateKey: env.VAPID_PRIVATE_KEY || "",
    vapidSubject: env.VAPID_SUBJECT || "mailto:admin@example.com",
    workflowBatchSize: bounded(env.WORKFLOW_BATCH_SIZE, 30, 1, 200),
    workflowLeaseSec: bounded(env.WORKFLOW_LEASE_SEC, 300, 30, 3600),
    workflowMaxAttempts: bounded(env.WORKFLOW_MAX_ATTEMPTS, 5, 1, 20),
    version: "0.2.0",
  };
}
