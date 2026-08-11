import { PARTY_LABELS } from "../../shared/constants";
import type {
  Citation,
  ClaimRationale,
  ClaimStatus,
  ClaimType,
  DisputeGroup,
  EvidenceStance,
} from "../../shared/types";
import { claims } from "../db/schema";
import { baseDomain } from "../lib/urls";
import { isClaimCorrection } from "./claims";

export type ClaimRow = typeof claims.$inferSelect;
export type ClaimInsert = typeof claims.$inferInsert;

export interface VerificationClaim {
  id: string;
  eventId?: string;
  text: string;
  type: ClaimType | string;
  claimedBy?: string | null;
  claimedByKind?: string | null;
  party?: string | null;
  status?: ClaimStatus | string;
  supersededBy?: string | null;
}

export interface VerificationEvidence {
  articleId: string;
  stance: EvidenceStance;
  familyKey?: string | null;
  hasPrimary?: boolean;
  isParty?: boolean;
  party?: string | null;
  sourceId?: string | null;
  sourceFamilyId?: string | null;
  sourceFamilyKind?: string | null;
  wireFamily?: string | null;
  reprintOf?: string | null;
  url?: string | null;
}

export interface ClaimVerificationOptions {
  forceConflict?: boolean;
  minCorroboratingChains?: number;
}

export interface ClaimVerificationResult {
  status: ClaimStatus;
  rationale: ClaimRationale;
  supportingFamilies: string[];
  reportingFamilies: string[];
  disputingFamilies: string[];
  refutingFamilies: string[];
}

export interface ClaimStatusPatch {
  id: string;
  status: ClaimStatus;
  rationale: ClaimRationale;
  lastCheckedAt: string;
  supersededBy?: string | null;
}

export interface CasualtyClaimInput {
  id: string;
  eventId: string;
  text: string;
  type: ClaimType | string;
  claimedBy?: string | null;
  party?: string | null;
  subjectNumber?: number | null;
  numberUnit?: string | null;
  asOf?: string | null;
  publishedAt?: string | null;
  firstSeenAt: string;
  status: ClaimStatus | string;
  rationale?: ClaimRationale | null;
  supersededBy?: string | null;
  citation?: Citation | null;
}

export interface CasualtyConflict {
  eventId: string;
  numberUnit: string;
  claimIds: string[];
  parties: string[];
  values: number[];
}

export interface CasualtyConflictOptions {
  comparableHours?: number;
  relativeTolerance?: number;
  absoluteTolerance?: number;
  checkedAt: string;
}

export interface CasualtyConflictResult {
  updates: ClaimStatusPatch[];
  disputes: DisputeGroup[];
  conflicts: CasualtyConflict[];
}

const CLAIM_TYPES = new Set<ClaimType>(["event", "statement", "casualty", "number", "intent"]);
const LOWER_BOUND_RE = /至少|不低于|(?<!不)超过|多于|逾|\b(?:at least|no fewer than|more than|over)\b/i;
const UPPER_BOUND_RE = /最多|不超过|至多|\b(?:up to|at most|no more than)\b/i;
const APPROX_RE = /约|大约|左右|近|\b(?:about|around|approximately|roughly)\b/i;

function asClaimType(value: string): ClaimType {
  return CLAIM_TYPES.has(value as ClaimType) ? value as ClaimType : "event";
}

function reprintRootsOf(evidence: readonly VerificationEvidence[]): Set<string> {
  return new Set(evidence.map((item) => item.reprintOf).filter((value): value is string => Boolean(value)));
}

/** 生成证据链家族键，平台家族不会把平台上的不同账号错误折叠为同一来源 */
export function familyKeyForEvidence(
  evidence: VerificationEvidence,
  knownReprintRoots: ReadonlySet<string> = new Set()
): string {
  if (evidence.familyKey) return evidence.familyKey;
  if (evidence.wireFamily) return evidence.wireFamily.startsWith("wire:") || evidence.wireFamily.startsWith("reprint:")
    ? evidence.wireFamily
    : `wire:${evidence.wireFamily}`;
  if (evidence.reprintOf) return `reprint:${evidence.reprintOf}`;
  if (knownReprintRoots.has(evidence.articleId)) return `reprint:${evidence.articleId}`;
  if (evidence.sourceFamilyId && (evidence.sourceFamilyKind === "ownership" || evidence.sourceFamilyKind === "wire")) {
    return `family:${evidence.sourceFamilyId}`;
  }
  if (evidence.sourceId) return `source:${evidence.sourceId}`;
  const domain = evidence.url ? baseDomain(evidence.url) : "";
  return domain ? `domain:${domain}` : `article:${evidence.articleId}`;
}

