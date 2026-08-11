import type {
  Citation,
  ClaimDTO,
  EventSummaryDTO,
  EventVersionDelta,
  TimelineItem,
} from "../../shared/types";
import { eventVersions } from "../db/schema";
import { normalizeText } from "../lib/textsim";

export type EventVersionInsert = typeof eventVersions.$inferInsert;

export interface TimelineClaimInput {
  id: string;
  text: string;
  type: string;
  occurredAt?: string | null;
  publishedAt?: string | null;
  firstSeenAt: string;
  citation?: Citation | null;
}

export interface TimelineArticleInput {
  id: string;
  title: string;
  publishedAt?: string | null;
  firstSeenAt: string;
  citation?: Citation | null;
}

export interface TimelineArticleVersionInput {
  articleId: string;
  seenAt: string;
  title: string;
  note?: string | null;
  citation?: Citation | null;
}

export interface TimelineEventVersionInput {
  version: number;
  createdAt: string;
  changes?: { added: string[]; changed: string[]; removed: string[] } | null;
}

export interface BuildTimelineInput {
  claims?: readonly TimelineClaimInput[];
  articles?: readonly TimelineArticleInput[];
  articleVersions?: readonly TimelineArticleVersionInput[];
  eventVersions?: readonly TimelineEventVersionInput[];
}

export interface ClaimDeltaInput {
  id: string;
  text: string;
  status: string;
  subjectNumber?: number | null;
  numberUnit?: string | null;
  asOf?: string | null;
  party?: string | null;
  supersededBy?: string | null;
}

interface DeltaEntry {
  id: string;
  text: string;
  fingerprint: string;
}

const KIND_ORDER: Record<TimelineItem["kind"], number> = {
  occurrence: 0,
  statement: 1,
  report: 2,
  revision: 3,
};

function validAt(value?: string | null): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function timelineKey(item: TimelineItem): string {
  return [item.kind, item.at, normalizeText(item.text), item.citation?.articleId || ""].join("|");
}

function articleVersionText(version: TimelineArticleVersionInput): string {
  const labels: Record<string, string> = {
    modified: "原文已修改",
    corrected: "原文发布更正",
    deleted: "原文已删除或撤回",
  };
  return `${labels[version.note || ""] || "原文版本发生变化"}：${version.title}`;
}

function eventVersionText(version: TimelineEventVersionInput): string {
  const counts = version.changes
    ? `新增 ${version.changes.added.length} 项、变更 ${version.changes.changed.length} 项、移除 ${version.changes.removed.length} 项`
    : "事件摘要已更新";
  return `事件摘要更新至第 ${version.version} 版（${counts}）`;
}

/** 构建发生、声明、报道与修订四类时间线，并按真实时间而非 ISO 字符串格式排序 */
export function buildTimeline(input: BuildTimelineInput): TimelineItem[] {
  const items: TimelineItem[] = [];

  for (const claim of input.claims || []) {
    if (claim.type === "statement") {
      const at = validAt(claim.publishedAt || claim.firstSeenAt);
      if (at) items.push({ at, kind: "statement", text: claim.text, citation: claim.citation || null });
      continue;
    }
    const at = validAt(claim.occurredAt);
    if (at) items.push({ at, kind: "occurrence", text: claim.text, citation: claim.citation || null });
  }

  for (const article of input.articles || []) {
    const at = validAt(article.publishedAt || article.firstSeenAt);
    if (at) items.push({ at, kind: "report", text: `报道：${article.title}`, citation: article.citation || null });
  }

  for (const version of input.articleVersions || []) {
    const at = validAt(version.seenAt);
    if (at) items.push({ at, kind: "revision", text: articleVersionText(version), citation: version.citation || null });
  }

  for (const version of input.eventVersions || []) {
    const at = validAt(version.createdAt);
    if (at) items.push({ at, kind: "revision", text: eventVersionText(version) });
  }

  const unique = new Map<string, TimelineItem>();
  for (const item of items) if (!unique.has(timelineKey(item))) unique.set(timelineKey(item), item);
  return [...unique.values()].sort((a, b) => {
    const time = Date.parse(a.at) - Date.parse(b.at);
    if (time !== 0) return time;
    const kind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    if (kind !== 0) return kind;
    const text = a.text.localeCompare(b.text);
    if (text !== 0) return text;
    return (a.citation?.articleId || "").localeCompare(b.citation?.articleId || "");
  });
}

export const buildEventTimeline = buildTimeline;

