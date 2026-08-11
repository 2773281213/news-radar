import type { ClaimStatus, DepartmentCode, MinistryCode, SourceCategory, SourceHealth, WorkflowState } from "./types";

/** 来源类别中文标签 */
export const CATEGORY_LABELS: Record<SourceCategory, string> = {
  gov_cn: "中国官方",
  official_media_cn: "中国官方媒体",
  market_media_cn: "中国市场化媒体",
  social_cn: "中国社交账号",
  gov_intl: "外国政府机构",
  intl_org: "国际组织",
  wire: "通讯社",
  intl_media: "国际媒体",
  local_media: "本地媒体",
  party_media: "当事方媒体",
  social: "社交账号",
  data: "公开数据",
  factcheck: "事实核查",
};

/** Claim 状态中文标签 */
export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  reported: "有来源报道",
  unverified: "待核实",
  partially_corroborated: "部分佐证",
  corroborated: "已交叉确认",
  disputed: "存在争议",
  refuted: "已被反驳",
  outdated: "已过时",
};

/** 来源健康状态中文标签 */
export const HEALTH_LABELS: Record<SourceHealth, string> = {
  ok: "正常",
  degraded: "波动",
  failing: "失败",
  disabled: "停用",
  unknown: "未知",
};

/** 当事方标签（用于冲突事件的多方说法分组） */
export const PARTY_LABELS: Record<string, string> = {
  cn: "中国官方",
  us: "美国官方",
  ru: "俄罗斯官方",
  ua: "乌克兰官方",
  ir: "伊朗官方",
  il: "以色列官方",
  houthi: "胡塞武装（安萨尔真主）",
  hamas: "哈马斯",
  hezbollah: "真主党",
  ye_gov: "也门国际承认政府",
  sa: "沙特官方",
  kp: "朝鲜官方",
  kr: "韩国官方",
  eu: "欧盟",
  un: "联合国",
  media: "媒体报道",
  local: "当地来源",
  other: "其他相关方",
};

/** 主题标签 */
export const TOPIC_LABELS: Record<string, string> = {
  domestic_politics: "国内时政",
  policy: "政策法规",
  diplomacy: "外交",
  defense: "国防安全",
  conflict: "战争冲突",
  intl_politics: "国际政治",
  election: "选举政局",
  sanctions: "制裁",
  economy: "经济贸易",
  energy: "能源",
  finance: "金融",
  tech: "科技监管",
  ai: "人工智能",
  society: "社会民生",
  health: "医疗卫生",
  education: "教育",
  climate: "气候环境",
  disaster: "灾害事故",
  security: "公共安全",
  intl_org: "国际组织",
  investigation: "调查核查",
};

export const DEPARTMENT_LABELS: Record<DepartmentCode, string> = {
  zhongshu: "中书省",
  menxia: "门下省",
  shangshu: "尚书省",
};

export const MINISTRY_LABELS: Record<MinistryCode, string> = {
  source_identity: "吏部",
  economy: "户部",
  diplomacy_society: "礼部",
  conflict_security: "兵部",
  law_factcheck: "刑部",
  technology_infrastructure_disaster: "工部",
};

export const MINISTRY_SLUGS: Record<MinistryCode, string> = {
  source_identity: "personnel",
  economy: "revenue",
  diplomacy_society: "rites",
  conflict_security: "war",
  law_factcheck: "justice",
  technology_infrastructure_disaster: "works",
};

export const MINISTRY_DESCRIPTIONS: Record<MinistryCode, string> = {
  source_identity: "来源身份、所有权、转载家族与采集健康",
  economy: "经济、财政、金融、贸易与能源",
  diplomacy_society: "外交、国际组织、社会、医疗与教育",
  conflict_security: "战争、国防、公共安全与制裁",
  law_factcheck: "政策法律、调查问责、争议与事实核查",
  technology_infrastructure_disaster: "科技、人工智能、基础设施、气候与灾害",
};

export const WORKFLOW_STATE_LABELS: Record<WorkflowState, string> = {
  pending: "待拟稿",
  proposed: "中书拟稿",
  remanded: "门下封驳",
  approved: "门下准奏",
  dispatched: "尚书执行",
  completed: "已成报",
  failed: "执行异常",
};

/** 首页栏目 */
export const EVENT_TABS = [
  { key: "breaking", label: "正在发生" },
  { key: "domestic", label: "今日国内" },
  { key: "intl", label: "今日国际" },
  { key: "diplomacy", label: "外交与安全" },
  { key: "economy", label: "政策与经济" },
] as const;

/** 通用免责/方法论声明 */
export const PARTY_DISCLAIMER =
  "这是相关当事方发布的声明，目前不代表其中所有内容已经得到独立证实。";

export const MT_DISCLAIMER = "以下为机器翻译，仅供参考，请以原文为准。";

/** 简报时间（默认时区下的本地时刻） */
export const BRIEFING_SCHEDULE = {
  morning: "07:00",
  noon: "12:30",
  evening: "19:00",
} as const;
