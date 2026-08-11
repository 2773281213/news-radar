// 付费墙策略：只保存合法公开的元数据与摘要，绝不绕过付费墙/登录/反爬
// 找到同一事件的免费来源（官方原文、通讯社、其他媒体）是正确路径

const PAYWALL_DOMAINS = [
  "ft.com", "wsj.com", "economist.com", "bloomberg.com", "nytimes.com",
  "washingtonpost.com", "caixin.com", "theinformation.com", "barrons.com",
  "telegraph.co.uk", "lemonde.fr", "haaretz.com", "nikkei.com",
];

export function isPaywalledDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PAYWALL_DOMAINS.some((d) => host === d || host.endsWith("." + d));
  } catch {
    return false;
  }
}

/** 付费来源条目的处理说明（展示在文章与事件页） */
export const PAYWALL_NOTE =
  "该来源设有付费墙。本系统仅保存其合法公开的标题与摘要，正文请通过原始链接自行订阅阅读；系统会继续寻找同一事件的官方原文与免费来源作为替代证据。";
