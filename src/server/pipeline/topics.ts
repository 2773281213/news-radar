import { TOPIC_LABELS } from "../../shared/constants";
import type { SourceCategory } from "../../shared/types";
import { normalizeText } from "../lib/textsim";

export const TOPIC_KEYS = [
  "domestic_politics",
  "policy",
  "diplomacy",
  "defense",
  "conflict",
  "intl_politics",
  "election",
  "sanctions",
  "economy",
  "energy",
  "finance",
  "tech",
  "ai",
  "society",
  "health",
  "education",
  "climate",
  "disaster",
  "security",
  "intl_org",
  "investigation",
] as const;

export type TopicKey = (typeof TOPIC_KEYS)[number];

export interface TopicClassificationInput {
  title: string;
  excerpt?: string | null;
  bodyText?: string | null;
  sourceCategory?: SourceCategory | null;
}

export interface TopicClassificationOptions {
  maxTopics?: number;
  minScore?: number;
}

export interface TopicScore {
  topic: TopicKey;
  label: string;
  score: number;
  matches: string[];
}

interface TopicRule {
  patterns: readonly RegExp[];
  sourceBoost?: readonly SourceCategory[];
}

const TOPIC_RULES: Record<TopicKey, TopicRule> = {
  domestic_politics: {
    patterns: [
      /全国人大|全国政协|中共中央|中央政治局|国务院常务会议|党代会|两会|地方政府|省委|市委/,
      /\b(?:npc|cppcc|politburo|state council|communist party of china)\b/i,
    ],
    sourceBoost: ["gov_cn", "official_media_cn"],
  },
  policy: {
    patterns: [
      /政策|法规|条例|办法|规定|意见|通知|征求意见|监管规则|行政命令|法案|立法|修法/,
      /\b(?:policy|regulation|rules?|legislation|lawmakers?|executive order|bill|decree)\b/i,
    ],
    sourceBoost: ["gov_cn", "gov_intl"],
  },
  diplomacy: {
    patterns: [
      /外交|外长|峰会|会晤|访问|建交|断交|使馆|领事|双边关系|多边会谈|和平谈判|停火谈判/,
      /\b(?:diplomac\w*|foreign minister|summit|bilateral|embassy|consulate|peace talks?|ceasefire talks?)\b/i,
    ],
    sourceBoost: ["gov_cn", "gov_intl", "intl_org"],
  },
  defense: {
    patterns: [
      /国防|军队|军演|演习|武器|导弹|战机|军舰|航母|雷达|防空|军事部署|军费/,
      /\b(?:defen[cs]e|military|missiles?|warships?|fighter jets?|air defen[cs]e|drills?|deployment|pentagon)\b/i,
    ],
  },
  conflict: {
    patterns: [
      /战争|冲突|交火|空袭|袭击|炮击|轰炸|入侵|战斗|前线|停火|无人机袭击|导弹袭击|伤亡/,
      /\b(?:war|conflict|clashes?|airstrikes?|missile strikes?|drone strikes?|military strikes?|shelling|bombardment|invasion|battle|frontline|ceasefire|hostilities)\b/i,
    ],
    sourceBoost: ["party_media"],
  },
  intl_politics: {
    patterns: [
      /国际政治|政府危机|内阁|总理辞职|总统辞职|议会解散|政变|政治危机|反对党|执政联盟/,
      /\b(?:cabinet|parliament|government crisis|political crisis|coup|opposition party|governing coalition|prime minister resigns?)\b/i,
    ],
    sourceBoost: ["gov_intl", "intl_media", "local_media"],
  },
  election: {
    patterns: [
      /选举|大选|投票|计票|选票|候选人|初选|议会选举|总统选举|公投/,
      /\b(?:election|vote counting|ballots?|candidate|primary election|presidential election|parliamentary election|referendum|polling station)\b/i,
    ],
  },
  sanctions: {
    patterns: [
      /制裁|禁运|出口管制|资产冻结|黑名单|实体清单|二级制裁|关税惩罚/,
      /\b(?:sanctions?|embargo|export controls?|asset freeze|blacklist|entity list|secondary sanctions?)\b/i,
    ],
  },
  economy: {
    patterns: [
      /经济|贸易|关税|进出口|国内生产总值|增长率|通胀|消费|制造业|供应链|就业|失业率|房地产/,
      /\b(?:economy|economic growth|trade|tariffs?|imports?|exports?|gdp|inflation|consumer spending|manufacturing|supply chain|unemployment|real estate)\b/i,
    ],
    sourceBoost: ["market_media_cn", "data"],
  },
  energy: {
    patterns: [
      /能源|石油|原油|天然气|煤炭|电力|核电|光伏|风电|油价|欧佩克|炼油|液化天然气/,
      /\b(?:energy|oil|crude|natural gas|coal|electricity|nuclear power|solar|wind power|opec|refiner\w*|lng)\b/i,
    ],
  },
  finance: {
    patterns: [
      /金融|央行|利率|降息|加息|汇率|人民币|美元指数|股市|债券|银行|信贷|货币政策|证券/,
      /\b(?:finance|central bank|interest rates?|rate cut|rate hike|exchange rate|stock market|bonds?|banking|credit|monetary policy|securities)\b/i,
    ],
    sourceBoost: ["market_media_cn", "data"],
  },
  tech: {
    patterns: [
      /科技|芯片|半导体|互联网平台|数据安全|网络安全|量子计算|卫星|航天|监管科技|数字经济/,
      /\b(?:technology|tech sector|chips?|semiconductors?|cybersecurity|data security|quantum computing|satellite|spaceflight|digital economy)\b/i,
    ],
  },
  ai: {
    patterns: [
      /人工智能|生成式人工智能|大模型|机器学习|深度学习|算力|智能体|算法模型|神经网络/,
      /\b(?:artificial intelligence|generative ai|large language models?|llms?|machine learning|deep learning|ai agents?|neural networks?)\b/i,
    ],
  },
  society: {
    patterns: [
      /社会民生|居民|住房|养老|社保|人口|生育|婚姻|劳动者|工资|食品安全|消费者权益/,
      /\b(?:society|housing|pensions?|social security|population|birth rate|workers?|wages?|food safety|consumer rights?)\b/i,
    ],
  },
  health: {
    patterns: [
      /医疗|卫生|医院|疾病|疫情|病毒|疫苗|药品|公共卫生|感染|病例|世界卫生组织/,
      /\b(?:health|medical|hospital|disease|outbreak|virus|vaccines?|drugs?|public health|infections?|confirmed cases?|infection cases?|disease cases?|world health organization|w\.h\.o\.)\b/i,
    ],
    sourceBoost: ["intl_org", "data"],
  },
  education: {
    patterns: [
      /教育|学校|大学|高考|招生|教师|学生|课程|学费|校园/,
      /\b(?:education|schools?|universit(?:y|ies)|admissions?|teachers?|students?|curriculum|tuition|campus)\b/i,
    ],
  },
  climate: {
    patterns: [
      /气候|环境|碳排放|温室气体|全球变暖|极端天气|减排|生态|污染|可持续发展/,
      /\b(?:climate|environment|carbon emissions?|greenhouse gas|global warming|extreme weather|decarboni[sz]ation|pollution|sustainability)\b/i,
    ],
  },
  disaster: {
    patterns: [
      /地震|海啸|洪水|洪灾|山火|野火|台风|飓风|龙卷风|滑坡|泥石流|坍塌|爆炸|空难|事故/,
      /\b(?:earthquake|tsunami|floods?|wildfires?|typhoon|hurricane|tornado|landslide|collapse|explosion|plane crash|disaster|accident)\b/i,
    ],
    sourceBoost: ["local_media", "data"],
  },
  security: {
    patterns: [
      /公共安全|警方|警察|枪击|恐袭|恐怖袭击|绑架|人质|爆炸物|刑事案件|边境安全|执法/,
      /\b(?:public safety|police|shooting|terror(?:ism|ist attack)|kidnapping|hostages?|explosives?|criminal case|border security|law enforcement)\b/i,
    ],
    sourceBoost: ["local_media"],
  },
  intl_org: {
    patterns: [
      /联合国|安理会|国际组织|世界卫生组织|国际原子能机构|国际刑事法院|国际法院|红十字国际委员会|北约|欧盟委员会/,
      /\b(?:united nations|security council|international organization|iaea|icc|icj|icrc|nato|european commission)\b/i,
    ],
    sourceBoost: ["intl_org"],
  },
  investigation: {
    patterns: [
      /调查|核查|事实核查|审计|问责|腐败|涉嫌|起诉|指控|证据显示|卫星图像|开源情报|溯源/,
      /\b(?:investigat\w*|fact[- ]?check|audit|accountability|corruption|indicted|charged with|evidence shows|satellite imagery|open source intelligence|osint)\b/i,
    ],
    sourceBoost: ["factcheck", "data"],
  },
};

