// robots.txt 尊重：采集前检查目标路径是否被允许（结果缓存 6 小时）
import type { KV } from "./kv";
import { safeFetch, type SafeFetchOptions } from "./ssrf";

export interface RobotsRule {
  allow: boolean;
  path: string;
}

/** 解析 robots.txt，提取适用于我们 UA（含 *）的规则 */
export function parseRobots(txt: string, botName = "newsradarbot"): RobotsRule[] {
  const rules: RobotsRule[] = [];
  let applies = false;
  let sawSpecific = false;
  const generic: RobotsRule[] = [];
  let inGeneric = false;

  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      const ua = value.toLowerCase();
      applies = ua === botName || botName.includes(ua.replace(/\*/g, ""));
      inGeneric = ua === "*";
      if (applies) sawSpecific = true;
      continue;
    }
    if (field === "allow" || field === "disallow") {
      const rule = { allow: field === "allow", path: value };
      if (applies) rules.push(rule);
      if (inGeneric) generic.push(rule);
    }
  }
  return sawSpecific && rules.length > 0 ? rules : generic;
}

/** 最长前缀匹配（空 Disallow 视为允许全部） */
export function isPathAllowed(rules: RobotsRule[], path: string): boolean {
  let best: RobotsRule | null = null;
  let bestLen = -1;
  for (const r of rules) {
    if (r.path === "") continue;
    const pattern = r.path.replace(/\*/g, "");
    if (path.startsWith(pattern) && pattern.length > bestLen) {
      best = r;
      bestLen = pattern.length;
    }
  }
  return best ? best.allow : true;
}

/** 抓取并缓存 robots.txt，判断 URL 是否可抓 */
export async function robotsAllowed(kv: KV, url: string, fetchOpts: SafeFetchOptions = {}): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const cacheKey = `robots:${u.origin}`;
  let cached = await kv.get(cacheKey);
  if (cached === null) {
    const res = await safeFetch(`${u.origin}/robots.txt`, { ...fetchOpts, maxBytes: 256 * 1024, accept: "text/plain" });
    // 无 robots 或抓取失败：默认允许（业界惯例），缓存空规则
    cached = res.ok ? res.body : "";
    await kv.set(cacheKey, cached, 6 * 3600);
  }
  if (!cached) return true;
  return isPathAllowed(parseRobots(cached), u.pathname);
}