function pushSummaryEntries(summary: EventSummaryDTO | null | undefined): DeltaEntry[] {
  if (!summary) return [];
  const out: DeltaEntry[] = [];
  for (const item of summary.confirmed) {
    out.push({ id: `claim:${item.claimId}`, text: item.text, fingerprint: `confirmed|${normalizeText(item.text)}` });
  }
  for (const item of summary.unverified) {
    out.push({ id: `claim:${item.claimId}`, text: item.text, fingerprint: `unverified|${normalizeText(item.text)}` });
  }
  for (const group of summary.statements) {
    for (const item of group.items) {
      out.push({
        id: `claim:${item.claimId}`,
        text: item.text,
        fingerprint: `statement|${group.party}|${item.status}|${normalizeText(item.text)}`,
      });
    }
  }
  for (const group of summary.disputed) {
    for (const position of group.positions) {
      const id = `dispute:${normalizeText(group.topic)}:${position.party}:${position.number ?? ""}:${normalizeText(position.text)}`;
      out.push({
        id,
        text: position.text,
        fingerprint: `disputed|${normalizeText(group.topic)}|${position.party}|${position.number ?? ""}|${position.asOf || ""}|${normalizeText(position.text)}`,
      });
    }
  }
  if (summary.oneLiner) {
    out.push({ id: "summary:oneLiner", text: summary.oneLiner, fingerprint: normalizeText(summary.oneLiner) });
  }
  return out;
}

function sortedValues(values: readonly string[]): string[] {
  return values.filter(Boolean).sort((a, b) => a.localeCompare(b));
}

/** 比较带稳定 ID 的语义条目，顺序变化不会产生虚假 delta */
export function diffDeltaEntries(
  previous: readonly DeltaEntry[],
  current: readonly DeltaEntry[],
  sinceVersion: number
): EventVersionDelta {
  const before = new Map(previous.map((item) => [item.id, item]));
  const after = new Map(current.map((item) => [item.id, item]));
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];

  for (const [id, item] of after) {
    const old = before.get(id);
    if (!old) added.push(item.text);
    else if (old.fingerprint !== item.fingerprint) changed.push(item.text);
  }
  for (const [id, item] of before) if (!after.has(id)) removed.push(item.text);

  return {
    sinceVersion,
    added: sortedValues(added),
    changed: sortedValues(changed),
    removed: sortedValues(removed),
  };
}

/** 比较事件摘要，Claim 在分组或状态间移动会记为 changed 而非删除加新增 */
export function diffEventSummary(
  previous: EventSummaryDTO | null | undefined,
  current: EventSummaryDTO | null | undefined,
  sinceVersion: number
): EventVersionDelta {
  return diffDeltaEntries(pushSummaryEntries(previous), pushSummaryEntries(current), sinceVersion);
}

export const computeEventDelta = diffEventSummary;
export const calculateEventDelta = diffEventSummary;

function claimEntry(claim: ClaimDeltaInput): DeltaEntry {
  return {
    id: claim.id,
    text: claim.text,
    fingerprint: [
      normalizeText(claim.text),
      claim.status,
      claim.subjectNumber ?? "",
      claim.numberUnit || "",
      claim.asOf || "",
      claim.party || "",
      claim.supersededBy || "",
    ].join("|"),
  };
}

/** 直接比较 Claim 快照，适合在摘要尚未生成时构造事件版本差异 */
export function diffClaims(
  previous: readonly ClaimDeltaInput[],
  current: readonly ClaimDeltaInput[],
  sinceVersion: number
): EventVersionDelta {
  return diffDeltaEntries(previous.map(claimEntry), current.map(claimEntry), sinceVersion);
}

/** 从公开 ClaimDTO 构建时间线输入 */
export function timelineClaimsFromDtos(claims: readonly ClaimDTO[]): TimelineClaimInput[] {
  return claims.map((claim) => {
    const citation = [...claim.evidence]
      .filter((item) => item.citation)
      .sort((a, b) => Number(Boolean(b.hasPrimary)) - Number(Boolean(a.hasPrimary)) || a.articleId.localeCompare(b.articleId))[0]
      ?.citation || null;
    return {
      id: claim.id,
      text: claim.text,
      type: claim.type,
      occurredAt: claim.occurredAt,
      publishedAt: claim.publishedAt,
      firstSeenAt: claim.firstSeenAt,
      citation,
    };
  });
}

/** 生成 event_versions 写入对象 */
export function buildEventVersionInsert(
  eventId: string,
  version: number,
  createdAt: string,
  previous: EventSummaryDTO | null | undefined,
  current: EventSummaryDTO | null | undefined
): EventVersionInsert {
  const delta = diffEventSummary(previous, current, Math.max(0, version - 1));
  return {
    eventId,
    version,
    createdAt,
    summary: current || null,
    changes: {
      added: delta.added,
      changed: delta.changed,
      removed: delta.removed,
    },
  };
}
