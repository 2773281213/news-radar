import { serve } from "@hono/node-server";
import { loadConfig, loadDotenv } from "./config";
import { createContainer } from "./container";
import { createApp } from "./app";

loadDotenv();
const config = loadConfig();
const schedulerDisabled = process.env.DISABLE_SCHEDULER === "1" || process.env.NODE_ENV === "test";
const services = createContainer(config, { syncSourceRegistry: !schedulerDisabled });
const app = createApp(services);

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    console.log(`新闻雷达已启动：http://${info.address}:${info.port}`);
    console.log(`公开地址：${config.publicBaseUrl}`);
    console.log(`AI：${services.reporting.provider.name}/${services.reporting.provider.model}（${services.reporting.provider.enabled ? "已启用" : "抽取式降级"}）`);
  }
);

if (!schedulerDisabled) {
  services.scheduler.start();
}

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`收到 ${signal}，正在停止新闻雷达…`);
  services.scheduler.stop();
  server.close(() => {
    services.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("未捕获异常：", error instanceof Error ? error.message : error);
});
process.on("unhandledRejection", (error) => {
  console.error("未处理 Promise 拒绝：", error instanceof Error ? error.message : error);
});