function effectiveStance(claim: VerificationClaim, evidence: VerificationEvidence): EvidenceStance {
  const type = asClaimType(claim.type);
  if (type !== "statement" && evidence.isParty && evidence.stance === "supports") return "reports";
  return evidence.stance;
}

function familiesFor(
  claim: VerificationClaim,
  evidence: readonly VerificationEvidence[],
  stances: readonly EvidenceStance[]
): string[] {
  const allowed = new Set(stances);
  const families = new Set<string>();
  const reprintRoots = reprintRootsOf(evidence);
  for (const item of evidence) {
    if (allowed.has(effectiveStance(claim, item))) families.add(familyKeyForEvidence(item, reprintRoots));
  }
  return [...families].sort();
}

/** 按稿源、转载根与所有权家族折叠后计算独立证据链数量 */
export function countIndependentChains(
  evidence: readonly VerificationEvidence[],
  stances: readonly EvidenceStance[] = ["supports", "reports"]
): number {
  const allowed = new Set(stances);
  const roots = reprintRootsOf(evidence);
  return new Set(evidence.filter((item) => allowed.has(item.stance)).map((item) => familyKeyForEvidence(item, roots))).size;
}

function hasPrimaryFor(
  claim: VerificationClaim,
  evidence: readonly VerificationEvidence[],
  stances: readonly EvidenceStance[]
): boolean {
  const allowed = new Set(stances);
  return evidence.some((item) => item.hasPrimary && allowed.has(effectiveStance(claim, item)));
}

function baseRationale(
  factors: string[],
  independentChains: number,
  hasPrimary: boolean,
  hasRefutation: boolean
): ClaimRationale {
  return {
    factors: [...new Set(factors)],
    independentChains,
    hasPrimary,
    hasRefutation,
  };
}

/** 根据 claim-specific 证据立场评估状态，reports 不会被当成独立 supports */
export function evaluateClaimStatus(
  claim: VerificationClaim,
  evidence: readonly VerificationEvidence[],
  options: ClaimVerificationOptions = {}
): ClaimVerificationResult {
  const type = asClaimType(claim.type);
  const supportingFamilies = familiesFor(claim, evidence, ["supports"]);
  const reportingFamilies = familiesFor(claim, evidence, ["reports"]);
  const disputingFamilies = familiesFor(claim, evidence, ["disputes"]);
  const refutingFamilies = familiesFor(claim, evidence, ["refutes"]);
  const supportCount = supportingFamilies.length;
  const reportCount = reportingFamilies.length;
  const disputeCount = disputingFamilies.length;
  const refuteCount = refutingFamilies.length;
  const minCorroborating = Math.max(2, options.minCorroboratingChains ?? 2);
  const hasPrimarySupport = hasPrimaryFor(claim, evidence, ["supports"]);
  const hasPrimaryRefutation = hasPrimaryFor(claim, evidence, ["refutes"]);
  const factors: string[] = [];
  let status: ClaimStatus;

  if (claim.supersededBy) {
    status = "outdated";
    factors.push(`该主张已被后续主张 ${claim.supersededBy} 替代`);
  } else if (options.forceConflict || disputeCount > 0 || (refuteCount > 0 && (supportCount > 0 || reportCount > 0))) {
    status = "disputed";
    factors.push("独立来源之间存在明确冲突或反向证据");
  } else if (refuteCount >= 2 || hasPrimaryRefutation) {
    status = "refuted";
    factors.push("存在第一手反证或至少两条独立反证链");
  } else if (refuteCount === 1) {
    status = "disputed";
    factors.push("存在一条反证链，尚不足以单独判定为已反驳");
  } else if (type === "statement") {
    if (hasPrimarySupport || supportCount >= minCorroborating) {
      status = "corroborated";
      factors.push("已确认相关表述确实由所列主体发布");
    } else if (supportCount > 0) {
      status = "partially_corroborated";
      factors.push("有材料支持该表述确实存在，但尚缺第一手原文或第二条独立链");
    } else {
      status = "reported";
      factors.push("当前仅确认有来源转述该表述");
    }
    factors.push("声明状态只评价表述是否发生，不代表表述中的底层事实已获确认");
  } else if (supportCount >= minCorroborating) {
    status = "corroborated";
    factors.push(`已有 ${supportCount} 条相互独立的支持证据链`);
  } else if (supportCount === 1) {
    status = "partially_corroborated";
    factors.push(hasPrimarySupport ? "已有一条第一手支持材料，但尚缺第二条独立证据链" : "已有一条支持证据链，但尚未达到交叉确认门槛");
  } else if (reportCount > 0) {
    const partyClaim = Boolean(claim.party || claim.claimedByKind === "party" || claim.claimedByKind === "military");
    status = partyClaim ? "unverified" : "reported";
    factors.push(partyClaim ? "当前材料主要是当事方主张或对该主张的转述" : "有来源进行了报道，但没有 claim-specific 支持材料");
  } else {
    status = "unverified";
    factors.push("尚无可用的支持或转述证据链");
  }

  if (reportCount > 1) factors.push(`${reportCount} 个独立来源家族进行了转述，但转述数量不等于事实确认`);
  const independentChains = new Set([...supportingFamilies, ...reportingFamilies]).size;
  return {
    status,
    rationale: baseRationale(factors, independentChains, hasPrimarySupport, refuteCount > 0),
    supportingFamilies,
    reportingFamilies,
    disputingFamilies,
    refutingFamilies,
  };
}

