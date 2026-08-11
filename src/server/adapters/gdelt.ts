// GDELT DOC 2.0 API：免费公开的全球新闻索引，用于多语言主动搜索扩展
import { safeFetch } from "../lib/ssrf";
import type { AdapterContext, AdapterResult, FetchedItem } from "./types";

const LANG_MAP: Record<string, string> = {
  english: "en", chinese: "zh", arabic: "ar", farsi: "fa", persian: "fa",
  hebrew: "he", russian: "ru", french: "fr", german: "de", spanish: "es",
  japanese: "ja", korean: "ko", turkish: "tr", ukrainian: "uk",
};

/** seendate 形如 20260727T031500Z */
function parseSeenDate(s: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s || "");
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

export function parseGdeltArtList(body: string): FetchedItem[] {
  let doc: Record<string, any>;
  try {
    doc = JSON.parse(body);
  } catch {
    return [];
  }
  const arts = Array.isArray(doc?.articles) ? doc.articles : [];
  const out: FetchedItem[] = [];
  for (const a of arts) {
    const url = String(a.url || "");
    const title = String(a.title || "").trim();
    if (!url || !title) continue;
    out.push({
      url,
      guid: url,
      title,
      summaryHtml: null,
      contentHtml: null,
      publishedAt: parseSeenDate(String(a.seendate || "")),
      imageUrl: a.socialimage ? String(a.socialimage) : null,
      lang: LANG_MAP[String(a.language || "").toLowerCase()] || null,
      extra: { domain: a.domain, sourceCountry: a.sourcecountry, via: "gdelt" },
    });
  }
  return out;
}

/** 按查询词搜索 GDELT（timespan 如 1d/6h） */
export async function searchGdelt(
  query: string,
  ctx: AdapterContext,
  timespan = "1d",
  maxRecords = 40
): Promise<AdapterResult> {
  const u = new URL("https://api.gdeltproject.org/api/v2/doc/doc");
  u.searchParams.set("query", query);
  u.searchParams.set("mode", "ArtList");
  u.searchParams.set("maxrecords", String(maxRecords));
  u.searchParams.set("format", "json");
  u.searchParams.set("timespan", timespan);
  const res = await safeFetch(u.toString(), { ...ctx.fetchOpts, accept: "application/json" });
  if (!res.ok) return { items: [], httpStatus: res.status, error: res.error || `HTTP ${res.status}` };
  return { items: parseGdeltArtList(res.body), httpStatus: res.status };
}

/** 作为常规来源时（config.query 必填）拉取该查询的最新报道 */
export async function fetchGdeltSource(config: Record<string, string> | null, ctx: AdapterContext): Promise<AdapterResult> {
  const query = config?.query;
  if (!query) return { items: [], httpStatus: 0, error: "GDELT 来源缺少 config.query" };
  return searchGdelt(query, ctx, config?.timespan || "1d");
}
