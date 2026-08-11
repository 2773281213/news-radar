// URL 规范化：跟踪参数剥离、参数排序、大小写与端口归一，用于去重键

const TRACKING_PARAMS = new Set([
  "fbclid", "gclid", "dclid", "msclkid", "twclid", "igshid", "mc_cid", "mc_eid",
  "ref", "referer", "referrer", "source", "src", "from", "spm", "scm", "ncid",
  "cmpid", "campaign", "ito", "smid", "sref", "share_token", "share_source",
  "wt_mc", "wt_zmc", "at_medium", "at_campaign", "at_custom1", "at_custom2",
  "at_custom3", "at_custom4", "cid", "s", "taid", "traffic_source", "xtor",
  "guccounter", "guce_referrer", "guce_referrer_sig", "_hsenc", "_hsmi",
  "vero_id", "yclid", "rss", "partner", "feedType", "feedName", "sh",
]);

function isTrackingParam(key: string): boolean {
  const k = key.toLowerCase();
  return k.startsWith("utm_") || k.startsWith("pk_") || k.startsWith("mtm_") || TRACKING_PARAMS.has(k);
}

/** 规范化 URL；解析失败时返回原串裁剪 */
export function normalizeUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return input.trim().slice(0, 500);
  }
  u.protocol = u.protocol.toLowerCase();
  u.hostname = u.hostname.toLowerCase();
  u.hash = "";
  u.username = "";
  u.password = "";
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = "";
  }
  const kept: [string, string][] = [];
  for (const [k, v] of u.searchParams.entries()) {
    if (!isTrackingParam(k)) kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  u.search = "";
  for (const [k, v] of kept) u.searchParams.append(k, v);
  let s = u.toString();
  // 去掉纯目录型末尾斜杠（根路径除外）
  if (s.endsWith("/") && u.pathname !== "/" && !u.search) s = s.slice(0, -1);
  return s;
}

/** 提取主机名（小写，无端口） */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** 去掉 www. 前缀的可注册域近似值（用于家族比对） */
export function baseDomain(url: string): string {
  const h = domainOf(url);
  return h.replace(/^www\./, "");
}
