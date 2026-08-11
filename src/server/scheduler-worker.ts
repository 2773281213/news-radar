import { loadConfig, loadDotenv } from "./config";
import { createContainer } from "./container";

loadDotenv();
const config = loadConfig();
const services = createContainer(config);

services.scheduler.start(30_000);
console.log(`新闻雷达调度进程已启动：采集并执行三省六部审议（PID ${process.pid}）`);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`调度进程收到 ${signal}，正在停止新任务…`);
  try {
    await services.scheduler.stopAndPersist();
  } finally {
    services.close();
    process.exit(0);
  }
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("uncaughtException", (error) => {
  console.error("调度进程未捕获异常：", error instanceof Error ? error.message : error);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  console.error("调度进程未处理 Promise 拒绝：", error instanceof Error ? error.message : error);
  process.exit(1);
});
