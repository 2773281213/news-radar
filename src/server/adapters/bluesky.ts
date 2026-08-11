// Bluesky 公开 API：域名即句柄（如 theguardian.com），身份可由域名反向确认
import { safeFetch } from "../lib/ssrf";
import type { AdapterContext, AdapterResult, FetchedItem } from "./types";

export async function fetchBluesky(config: Record<string, string> | null, ctx: AdapterContext): Promise<AdapterResult> {
  const actor = config?.actor;
  if (!actor) return { items: [], httpStatus: 0, error: "Bluesky 来源需要 config.actor" };

  const u = new URL("https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed");
  u.searchParams.set("actor", actor);
  u.searchParams.set("limit", "25");
  u.searchParams.set("filter", "posts_no_replies");
  const res = await safeFetch(u.toString(), { ...ctx.fetchOpts, accept: "application/json" });
  if (!res.ok) return { items: [], httpStatus: res.status, error: res.error || `HTTP ${res.status}` };

  let doc: Record<string, any>;
  try {
    doc = JSON.parse(res.body);
  } catch {
    return { items: [], httpStatus: res.status, error: "响应不是有效 JSON" };
  }
  const items: FetchedItem[] = [];
  for (const f of doc.feed || []) {
    const post = f?.post;
    if (!post?.record?.text) continue;
    // 跳过转发（reason=repost）
    if (f.reason) continue;
    const uri = String(post.uri || ""); // at://did/app.bsky.feed.post/rkey
    const rkey = uri.split("/").pop() || "";
    const handle = String(post.author?.handle || actor);
    if (!rkey) continue;
    items.push({
      url: `https://bsky.app/profile/${handle}/post/${rkey}`,
      guid: uri,
      title: "",
      summaryHtml: null,
      contentHtml: String(post.record.text),
      author: `@${handle}`,
      publishedAt: post.record.createdAt ? new Date(post.record.createdAt).toISOString() : null,
      imageUrl: post.embed?.images?.[0]?.thumb || null,
      extra: { platform: "bluesky", did: post.author?.did, cid: post.cid },
    });
  }
  return { items, httpStatus: res.status };
}
