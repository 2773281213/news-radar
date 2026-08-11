import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { serveStatic } from "@hono/node-server/serve-static";
import type { ServiceContainer } from "./container";
import { installErrorHandlers } from "./middleware/errors";
import { requestId } from "./middleware/request-id";
import { bodySizeLimit, rateLimit, securityHeaders } from "./middleware/security";
import { registerAdminRoutes } from "./routes/admin";
import { registerPublicRoutes } from "./routes/public";

export interface AppOptions {
  clientRoot?: string;
}

/** 创建 Hono 应用；服务容器由外部注入，API 测试可使用内存数据库 */
export function createApp(services: ServiceContainer, options: AppOptions = {}): Hono {
  const app = new Hono();
  app.use("*", requestId());
  app.use("*", securityHeaders(services.config));
  app.use("*", compress());
  app.use("/api/*", bodySizeLimit(256 * 1024));
  app.use("/api/*", rateLimit({ windowMs: 60_000, max: 180, keyPrefix: "api" }));

  app.get("/api", (c) =>
    c.json({
      name: "News Radar API",
      version: services.config.version,
      ready: "/api/ready",
      health: "/api/health",
      cutoff: new Date().toISOString(),
    })
  );
  registerPublicRoutes(app, services);
  registerAdminRoutes(app, services);

  const clientRoot = options.clientRoot ?? resolve(process.cwd(), "dist", "client");
  const clientIndex = resolve(clientRoot, "index.html");
  if (existsSync(clientIndex)) {
    const indexHtml = readFileSync(clientIndex, "utf-8");
    app.use("/*", serveStatic({ root: clientRoot }));
    // SPA history fallback；直接返回已读取的入口文件，避免 Linux 下绝对路径被二次拼接
    app.get("*", async (c, next) => {
      if (c.req.path.startsWith("/api/") || c.req.path === "/api") return next();
      const accept = c.req.header("accept") || "";
      if (!accept.includes("text/html")) return next();
      return c.html(indexHtml);
    });
  }

  installErrorHandlers(app);
  return app;
}
