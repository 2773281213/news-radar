// Telegram 公开频道预览页（t.me/s/<channel>）解析
// 仅访问 Telegram 官方公开提供的网页预览，不使用任何登录态
import { parseDate } from "../lib/time";
import { safeFetch } from "../lib/ssrf";
import type { AdapterContext, AdapterResult, FetchedItem } from "./types";

export function parseTelegramPreview(html: string, channel: string): FetchedItem[] {
  const items: FetchedItem[] = [];
  // 每条消息块以 data-post="channel/123" 标识
  const blocks = html.split(/class="tgme_widget_message\b/).slice(1);
  for (const block of blocks.slice(0, 40)) {
    const postM = /data-post="([^"]+)"/.exec(block);
    if (!postM) continue;
    const post = postM[1]; // channel/123
    const id = post.split("/")[1];
    if (!id) continue;

    const textM = /class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(block);
    const timeM = /<time[^>]+datetime="([^"]+)"/.exec(block);
    const photoM = /class="tgme_widget_message_photo_wrap[^"]*"[^>]*style="[^"]*background-image:url\('([^']+)'\)/.exec(block);
    const html_ = textM ? textM[1] : "";
    if (!html_ && !photoM) continue;

    items.push({
      url: `https://t.me/${channel}/${id}`,
      guid: post,
      title: "",
      summaryHtml: html_ || null,
      contentHtml: html_ || null,
      publishedAt: timeM ? parseDate(timeM[1]) : null,
      imageUrl: photoM ? photoM[1] : null,
      extra: { platform: "telegram", channel, postId: id },
    });
  }
  return items;
}

export async function fetchTelegramWeb(config: Record<string, string> | null, ctx: AdapterContext): Promise<AdapterResult> {
  const channel = config?.channel;
  if (!channel) return { items: [], httpStatus: 0, error: "Telegram 来源需要 config.channel" };
  const res = await safeFetch(`https://t.me/s/${encodeURIComponent(channel)}`, {
    ...ctx.fetchOpts,
    accept: "text/html",
  });
  if (!res.ok) return { items: [], httpStatus: res.status, error: res.error || `HTTP ${res.status}` };
  if (!res.body.includes("tgme_widget_message")) {
    return { items: [], httpStatus: res.status, error: "频道无公开预览或不存在" };
  }
  return { items: parseTelegramPreview(res.body, channel), httpStatus: res.status };
}
