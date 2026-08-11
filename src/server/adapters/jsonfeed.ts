// JSON Feed 1.x
import { parseDate } from "../lib/time";
import { safeFetch } from "../lib/ssrf";
import type { AdapterContext, AdapterResult, FetchedItem } from "./types";

export function parseJsonFeed(body: string, assumeOffsetMin = 0): FetchedItem[] {
  let doc: Record<string, any>;
  try {
    doc = JSON.parse(body);
  } catch {
    return [];
  }
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const out: FetchedItem[] = [];
  for (const it of items) {
    const url = String(it.url || it.external_url || "");
    const title = String(it.title || "").trim() || String(it.content_text || "").slice(0, 80);
    if (!url || !title) continue;
    out.push({
      url,
      guid: it.id ? String(it.id) : null,
      title,
      summaryHtml: it.summary ? String(it.summary) : null,
      contentHtml: it.content_html ? String(it.content_html) : it.content_text ? String(it.content_text) : null,
      author: it.authors?.[0]?.name || it.author?.name || null,
      publishedAt: parseDate(it.date_published, assumeOffsetMin),
      updatedAt: parseDate(it.date_modified, assumeOffsetMin),
      imageUrl: it.image ? String(it.image) : null,
    });
  }
  return out;
}

export async function fetchJsonFeed(feedUrl: string, ctx: AdapterContext): Promise<AdapterResult> {
  const res = await safeFetch(feedUrl, { ...ctx.fetchOpts, accept: "application/feed+json, application/json" });
  if (!res.ok) return { items: [], httpStatus: res.status, error: res.error || `HTTP ${res.status}` };
  return { items: parseJsonFeed(res.body, ctx.assumeOffsetMin), httpStatus: res.status };
}
