import type { ClaimStatus, MinistryAssignmentDTO, MinistryCode } from "../../shared/types";

/** v2 将六部分派接入真实专责报告与尚书完成门槛，触发旧案件重新审议。 */
export const THREE_DEPARTMENTS_RULES_VERSION = "three-departments-v2";

export interface MinistryRoutingInput {
  topics: readonly string[];
  claimStatuses: readonly ClaimStatus[];
  articles: readonly {
    sourceVerifStatus: string;
    sourceHealth: string;
    sourceCategory: string;
    isReprint: boolean;
  }[];
  independentFamilies: number;
}

const MINISTRY_ORDER: MinistryCode[] = [
  "source_identity",
  "economy",
  "diplomacy_society",
  "conflict_security",
  "law_factcheck",
  "technology_infrastructure_disaster",
];

const TOPIC_WEIGHTS: Record<string, Partial<Record<MinistryCode, number>>> = {
  domestic_politics: { law_factcheck: 4, source_identity: 1 },
  policy: { law_factcheck: 5, diplomacy_society: 1 },
  diplomacy: { diplomacy_society: 6, conflict_security: 1 },
  defense: { conflict_security: 7 },
  conflict: { conflict_security: 8, diplomacy_society: 2 },
  intl_politics: { diplomacy_society: 5, law_factcheck: 1 },
  election: { diplomacy_society: 4, law_factcheck: 3 },
  sanctions: { economy: 5, conflict_security: 3, diplomacy_society: 2 },
  economy: { economy: 7 },
  energy: { economy: 6, technology_infrastructure_disaster: 2 },
  finance: { economy: 7 },
  tech: { technology_infrastructure_disaster: 7, law_factcheck: 1 },
  ai: { technology_infrastructure_disaster: 7, law_factcheck: 2 },
  society: { diplomacy_society: 5, law_factcheck: 1 },
  health: { diplomacy_society: 4, technology_infrastructure_disaster: 3 },
  education: { diplomacy_society: 5 },
  climate: { technology_infrastructure_disaster: 6, diplomacy_society: 1 },
  disaster: { technology_infrastructure_disaster: 8, conflict_security: 1 },
  security: { conflict_security: 5, law_factcheck: 4 },
  intl_org: { diplomacy_society: 6 },
  investigation: { law_factcheck: 8, source_identity: 2 },
};

export function assignMinistries(input: MinistryRoutingInput): MinistryAssignmentDTO[] {
  const scores = new Map<MinistryCode, { score: number; reasons: Set<string> }>(
    MINISTRY_ORDER.map((ministry) => [ministry, { score: 0, reasons: new Set<string>() }])
  );

  for (const topic of [...new Set(input.topics)].sort()) {
    const weights = TOPIC_WEIGHTS[topic];
    if (!weights) continue;
    for (const [ministry, weight] of Object.entries(weights) as Array<[MinistryCode, number]>) {
      const target = scores.get(ministry)!;
      target.score += weight;
      target.reasons.add(`主题 ${topic} 触发职责规则（+${weight}）`);
    }
  }

  const unverifiedSources = input.articles.filter((article) => article.sourceVerifStatus !== "verified").length;
  const unhealthySources = input.articles.filter((article) => ["degraded", "failing"].includes(article.sourceHealth)).length;
  const reprints = input.articles.filter((article) => article.isReprint).length;
  const reprintRatio = input.articles.length ? reprints / input.articles.length : 0;
  const identity = scores.get("source_identity")!;
  if (unverifiedSources > 0) {
    identity.score += Math.min(8, 3 + unverifiedSources);
    identity.reasons.add(`${unverifiedSources} 个来源身份尚未完全核实`);
  }
  if (unhealthySources > 0) {
    identity.score += Math.min(4, unhealthySources);
    identity.reasons.add(`${unhealthySources} 个来源采集状态异常`);
  }
  if (reprintRatio >= 0.5 && reprints >= 2) {
    identity.score += 4;
    identity.reasons.add(`转载内容占比 ${Math.round(reprintRatio * 100)}%`);
  }
  if (input.independentFamilies < 2) {
    identity.score += 4;
    identity.reasons.add("独立来源家族不足两个");
  }

  const factcheck = scores.get("law_factcheck")!;
  const disputed = input.claimStatuses.filter((status) => status === "disputed" || status === "refuted").length;
  const pending = input.claimStatuses.filter((status) => ["reported", "unverified", "partially_corroborated"].includes(status)).length;
  if (disputed > 0) {
    factcheck.score += Math.min(8, disputed * 2);
    factcheck.reasons.add(`${disputed} 项主张存在争议或已被反驳`);
  }
  if (pending >= 3) {
    factcheck.score += 3;
    factcheck.reasons.add(`${pending} 项主张仍待进一步核验`);
  }
  if (input.articles.some((article) => article.sourceCategory === "factcheck")) {
    factcheck.score += 3;
    factcheck.reasons.add("事件包含事实核查来源");
  }

  const ranked = MINISTRY_ORDER.map((ministry, order) => {
    const value = scores.get(ministry)!;
    return { ministry, score: value.score, reasons: [...value.reasons].sort(), order };
  })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.order - b.order);

  const topScore = ranked[0]?.score ?? 0;
  return ranked.map(({ order: _order, ...item }, index) => ({
    ...item,
    primary: index === 0 && item.score === topScore,
  }));
}

export function ministryCodes(): MinistryCode[] {
  return [...MINISTRY_ORDER];
}
