import type { Hono } from "hono";

/** 注册统一错误响应；服务端日志不输出请求头、Cookie 或请求体，避免泄露密钥 */
export function installErrorHandlers(app: Hono): void {
  app.notFound((c) => c.json({ error: "接口不存在" }, 404));
  app.onError((error, c) => {
    const requestId = c.get("requestId" as never) || "unknown";
    console.error(`[${requestId}] ${c.req.method} ${c.req.path}:`, safeError(error));
    return c.json({ error: "服务器内部错误", requestId }, 500);
  });
}

function safeError(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  // 常见密钥格式和 Bearer 令牌脱敏；日志只保留前 2000 字符
  return raw
    .replace(/(bearer\s+)[a-z0-9._~+\/-]+/gi, "$1[REDACTED]")
    .replace(/(sk-[a-z0-9_-]{8})[a-z0-9_-]+/gi, "$1…[REDACTED]")
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET)[A-Z0-9_]*=)[^\s]+/gi, "$1[REDACTED]")
    .slice(0, 2000);
}
