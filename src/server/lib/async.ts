import { setImmediate as setImmediatePromise } from "node:timers/promises";

/**
 * 把控制权交还给事件循环，让健康检查和前台 API 能在批量计算之间及时响应。
 * better-sqlite3 与文本聚类是同步工作，不能只依赖 async 函数边界自动让出。
 */
export async function yieldToEventLoop(): Promise<void> {
  await setImmediatePromise();
}
