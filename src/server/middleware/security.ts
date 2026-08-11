import { createHash, timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { Config } from "../config";

/** 安全响应头：API 与静态页面统一生效 */
export function securityHeaders(config: Config): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    c.header("Cross-Origin-Opener-Policy", "same-origin");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("X-Permitted-Cross-Domain-Policies", "none");
    c.header(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "base-uri 'self'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "object-src 'none'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "font-src 'self' data:",
        "connect-src 'self'",
        "worker-src 'self'",
        "manifest-src 'self'",
        config.publicBaseUrl.startsWith("https://") ? "upgrade-insecure-requests" : "",
      ]
        .filter(Boolean)
        .join("; ")
    );
    if (config.publicBaseUrl.startsWith("https://")) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    if (c.req.path.startsWith("/api/")) {
      c.header("Cache-Control", "no-store");
    }
  };
}

/** 管理接口鉴权；ADMIN_TOKEN 未配置时默认关闭，而不是错误地放行 */
export function adminAuth(config: Config): MiddlewareHandler {
  return async (c, next) => {
    if (!config.adminToken) {
      return c.json({ error: "管理接口尚未配置" }, 503);
    }
    const auth = c.req.header("authorization") || "";
    const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
    const supplied = bearer || c.req.header("x-admin-token") || "";
    if (!constantTimeEqual(supplied, config.adminToken)) {
      c.header("WWW-Authenticate", 'Bearer realm="News Radar Admin"');
      return c.json({ error: "未授权" }, 401);
    }
    await next();
  };
}

function constantTimeEqual(a: string, b: string): boolean {
  // 对两端先做定长哈希，避免令牌长度泄漏和 timingSafeEqual 长度异常
  const ah = createHash("sha256").update(a).digest();
  const bh = createHash("sha256").update(b).digest();
  return timingSafeEqual(ah, bh) && a.length > 0;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * 单进程固定窗口限流。生产只启动一个 Node 进程；若扩展为多实例，替换为 Redis/KV 实现。
 * Map 在每次请求时机会式清理，防止攻击者用随机 IP 造成内存无限增长。
 */
export function rateLimit(options: { windowMs?: number; max?: number; keyPrefix?: string } = {}): MiddlewareHandler {
  const windowMs = options.windowMs ?? 60_000;
  const max = options.max ?? 120;
  const prefix = options.keyPrefix || "global";
  const buckets = new Map<string, Bucket>();
  let nextCleanup = Date.now() + windowMs;

  return async (c, next) => {
    const now = Date.now();
    if (now >= nextCleanup) {
      for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
      nextCleanup = now + windowMs;
    }
    const ip = clientIp(c.req.raw.headers);
    const key = `${prefix}:${ip}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count++;
    const remaining = Math.max(0, max - bucket.count);
    c.header("RateLimit-Limit", String(max));
    c.header("RateLimit-Remaining", String(remaining));
    c.header("RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
    if (bucket.count > max) {
      const retry = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      c.header("Retry-After", String(retry));
      return c.json({ error: "请求过于频繁，请稍后再试" }, 429);
    }
    await next();
  };
}

function clientIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.slice(0, 64);
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  return (headers.get("x-real-ip") || "unknown").slice(0, 64);
}

/** JSON 请求体大小限制，阻止大包消耗内存 */
export function bodySizeLimit(maxBytes = 256 * 1024): MiddlewareHandler {
  return async (c, next) => {
    if (["POST", "PUT", "PATCH"].includes(c.req.method)) {
      const length = Number(c.req.header("content-length") || "0");
      if (length > maxBytes) return c.json({ error: "请求体过大" }, 413);
    }
    await next();
  };
}
