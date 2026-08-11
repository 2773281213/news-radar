// 实体识别：基于多语言词表匹配（确定性、可测试），不依赖 AI
import { GAZETTEER } from "./gazetteer";
import { foldWidth } from "./textsim";

export interface EntityHit {
  slug: string;
  count: number;
}

interface CompiledAlias {
  slug: string;
  alias: string;
  /** 拉丁别名需要词边界匹配，CJK/阿拉伯等直接子串匹配 */
  needsBoundary: boolean;
}

let compiled: CompiledAlias[] | null = null;

function compile(): CompiledAlias[] {
  if (compiled) return compiled;
  const list: CompiledAlias[] = [];
  for (const g of GAZETTEER) {
    for (const aliases of Object.values(g.aliases)) {
      for (const a of aliases || []) {
        const alias = foldWidth(a);
        list.push({ slug: g.slug, alias, needsBoundary: /^[a-z0-9 .'-]+$/i.test(alias) });
      }
    }
  }
  // 长别名优先匹配，避免“伊朗外长”只命中“伊朗”后覆盖更具体实体
  list.sort((x, y) => y.alias.length - x.alias.length);
  compiled = list;
  return list;
}

/** 在文本中识别词表实体，返回 slug 与出现次数（按 salience 降序） */
export function extractEntities(text: string, max = 12): EntityHit[] {
  if (!text) return [];
  const hay = foldWidth(text).slice(0, 20000);
  const counts = new Map<string, number>();
  for (const { slug, alias, needsBoundary } of compile()) {
    let idx = 0;
    let found = 0;
    while (found < 50) {
      const pos = hay.indexOf(alias, idx);
      if (pos < 0) break;
      if (needsBoundary) {
        const before = pos === 0 ? " " : hay[pos - 1];
        const after = pos + alias.length >= hay.length ? " " : hay[pos + alias.length];
        if (/[a-z0-9]/.test(before) || /[a-z0-9]/.test(after)) {
          idx = pos + alias.length;
          continue;
        }
      }
      found++;
      idx = pos + alias.length;
    }
    if (found > 0) counts.set(slug, (counts.get(slug) || 0) + found);
  }
  return [...counts.entries()]
    .map(([slug, count]) => ({ slug, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, max);
}

/** 从实体推断涉及国家（用于事件 countries 字段与栏目归类） */
export function countriesOf(entities: EntityHit[]): string[] {
  const set = new Set<string>();
  for (const e of entities) {
    const g = GAZETTEER.find((x) => x.slug === e.slug);
    if (g?.country) set.add(g.country);
  }
  return [...set].slice(0, 8);
}