export const evaluateClaim = evaluateClaimStatus;

/** 将核验结果转换为 claims 更新字段 */
export function buildClaimStatusPatch(
  claimId: string,
  result: ClaimVerificationResult,
  checkedAt: string,
  supersededBy?: string | null
): ClaimStatusPatch {
  return {
    id: claimId,
    status: result.status,
    rationale: result.rationale,
    lastCheckedAt: checkedAt,
    ...(supersededBy !== undefined ? { supersededBy } : {}),
  };
}

function effectiveClaimTime(claim: CasualtyClaimInput): number | null {
  for (const value of [claim.asOf, claim.publishedAt, claim.firstSeenAt]) {
    if (!value) continue;
    const time = Date.parse(value);
    if (Number.isFinite(time)) return time;
  }
  return null;
}

function attributionKey(claim: CasualtyClaimInput): string {
  if (claim.claimedBy) return `actor:${claim.claimedBy.toLowerCase()}`;
  if (claim.party) return `party:${claim.party}`;
  return `claim:${claim.id}`;
}

function metricLabel(unit: string): string {
  const labels: Record<string, string> = {
    deaths: "死亡人数",
    injuries: "受伤人数",
    missing: "失踪人数",
    casualties: "伤亡总数",
    civilian_deaths: "平民死亡人数",
    civilian_injuries: "平民受伤人数",
    civilian_missing: "平民失踪人数",
    civilian_casualties: "平民伤亡总数",
    military_deaths: "军事人员死亡人数",
    military_injuries: "军事人员受伤人数",
    military_missing: "军事人员失踪人数",
    military_casualties: "军事人员伤亡总数",
  };
  return labels[unit] || unit;
}

function partyLabel(claim: CasualtyClaimInput): string {
  if (claim.party) return PARTY_LABELS[claim.party] || claim.party;
  return claim.claimedBy || "未注明来源";
}

interface NumberRange {
  min: number;
  max: number;
}

function persistedQualifier(claim: CasualtyClaimInput): "exact" | "at_least" | "more_than" | "about" | "up_to" | null {
  for (const factor of claim.rationale?.factors || []) {
    const match = /^数值限定词：(exact|at_least|more_than|about|up_to)$/.exec(factor);
    if (match) return match[1] as "exact" | "at_least" | "more_than" | "about" | "up_to";
  }
  return null;
}

