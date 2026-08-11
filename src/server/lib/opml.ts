// OPML 导入导出（来源中心用）
import { XMLParser } from "fast-xml-parser";

export interface OpmlEntry {
  title: string;
  xmlUrl: string;
  htmlUrl: string | null;
}

export function parseOpml(xml: string): OpmlEntry[] {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const out: OpmlEntry[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const arr = Array.isArray(node) ? node : [node];
    for (const item of arr) {
      const o = item as Record<string, unknown>;
      const xmlUrl = (o["@_xmlUrl"] || o["@_xmlurl"]) as string | undefined;
      if (xmlUrl) {
        out.push({
          title: String(o["@_title"] || o["@_text"] || xmlUrl),
          xmlUrl: String(xmlUrl),
          htmlUrl: o["@_htmlUrl"] ? String(o["@_htmlUrl"]) : null,
        });
      }
      if (o.outline) walk(o.outline);
    }
  };
  const root = (doc as Record<string, any>)?.opml?.body?.outline;
  walk(root);
  return out;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function buildOpml(entries: OpmlEntry[], title = "News Radar 来源导出"): string {
  const items = entries
    .map(
      (e) =>
        `    <outline type="rss" text="${esc(e.title)}" title="${esc(e.title)}" xmlUrl="${esc(e.xmlUrl)}"${
          e.htmlUrl ? ` htmlUrl="${esc(e.htmlUrl)}"` : ""
        }/>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0">\n  <head><title>${esc(title)}</title></head>\n  <body>\n${items}\n  </body>\n</opml>\n`;
}
