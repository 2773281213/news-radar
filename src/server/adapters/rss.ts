// RSS 2.0 / Atom / RDF(RSS 1.0) 解析
import { XMLParser } from "fast-xml-parser";
import { parseDate } from "../lib/time";
import type { AdapterContext, AdapterResult, FetchedItem } from "./types";
import { safeFetch } from "../lib/ssrf";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "__cdata",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  isArray: (name) => ["item", "entry", "link", "category", "enclosure"].includes(name),
});

/** 解包文本节点（兼容 CDATA / 属性对象 / 数组） */
function val(x: unknown): string {
  if (x === null || x === undefined) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number") return String(x);
  if (Array.isArray(x)) return val(x[0]);
  if (typeof x === "object") {
    const o = x as Record<string, unknown>;
    return val(o.__cdata ?? o["#text"] ?? "");
  }
  return "";
}

/** Atom link 数组取正文链接 */
function atomLink(links: unknown): string {
  const arr = Array.isArray(links) ? links : [links];
  let fallback = "";
  for (const l of arr) {
    if (!l) continue;
    if (typeof l === "string") return l;
    const o = l as Record<string, unknown>;
    const href = String(o["@_href"] || "");
    if (!href) continue;
    const rel = String(o["@_rel"] || "");
    if (rel === "alternate" || rel === "") return href;
    if (!fallback) fallback = href;
  }
  return fallback;
}

function imageOf(item: Record<string, unknown>): string | null {
  const enc = item.enclosure;
  const encArr = Array.isArray(enc) ? enc : enc ? [enc] : [];
  for (const e of encArr) {
    const o = e as Record<string, unknown>;
    const type = String(o["@_type"] || "");
    const u = String(o["@_url"] || "");
    if (u && (type.startsWith("image/") || /\.(jpe?g|png|webp|gif)(\?|$)/i.test(u))) return u;
  }
  const media = (item["media:content"] || item["media:thumbnail"]) as Record<string, unknown> | Record<string, unknown>[] | undefined;
  const m = Array.isArray(media) ? media[0] : media;
  if (m && typeof m === "object") {
    const u = String((m as Record<string, unknown>)["@_url"] || "");
    if (u) return u;
  }
  return null;
}

/** 解析 XML 文本为条目（供测试直接调用） */
export function parseFeedXml(xml: string, assumeOffsetMin = 0): FetchedItem[] {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const out: FetchedItem[] = [];

  // RSS 2.0
  const rssItems = doc?.rss?.channel?.item;
  // RDF / RSS 1.0（item 与 channel 平级）
  const rdfItems = doc?.["rdf:RDF"]?.item;
  // Atom
  const atomEntries = doc?.feed?.entry;

  if (rssItems) {
    for (const it of rssItems as Record<string, unknown>[]) {
      const title = val(it.title);
      const link = val(it.link) || atomLink(it["atom:link"]);
      if (!title || !link) continue;
      const guidRaw = it.guid;
      out.push({
        url: link.trim(),
        guid: val(guidRaw) || null,
        title,
        summaryHtml: val(it.description) || null,
        contentHtml: val(it["content:encoded"]) || null,
        author: val(it["dc:creator"] || it.author) || null,
        publishedAt: parseDate(val(it.pubDate) || val(it["dc:date"]), assumeOffsetMin),
        imageUrl: imageOf(it),
      });
    }
  } else if (rdfItems) {
    for (const it of rdfItems as Record<string, unknown>[]) {
      const title = val(it.title);
      const link = val(it.link);
      if (!title || !link) continue;
      out.push({
        url: link.trim(),
        guid: String((it as Record<string, unknown>)["@_rdf:about"] || "") || null,
        title,
        summaryHtml: val(it.description) || null,
        contentHtml: null,
        author: val(it["dc:creator"]) || null,
        publishedAt: parseDate(val(it["dc:date"]) || val(it.pubDate), assumeOffsetMin),
        imageUrl: null,
      });
    }
  } else if (atomEntries) {
    for (const it of atomEntries as Record<string, unknown>[]) {
      const title = val(it.title);
      const link = atomLink(it.link);
      if (!title || !link) continue;
      out.push({
        url: link.trim(),
        guid: val(it.id) || null,
        title,
        summaryHtml: val(it.summary) || null,
        contentHtml: val(it.content) || null,
        author: val((it.author as Record<string, unknown>)?.name) || null,
        publishedAt: parseDate(val(it.published) || val(it.updated), assumeOffsetMin),
        updatedAt: parseDate(val(it.updated), assumeOffsetMin),
        imageUrl: null,
      });
    }
  }
  return out;
}

export async function fetchRss(feedUrl: string, ctx: AdapterContext): Promise<AdapterResult> {
  const res = await safeFetch(feedUrl, ctx.fetchOpts);
  if (!res.ok) return { items: [], httpStatus: res.status, error: res.error || `HTTP ${res.status}` };
  const items = parseFeedXml(res.body, ctx.assumeOffsetMin);
  if (items.length === 0 && !/<(rss|feed|rdf)/i.test(res.body.slice(0, 2000))) {
    return { items: [], httpStatus: res.status, error: "响应不是有效的 RSS/Atom" };
  }
  return { items, httpStatus: res.status };
}