function numberRange(claim: CasualtyClaimInput): NumberRange | null {
  const value = claim.subjectNumber;
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const qualifier = persistedQualifier(claim);
  if (qualifier === "at_least" || qualifier === "more_than") return { min: value, max: Infinity };
  if (qualifier === "up_to") return { min: 0, max: value };
  if (qualifier === "about") return { min: value * 0.85, max: value * 1.15 };
  if (qualifier === "exact") return { min: value, max: value };
  if (UPPER_BOUND_RE.test(claim.text)) return { min: 0, max: value };
  if (LOWER_BOUND_RE.test(claim.text)) return { min: value, max: Infinity };
  if (APPROX_RE.test(claim.text)) return { min: value * 0.85, max: value * 1.15 };
  return { min: value, max: value };
}

function rangesConflict(
  left: CasualtyClaimInput,
  right: CasualtyClaimInput,
  relativeTolerance: number,
  absoluteTolerance: number
): boolean {
  const a = numberRange(left);
  const b = numberRange(right);
  if (!a || !b) return false;
  const overlap = Math.min(a.max, b.max) - Math.max(a.min, b.min);
  if (overlap >= 0) return false;
  const leftValue = left.subjectNumber || 0;
  const rightValue = right.subjectNumber || 0;
  const difference = Math.abs(leftValue - rightValue);
  const scale = Math.max(1, Math.abs(leftValue), Math.abs(rightValue));
  return difference > absoluteTolerance && difference / scale > relativeTolerance;
}

function comparableInTime(left: CasualtyClaimInput, right: CasualtyClaimInput, maxHours: number): boolean {
  const a = effectiveClaimTime(left);
  const b = effectiveClaimTime(right);
  if (a === null || b === null) return true;
  return Math.abs(a - b) / 3_600_000 <= maxHours;
}

function mergeRationale(
  claim: CasualtyClaimInput,
  factor: string,
  hasRefutation = false
): ClaimRationale {
  const existing = claim.rationale;
  return {
    factors: [...new Set([...(existing?.factors || []), factor])],
    independentChains: existing?.independentChains || 0,
    hasPrimary: existing?.hasPrimary || false,
    hasRefutation: existing?.hasRefutation || hasRefutation,
  };
}

function clearResolvedConflictRationale(claim: CasualtyClaimInput): ClaimRationale {
  const existing = claim.rationale;
  return {
    factors: (existing?.factors || []).filter((factor) => !factor.includes("不可兼容的")),
    independentChains: existing?.independentChains || 0,
    hasPrimary: existing?.hasPrimary || false,
    hasRefutation: existing?.hasRefutation || false,
  };
}

function supersessionUpdates(claimsInGroup: readonly CasualtyClaimInput[], checkedAt: string): { updates: ClaimStatusPatch[]; active: CasualtyClaimInput[] } {
  const byAttribution = new Map<string, CasualtyClaimInput[]>();
  for (const claim of claimsInGroup) {
    const key = attributionKey(claim);
    const group = byAttribution.get(key) || [];
    group.push(claim);
    byAttribution.set(key, group);
  }

  const updates: ClaimStatusPatch[] = [];
  const active: CasualtyClaimInput[] = [];
  for (const group of byAttribution.values()) {
    const times = group.map((claim) => effectiveClaimTime(claim)).filter((value): value is number => value !== null);
    if (times.length === 0) {
      active.push(...group);
      continue;
    }
    const latestTime = Math.max(...times);
    const latestClaims = group.filter((claim) => effectiveClaimTime(claim) === latestTime);
    active.push(...latestClaims);
    if (latestClaims.length !== 1) continue;
    const latest = latestClaims[0];
    for (const older of group) {
      const olderTime = effectiveClaimTime(older);
      if (older.id === latest.id || olderTime === null || olderTime >= latestTime) continue;
      const changed = older.subjectNumber !== latest.subjectNumber;
      const corrected = isClaimCorrection(latest.text);
      if (!changed && !corrected) continue;
      updates.push({
        id: older.id,
        status: "outdated",
        rationale: mergeRationale(older, `同一发布方的后续数字由主张 ${latest.id} 替代`),
        lastCheckedAt: checkedAt,
        supersededBy: latest.id,
      });
    }
  }
  return { updates, active };
}

