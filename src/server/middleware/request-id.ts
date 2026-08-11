import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";

/** 请求关联 ID：接受 nginx 生成的合法 ID，否则本地生成；不信任任意长用户输入 */
export function requestId(): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header("x-request-id") || "";
    const id = /^[a-zA-Z0-9_-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    c.set("requestId" as never, id as never);
    c.header("X-Request-Id", id);
    await next();
  };
}