const TOPIC_ORDER = new Map<TopicKey, number>(TOPIC_KEYS.map((key, index) => [key, index]));

export function isTopicKey(value: string): value is TopicKey {
  return TOPIC_KEYS.includes(value as TopicKey);
}

function asInput(input: string | TopicClassificationInput): TopicClassificationInput {
  return typeof input === "string" ? { title: input } : input;
}

function scoreField(text: string, weight: number, patterns: readonly RegExp[], matches: Set<string>): number {
  if (!text) return 0;
  let score = 0;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (!match) continue;
    score += weight;
    matches.add(match[0].toLowerCase());
  }
  return score;
}

/** 返回完整主题评分，便于测试阈值和解释分类原因 */
export function classifyTopicScores(input: string | TopicClassificationInput): TopicScore[] {
  const value = asInput(input);
  const title = normalizeText(value.title).slice(0, 500);
  const excerpt = normalizeText(value.excerpt || "").slice(0, 1200);
  const body = normalizeText(value.bodyText || "").slice(0, 8000);
  const scores: TopicScore[] = [];

  for (const topic of TOPIC_KEYS) {
    const rule = TOPIC_RULES[topic];
    const matches = new Set<string>();
    let score = 0;
    score += scoreField(title, 3, rule.patterns, matches);
    score += scoreField(excerpt, 1.5, rule.patterns, matches);
    score += scoreField(body, 1, rule.patterns, matches);
    if (value.sourceCategory && rule.sourceBoost?.includes(value.sourceCategory) && score > 0) score += 0.35;
    if (score > 0) {
      scores.push({ topic, label: TOPIC_LABELS[topic], score: Number(score.toFixed(2)), matches: [...matches].sort() });
    }
  }

  return scores.sort((a, b) => b.score - a.score || (TOPIC_ORDER.get(a.topic) || 0) - (TOPIC_ORDER.get(b.topic) || 0));
}

