import type { EventDetailDTO, TrackMode } from "../../shared/types";
import type { ArticleWithSource } from "../services/article-store";

export interface EventPriority {
  importance: number;
  heat: number;
  trackMode: TrackMode;
}

export function calculateEventPriority(
  detail: EventDetailDTO,
  articles: readonly ArticleWithSource[],
  independentFamilies: number,
  nowMs = Date.now()
): EventPriority {
  let importance = 25;
  const majorTopics = new Set(["conflict", "defense", "diplomacy", "security", "sanctions", "disaster", "policy", "economy"]);
  importance += detail.topics.filter((topic) => majorTopics.has(topic)).length * 7;
  importance += Math.min(20, independentFamilies * 3);
  importance += articles.some((article) => article.sourceIsPrimary) ? 8 : 0;
  importance += detail.confirmedCount > 0 ? 5 : 0;
  importance += detail.disputedCount > 0 ? 5 : 0;
  if (detail.countries.length >= 2) importance += 8;
  importance = Math.max(detail.importance, Math.min(100, Math.max(0, Math.round(importance))));

  const recentSixHours = articles.filter((article) => {
    const at = Date.parse(article.publishedAt || article.firstSeenAt);
    return Number.isFinite(at) && at >= nowMs - 6 * 3_600_000;
  }).length;
  const heat = Math.min(100, Math.round(recentSixHours * 10 + independentFamilies * 5 + importance * 0.25));
  const trackMode: TrackMode =
    importance >= 80 && recentSixHours >= 2
      ? "breaking"
      : recentSixHours >= 2
        ? "active"
        : articles.length > 5
          ? "normal"
          : "slow";

  return { importance, heat, trackMode };
}
