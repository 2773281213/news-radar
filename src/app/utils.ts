import type {
  AlertDTO,
  BriefingType,
  ClaimStatus,
  EventListItem,
  EventStatus,
  EvidenceStance,
  SourceHealth,
  TimelineItem,
  TrackMode,
} from "../shared/types";
import {
  CATEGORY_LABELS,
  CLAIM_STATUS_LABELS,
  HEALTH_LABELS,
  TOPIC_LABELS,
} from "../shared/constants";

export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  developing: "持续发展",
  active: "活跃",
  dormant: "低频更新",
  closed: "已归档",
};

export const TRACK_MODE_LABELS: Record<TrackMode, string> = {
  breaking: "突发追踪",
  active: "密切跟踪",
  normal: "常规跟踪",
  slow: "低频跟踪",
};

export const EVIDENCE_STANCE_LABELS: Record<EvidenceStance, string> = {
  supports: "支持",
  reports: "报道",
  disputes: "质疑",
  refutes: "反驳",
  context: "背景",
};

export const BRIEFING_TYPE_LABELS: Record<BriefingType, string> = {
  morning: "晨报",
  noon: "午间简报",
  evening: "晚报",
  breaking: "突发简报",
  hourly: "小时更新",
  topic: "专题简报",
  watchlist: "观察列表简报",
};

export const ALERT_LEVEL_LABELS: Record<AlertDTO["level"], string> = {
  info: "信息",
  notable: "重要",
  breaking: "突发",
};

export const TIMELINE_KIND_LABELS: Record<TimelineItem["kind"], string> = {
  occurrence: "事件",
  statement: "声明",
  report: "报道",
  revision: "修订",
};

export const CLAIM_STATUS_TONES: Record<
  ClaimStatus,
  "neutral" | "warning" | "good" | "danger" | "evidence"
> = {
  reported: "neutral",
  unverified: "warning",
  partially_corroborated: "evidence",
  corroborated: "good",
  disputed: "danger",
  refuted: "danger",
  outdated: "neutral",
};

export const HEALTH_TONES: Record<
  SourceHealth,
  "good" | "warning" | "danger" | "neutral"
> = {
  ok: "good",
  degraded: "warning",
  failing: "danger",
  disabled: "neutral",
  unknown: "neutral",
};

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export function formatNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 }).format(value);
}

export function formatCompactNumber(value: number): string {
  return new Intl.NumberFormat("zh-CN", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export function formatDateTime(
  value: string | null | undefined,
  timeZone: string,
  options: Intl.DateTimeFormatOptions = {},
): string {
  if (!value) return "暂无记录";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间格式异常";

  try {
    return new Intl.DateTimeFormat("zh-CN", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...options,
    }).format(date);
  } catch {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
      ...options,
    }).format(date);
  }
}

export function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return "暂无记录";
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "时间格式异常";

  const diffSeconds = Math.round((timestamp - Date.now()) / 1000);
  const absolute = Math.abs(diffSeconds);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });

  if (absolute < 60) return formatter.format(diffSeconds, "second");
  if (absolute < 3_600) return formatter.format(Math.round(diffSeconds / 60), "minute");
  if (absolute < 86_400) return formatter.format(Math.round(diffSeconds / 3_600), "hour");
  return formatter.format(Math.round(diffSeconds / 86_400), "day");
}

export function safeExternalUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function getHostname(value: string | null | undefined): string {
  const safe = safeExternalUrl(value);
  if (!safe) return "来源链接";
  try {
    return new URL(safe).hostname.replace(/^www\./, "");
  } catch {
    return "来源链接";
  }
}

export function splitTerms(value: string): string[] {
  return Array.from(
    new Set(
      value
        .split(/[，,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  );
}

export function sourceCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category;
}

export function topicLabel(topic: string): string {
  return TOPIC_LABELS[topic] ?? topic;
}

export function claimStatusLabel(status: ClaimStatus): string {
  return CLAIM_STATUS_LABELS[status];
}

export function healthLabel(health: SourceHealth): string {
  return HEALTH_LABELS[health];
}

export function eventMatchesTab(event: EventListItem, tab: string): boolean {
  if (tab === "breaking") {
    return event.trackMode === "breaking" || event.status === "developing";
  }

  const topics = new Set(event.topics);
  const countries = new Set(event.countries.map((country) => country.toUpperCase()));
  const isDomestic = countries.has("CN") || countries.has("CHN") || countries.has("中国");

  if (tab === "domestic") return isDomestic;
  if (tab === "intl") return !isDomestic;
  if (tab === "diplomacy") {
    return ["diplomacy", "defense", "conflict", "security"].some((topic) => topics.has(topic));
  }
  if (tab === "economy") {
    return ["policy", "economy", "energy", "finance", "tech"].some((topic) => topics.has(topic));
  }
  return true;
}

export function uniqueById<T extends { id: string | number }>(items: T[]): T[] {
  return Array.from(new Map(items.map((item) => [item.id, item])).values());
}
