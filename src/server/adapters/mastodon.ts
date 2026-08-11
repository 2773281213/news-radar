// Mastodon 公开 API：官方机构联邦宇宙账号（如欧盟委员会自建实例）
// 身份验证依据：账号所在实例域名即机构官方域名
import { safeFetch } from "../lib/ssrf";
import type { AdapterContext, AdapterResult, FetchedItem } from "./types";

export async function fetchMastodon(config: Record<string, string> | null, ctx: AdapterContext): Promise<AdapterResult> {
  const instance = config?.instance?.replace(/\/$/, "");
  const acct = config?.acct;
  if (!instance || !acct) return { items: [], httpStatus: 0, error: "Mastodon 来源需要 config.instance 与 config.acct" };

  // 账号 ID 缓存 24h
  const cacheKey = `mastodon:id:${instance}:${acct}`;
  let accountId = await ctx.kv.get(cacheKey);
  if (!accountId) {
    const look = await safeFetch(`${instance}/api/v1/accounts/lookup?acct=${encodeURIComponent(acct)}`, {
      ...ctx.fetchOpts,
      accept: "application/json",
    });
    if (!look.ok) return { items: [], httpStatus: look.status, error: look.error || `账号查找失败 HTTP ${look.status}` };
    try {
      accountId = String(JSON.parse(look.body).id || "");
    } catch {
      accountId = "";
    }
    if (!accountId) return { items: [], httpStatus: look.status, error: "账号不存在" };
    await ctx.kv.set(cacheKey, accountId, 24 * 3600);
  }

  const res = await safeFetch(
    `${instance}/api/v1/accounts/${accountId}/statuses?limit=20&exclude_replies=true&exclude_reblogs=true`,
    { ...ctx.fetchOpts, accept: "application/json" }
  );
  if (!res.ok) return { items: [], httpStatus: res.status, error: res.error || `HTTP ${res.status}` };

  let statuses: Record<string, any>[] = [];
  try {
    statuses = JSON.parse(res.body);
  } catch {
    return { items: [], httpStatus: res.status, error: "响应不是有效 JSON" };
  }
  const items: FetchedItem[] = [];
  for (const s of statuses) {
    const url = String(s.url || s.uri || "");
    const html = String(s.content || "");
    if (!url || !html) continue;
    items.push({
      url,
      guid: String(s.id || url),
      title: "", // 社交帖子无标题，入库时取正文首行
      summaryHtml: html,
      contentHtml: html,
      author: s.account?.acct ? `@${s.account.acct}@${new URL(instance).hostname}` : null,
      publishedAt: s.created_at ? new Date(s.created_at).toISOString() : null,
      imageUrl: s.media_attachments?.[0]?.preview_url || null,
      extra: { platform: "mastodon", accountId: s.account?.id, acct: s.account?.acct },
    });
  }
  return { items, httpStatus: res.status };
}
