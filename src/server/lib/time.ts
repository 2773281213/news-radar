// 时间解析与时区处理：存储一律 UTC ISO8601，展示按时区格式化

const NO_TZ_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?$/;
const ZH_DATE_RE = /(\d{4})年(\d{1,2})月(\d{1,2})日(?:\s*(\d{1,2})[:：](\d{2}))?/;

/**
 * 解析日期字符串为 UTC ISO
 * @param assumeOffsetMin 无时区信息时假定的 UTC 偏移（分钟），如北京时间 480
 */
export function parseDate(input?: string | null, assumeOffsetMin = 0): string | null {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;

  const noTz = NO_TZ_RE.exec(s);
  if (noTz) {
    const [, y, mo, d, h, mi, se] = noTz;
    const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(se || 0)) - assumeOffsetMin * 60000;
    return new Date(utc).toISOString();
  }
  const zh = ZH_DATE_RE.exec(s);
  if (zh) {
    const [, y, mo, d, h, mi] = zh;
    const off = assumeOffsetMin || 480; // 中文日期默认按北京时间
    const utc = Date.UTC(+y, +mo - 1, +d, +(h || 0), +(mi || 0)) - off * 60000;
    return new Date(utc).toISOString();
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString();
  return null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function minutesAgoIso(min: number, from = new Date()): string {
  return new Date(from.getTime() - min * 60000).toISOString();
}

export function hoursAgoIso(h: number, from = new Date()): string {
  return minutesAgoIso(h * 60, from);
}

/** 在指定时区格式化为 "YYYY-MM-DD HH:mm" */
export function formatInTz(iso: string, tz: string): string {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of fmt.formatToParts(d)) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

/** 信息截止时间标注 */
export function cutoffLabel(iso: string, tz: string): string {
  return `信息截至：${formatInTz(iso, tz)}（${tz}）`;
}

/** 指定时区的 "HH:mm" */
export function localHm(date: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return fmt.format(date);
}

/** 指定时区的 "YYYY-MM-DD"（简报 periodKey 用） */
export function localDateKey(date: Date, tz: string): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return fmt.format(date);
}

/** 相对时间（中文） */
export function relativeZh(iso: string, from = new Date()): string {
  const ms = from.getTime() - new Date(iso).getTime();
  const min = Math.floor(ms / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}天前`;
  return iso.slice(0, 10);
}