/** 处理伤亡数字更新与冲突：同一发布方的后续值做 supersede，不同发布方的不可兼容值标为 disputed */
export function handleCasualtyNumberConflicts(
  input: readonly CasualtyClaimInput[],
  options: CasualtyConflictOptions
): CasualtyConflictResult {
  const comparableHours = options.comparableHours ?? 48;
  const relativeTolerance = options.relativeTolerance ?? 0.1;
  const absoluteTolerance = options.absoluteTolerance ?? 1;
  const groups = new Map<string, CasualtyClaimInput[]>();

  for (const claim of input) {
    if (asClaimType(claim.type) !== "casualty" || claim.subjectNumber === null || claim.subjectNumber === undefined || !claim.numberUnit) continue;
    const key = `${claim.eventId}|${claim.numberUnit}`;
    const group = groups.get(key) || [];
    group.push(claim);
    groups.set(key, group);
  }

  const updateMap = new Map<string, ClaimStatusPatch>();
  const disputes: DisputeGroup[] = [];
  const conflicts: CasualtyConflict[] = [];

  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const supersession = supersessionUpdates(group, options.checkedAt);
    for (const update of supersession.updates) updateMap.set(update.id, update);
    const active = supersession.active.filter((claim) => !updateMap.has(claim.id));
    const conflicted = new Set<string>();

    for (let leftIndex = 0; leftIndex < active.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < active.length; rightIndex += 1) {
        const left = active[leftIndex];
        const right = active[rightIndex];
        if (attributionKey(left) === attributionKey(right)) continue;
        if (!comparableInTime(left, right, comparableHours)) continue;
        if (!rangesConflict(left, right, relativeTolerance, absoluteTolerance)) continue;
        conflicted.add(left.id);
        conflicted.add(right.id);
      }
    }

    if (conflicted.size === 0) {
      for (const claim of active) {
        const hadNumericConflict = claim.rationale?.factors.some((factor) => factor.includes("不可兼容的"));
        if (claim.status !== "disputed" || !hadNumericConflict) continue;
        updateMap.set(claim.id, {
          id: claim.id,
          status: "unverified",
          rationale: clearResolvedConflictRationale(claim),
          lastCheckedAt: options.checkedAt,
          supersededBy: claim.supersededBy || null,
        });
      }
      continue;
    }
    const positions = active
      .filter((claim) => conflicted.has(claim.id))
      .sort((a, b) => partyLabel(a).localeCompare(partyLabel(b)) || a.id.localeCompare(b.id));
    const [, numberUnit] = key.split("|");
    disputes.push({
      topic: `伤亡数字争议：${metricLabel(numberUnit)}`,
      positions: positions.map((claim) => ({
        party: partyLabel(claim),
        text: claim.text,
        number: claim.subjectNumber,
        asOf: claim.asOf || null,
        citation: claim.citation || null,
      })),
    });
    conflicts.push({
      eventId: positions[0].eventId,
      numberUnit,
      claimIds: positions.map((claim) => claim.id),
      parties: positions.map(partyLabel),
      values: positions.map((claim) => claim.subjectNumber as number),
    });

    for (const claim of positions) {
      updateMap.set(claim.id, {
        id: claim.id,
        status: "disputed",
        rationale: mergeRationale(claim, `相同口径和相近截至时间下，不同发布方给出不可兼容的${metricLabel(numberUnit)}`),
        lastCheckedAt: options.checkedAt,
        supersededBy: claim.supersededBy || null,
      });
    }
  }

  return {
    updates: [...updateMap.values()].sort((a, b) => a.id.localeCompare(b.id)),
    disputes,
    conflicts,
  };
}

export const resolveCasualtyConflicts = handleCasualtyNumberConflicts;
export const evaluateCasualtyConflicts = handleCasualtyNumberConflicts;

/** 仅计算同一发布方后续数字对旧主张的替代关系 */
export function supersedeUpdatedClaims(
  input: readonly CasualtyClaimInput[],
  checkedAt: string
): ClaimStatusPatch[] {
  const groups = new Map<string, CasualtyClaimInput[]>();
  for (const claim of input) {
    if (asClaimType(claim.type) !== "casualty" || !claim.numberUnit) continue;
    const key = `${claim.eventId}|${claim.numberUnit}`;
    const group = groups.get(key) || [];
    group.push(claim);
    groups.set(key, group);
  }
  return [...groups.values()]
    .flatMap((group) => supersessionUpdates(group, checkedAt).updates)
    .sort((a, b) => a.id.localeCompare(b.id));
}
