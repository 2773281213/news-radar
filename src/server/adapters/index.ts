// 适配器调度：按来源类型分发，统一 robots 检查与 RSSHub 模板展开
import type { sources } from "../db/schema";
import type { KV } from "../lib/kv";
import { robotsAllowed } from "../lib/robots";
import type { SafeFetchOptions } from "../lib/ssrf";
import { fetchBluesky } from "./bluesky";
import { fetchGdeltSource } from "./gdelt";
import { fetchJsonFeed } from "./jsonfeed";
import { fetchMastodon } from "./mastodon";
import { fetchRss } from "./rss";
import { fetchTelegramWeb } from "./telegramweb";
import type { AdapterContext, AdapterResult } from "./types";

type SourceRow = typeof sources.$inferSelect;

/** 中国大陆/港台来源无时区时间默认按东八区 */
function offsetForCountry(country: string | null): number {
  if (!country) return 0;
  if (["cn", "hk", "tw", "sg"].includes(country)) return 480;
  if (country === "jp" || country === "kr") return 540;
  if (country === "ir") return 210; // 德黑兰 +3:30
  return 0;
}

export function expandFeedUrl(feedUrl: string, rsshubBase: string): string {
  return feedUrl.replace("{RSSHUB}", rsshubBase);
}

export async function runAdapter(
  source: SourceRow,
  kv: KV,
  fetchOpts: SafeFetchOptions,
  rsshubBase: string
): Promise<AdapterResult> {
  const ctx: AdapterContext = {
    kv,
    fetchOpts,
    rsshubBase,
    assumeOffsetMin: offsetForCountry(source.country),
  };

  switch (source.adapter) {
    case "rss":
    case "jsonfeed": {
      if (!source.feedUrl) return { items: [], httpStatus: 0, error: "缺少 feedUrl" };
      const url = expandFeedUrl(source.feedUrl, rsshubBase);
      // 尊重 robots.txt（RSSHub 等聚合服务除外——其本身即为订阅服务）
      if (!url.startsWith(rsshubBase)) {
        const allowed = await robotsAllowed(kv, url, fetchOpts);
        if (!allowed) return { items: [], httpStatus: 0, error: "robots.txt 不允许抓取该路径" };
      }
      return source.adapter === "rss" ? fetchRss(url, ctx) : fetchJsonFeed(url, ctx);
    }
    case "gdelt":
      return fetchGdeltSource(source.config, ctx);
    case "mastodon":
      return fetchMastodon(source.config, ctx);
    case "bluesky":
      return fetchBluesky(source.config, ctx);
    case "telegramweb":
      return fetchTelegramWeb(source.config, ctx);
    default:
      return { items: [], httpStatus: 0, error: `未知适配器 ${source.adapter}` };
  }
}