/** 确定性主题分类：标题权重最高，正文中的单个弱命中不会单独入选 */
export function classifyTopics(
  input: string | TopicClassificationInput,
  options: TopicClassificationOptions = {}
): TopicKey[] {
  const maxTopics = Math.max(1, options.maxTopics ?? 5);
  const minScore = options.minScore ?? 2.5;
  return classifyTopicScores(input)
    .filter((item) => item.score >= minScore)
    .slice(0, maxTopics)
    .map((item) => item.topic);
}

export const classifyArticleTopics = classifyTopics;

/** 合并多批主题并按首次出现顺序去重 */
export function mergeTopics(...groups: readonly (readonly string[])[]): TopicKey[] {
  const seen = new Set<TopicKey>();
  const out: TopicKey[] = [];
  for (const group of groups) {
    for (const value of group) {
      if (!isTopicKey(value) || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
  }
  return out;
}

/** 聚合文章主题为事件主题，按出现文章数和最高单篇得分稳定排序 */
export function aggregateEventTopics(
  articles: readonly (string | TopicClassificationInput)[],
  maxTopics = 8
): TopicKey[] {
  const aggregate = new Map<TopicKey, { articles: number; score: number }>();
  for (const article of articles) {
    for (const item of classifyTopicScores(article)) {
      if (item.score < 2.5) continue;
      const current = aggregate.get(item.topic) || { articles: 0, score: 0 };
      current.articles += 1;
      current.score += item.score;
      aggregate.set(item.topic, current);
    }
  }
  return [...aggregate.entries()]
    .sort((a, b) => b[1].articles - a[1].articles || b[1].score - a[1].score || (TOPIC_ORDER.get(a[0]) || 0) - (TOPIC_ORDER.get(b[0]) || 0))
    .slice(0, Math.max(1, maxTopics))
    .map(([topic]) => topic);
}
