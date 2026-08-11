import { sql } from "drizzle-orm";
import type { DB } from "../db/client";
import { sourceFamilies, sources } from "../db/schema";
import { loadSourceRegistry } from "../../../scripts/seed-sources";

/** 启动时幂等同步内置来源注册表；保留运行期健康、失败次数和最后抓取时间 */
export function ensureSourceRegistry(db: DB): { families: number; sources: number } {
  const registry = loadSourceRegistry();
  const now = new Date().toISOString();
  db.transaction((tx) => {
    for (const family of registry.families) {
      tx.insert(sourceFamilies)
        .values(family)
        .onConflictDoUpdate({
          target: sourceFamilies.id,
          set: { name: family.name, kind: family.kind, note: family.note },
        })
        .run();
    }
    for (const source of registry.sources) {
      tx.insert(sources)
        .values({ ...source, createdAt: now, updatedAt: now })
        .onConflictDoUpdate({
          target: sources.id,
          set: {
            name: source.name,
            homepage: source.homepage,
            feedUrl: source.feedUrl,
            adapter: source.adapter,
            config: source.config,
            country: source.country,
            region: source.region,
            lang: source.lang,
            category: source.category,
            owner: source.owner,
            ownershipNote: source.ownershipNote,
            isParty: source.isParty,
            partyOf: source.partyOf,
            isPrimary: source.isPrimary,
            paywalled: source.paywalled,
            fetchFulltext: source.fetchFulltext,
            intervalMin: source.intervalMin,
            verifStatus: source.verifStatus,
            verifBasis: source.verifBasis,
            lastReviewedAt: source.lastReviewedAt,
            familyId: source.familyId,
            enabled: source.enabled,
            health: source.enabled
              ? sql`CASE WHEN ${sources.health} = 'disabled' THEN 'unknown' ELSE ${sources.health} END`
              : "disabled",
            notes: source.notes,
            updatedAt: now,
          },
        })
        .run();
    }
  });
  return { families: registry.families.length, sources: registry.sources.length };
}
