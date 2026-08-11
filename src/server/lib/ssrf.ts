// SSRF 防护：协议白名单、内网地址拦截、DNS 解析校验、受控重定向、响应体限长
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home", ".corp", ".intranet"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal", "instance-data", "0.0.0.0"]);
type LookupAllFn = (
  hostname: string,
  options: { all: true; verbatim: true }
) => Promise<Array<{ address: string; family: number }>>;

/** 判断 IPv4 是否为私有/保留地址 */
export function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local / 云元数据
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true; // 基准测试段（常见 fake-ip）
  if (a >= 224) return true; // 组播与保留
  return false;
}

/** 判断 IPv6 是否为私有/保留地址 */
export function isPrivateIpv6(ip: string): boolean {
  const low = ip.toLowerCase();
  if (low === "::" || low === "::1") return true;
  if (low.startsWith("fe8") || low.startsWith("fe9") || low.startsWith("fea") || low.startsWith("feb")) return true; // 链路本地
  if (low.startsWith("fc") || low.startsWith("fd")) return true; // ULA
  if (low.startsWith("::ffff:")) {
    const v4 = low.slice(7);
    if (isIP(v4) === 4) return isPrivateIpv4(v4);
    return true;
  }
  return false;
}

export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true;
}

export interface UrlValidation {
  ok: boolean;
  reason?: string;
}

/** 静态校验：协议、凭据、主机名黑名单、IP 直连、端口 */
export function validatePublicUrl(input: string): UrlValidation {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "URL 无法解析" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, reason: `不允许的协议 ${u.protocol}` };
  }
  if (u.username || u.password) return { ok: false, reason: "URL 不得携带凭据" };
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host)) return { ok: false, reason: "禁止访问的主机名" };
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: "禁止访问内网域名" };
  }
  if (isIP(host)) {
    if (isPrivateIp(host)) return { ok: false, reason: "禁止访问内网/保留 IP" };
  }
  if (u.port && !["80", "443", "8080", "8443"].includes(u.port)) {
    return { ok: false, reason: `不允许的端口 ${u.port}` };
  }
  return { ok: true };
}

/** DNS 解析校验：所有解析结果都必须是公网地址 */
export async function validateResolvedHost(
  hostname: string,
  allowFakeIpDns = false,
  timeoutMs = 5_000,
  lookupFn: LookupAllFn = lookup as LookupAllFn
): Promise<UrlValidation> {
  const host = hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return isPrivateIp(host) ? { ok: false, reason: "内网 IP" } : { ok: true };
  try {
    const addrs = await withTimeout(
      lookupFn(host, { all: true, verbatim: true }),
      timeoutMs,
      "DNS 解析超时"
    );
    if (addrs.length === 0) return { ok: false, reason: "域名无解析结果" };
    for (const a of addrs) {
      if (isPrivateIp(a.address)) {
        const fakeIp = a.family === 4 && /^198\.(18|19)\./.test(a.address);
        if (!(allowFakeIpDns && fakeIp)) return { ok: false, reason: `域名解析到内网地址 ${a.address}` };
      }
    }
    return { ok: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return { ok: false, reason: message === "DNS 解析超时" ? message : "DNS 解析失败" };
  }
}

export interface SafeFetchOptions {
  userAgent?: string;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  accept?: string;
  fetchFn?: typeof fetch;
  /** 测试环境跳过 DNS 校验 */
  skipDnsCheck?: boolean;
  /** 仅允许“域名解析结果”为透明代理 fake-ip 段；直接访问该 IP 仍被拦截 */
  allowFakeIpDns?: boolean;
}

export interface SafeFetchResult {
  ok: boolean;
  status: number;
  url: string;
  body: string;
  contentType: string;
  error?: string;
}

/** 安全抓取：手动跟随重定向且每跳复检，响应体限长 */
export async function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const {
    userAgent = "NewsRadarBot/1.0",
    timeoutMs = 20000,
    maxBytes = 3 * 1024 * 1024,
    maxRedirects = 5,
    accept = "application/rss+xml, application/atom+xml, application/xml, text/xml, application/json, text/html;q=0.8, */*;q=0.5",
    fetchFn = fetch,
    skipDnsCheck = false,
    allowFakeIpDns = false,
  } = opts;

  let current = url;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const staticCheck = validatePublicUrl(current);
    if (!staticCheck.ok) {
      return { ok: false, status: 0, url: current, body: "", contentType: "", error: `SSRF拦截: ${staticCheck.reason}` };
    }
    if (!skipDnsCheck) {
      // DNS 发生瞬时故障时，系统解析器可能长时间不返回；解析阶段必须有独立期限，
      // 否则一个来源就能永久占住采集 worker，并阻塞后续调度 tick。
      const dnsCheck = await validateResolvedHost(
        new URL(current).hostname,
        allowFakeIpDns,
        Math.min(timeoutMs, 5_000)
      );
      if (!dnsCheck.ok) {
        return { ok: false, status: 0, url: current, body: "", contentType: "", error: `SSRF拦截: ${dnsCheck.reason}` };
      }
    }
    let res: Response;
    try {
      res = await fetchFn(current, {
        redirect: "manual",
        headers: { "user-agent": userAgent, accept },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      return { ok: false, status: 0, url: current, body: "", contentType: "", error: String((e as Error).message || e) };
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      try {
        res.body?.cancel();
      } catch {
        /* 忽略 */
      }
      if (!loc) return { ok: false, status: res.status, url: current, body: "", contentType: "", error: "重定向缺少 Location" };
      current = new URL(loc, current).toString();
      continue;
    }

    const contentType = res.headers.get("content-type") || "";
    let body = "";
    try {
      body = await readLimited(res, maxBytes);
    } catch (e) {
      return { ok: false, status: res.status, url: current, body: "", contentType, error: String((e as Error).message || e) };
    }
    return { ok: res.status >= 200 && res.status < 300, status: res.status, url: current, body, contentType };
  }
  return { ok: false, status: 0, url: current, body: "", contentType: "", error: "重定向次数过多" };
}

async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      break; // 截断而非报错：feed 超长时保留已读部分
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total > maxBytes ? maxBytes : total);
  let off = 0;
  for (const c of chunks) {
    const slice = c.subarray(0, Math.min(c.byteLength, buf.byteLength - off));
    buf.set(slice, off);
    off += slice.byteLength;
    if (off >= buf.byteLength) break;
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
