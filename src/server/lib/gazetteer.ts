// ============================================================
// 实体词表（Gazetteer）：人物 / 机构 / 地点 / 组织的多语言别名
// 用途：实体识别、事件聚类锚点、多语言查询生成、当事方判定
// 说明：别名按语言组织；zh 为简体中文，其余为 ISO 639-1 代码
// ============================================================

export type EntityType = "person" | "org" | "place" | "country" | "group";

export interface GazetteerEntry {
  slug: string;
  type: EntityType;
  /** 关联国家/阵营代码（当事方判定用） */
  country?: string;
  /** 是否为冲突当事方的机构/组织 */
  party?: string;
  aliases: Partial<Record<string, string[]>>;
}

export const GAZETTEER: GazetteerEntry[] = [
  // ---------- 国家 ----------
  { slug: "china", type: "country", country: "cn", aliases: { zh: ["中国", "中华人民共和国", "中方"], en: ["China", "Chinese"], ar: ["الصين"], fa: ["چین"], ru: ["Китай"], he: ["סין"] } },
  { slug: "usa", type: "country", country: "us", aliases: { zh: ["美国", "美方"], en: ["United States", "U.S.", "US", "USA", "America"], ar: ["الولايات المتحدة", "أمريكا"], fa: ["آمریکا", "ایالات متحده"], ru: ["США"], he: ["ארצות הברית"] } },
  { slug: "russia", type: "country", country: "ru", aliases: { zh: ["俄罗斯", "俄方", "俄国"], en: ["Russia", "Russian"], ar: ["روسيا"], fa: ["روسیه"], ru: ["Россия"], uk: ["Росія"] } },
  { slug: "ukraine", type: "country", country: "ua", aliases: { zh: ["乌克兰", "乌方"], en: ["Ukraine", "Ukrainian"], ar: ["أوكرانيا"], ru: ["Украина"], uk: ["Україна"] } },
  { slug: "iran", type: "country", country: "ir", aliases: { zh: ["伊朗"], en: ["Iran", "Iranian"], ar: ["إيران"], fa: ["ایران"], he: ["איראן"], ru: ["Иран"] } },
  { slug: "israel", type: "country", country: "il", aliases: { zh: ["以色列", "以方"], en: ["Israel", "Israeli"], ar: ["إسرائيل"], fa: ["اسرائیل"], he: ["ישראל"], ru: ["Израиль"] } },
  { slug: "yemen", type: "country", country: "ye", aliases: { zh: ["也门"], en: ["Yemen", "Yemeni"], ar: ["اليمن"], fa: ["یمن"] } },
  { slug: "palestine", type: "country", country: "ps", aliases: { zh: ["巴勒斯坦"], en: ["Palestine", "Palestinian"], ar: ["فلسطين"], he: ["פלסטין"] } },
  { slug: "lebanon", type: "country", country: "lb", aliases: { zh: ["黎巴嫩"], en: ["Lebanon", "Lebanese"], ar: ["لبنان"], fa: ["لبنان"] } },
  { slug: "syria", type: "country", country: "sy", aliases: { zh: ["叙利亚"], en: ["Syria", "Syrian"], ar: ["سوريا"] } },
  { slug: "iraq", type: "country", country: "iq", aliases: { zh: ["伊拉克"], en: ["Iraq", "Iraqi"], ar: ["العراق"] } },
  { slug: "saudi", type: "country", country: "sa", aliases: { zh: ["沙特", "沙特阿拉伯"], en: ["Saudi Arabia", "Saudi"], ar: ["السعودية"] } },
  { slug: "uae", type: "country", country: "ae", aliases: { zh: ["阿联酋"], en: ["UAE", "United Arab Emirates"], ar: ["الإمارات"] } },
  { slug: "qatar", type: "country", country: "qa", aliases: { zh: ["卡塔尔"], en: ["Qatar"], ar: ["قطر"] } },
  { slug: "turkey", type: "country", country: "tr", aliases: { zh: ["土耳其"], en: ["Turkey", "Türkiye"], ar: ["تركيا"] } },
  { slug: "egypt", type: "country", country: "eg", aliases: { zh: ["埃及"], en: ["Egypt"], ar: ["مصر"] } },
  { slug: "north-korea", type: "country", country: "kp", aliases: { zh: ["朝鲜", "朝方"], en: ["North Korea", "DPRK"], ko: ["북한", "조선"], ru: ["КНДР"] } },
  { slug: "south-korea", type: "country", country: "kr", aliases: { zh: ["韩国", "韩方"], en: ["South Korea", "ROK"], ko: ["한국", "대한민국"] } },
  { slug: "japan", type: "country", country: "jp", aliases: { zh: ["日本", "日方"], en: ["Japan", "Japanese"], ja: ["日本"] } },
  { slug: "india", type: "country", country: "in", aliases: { zh: ["印度"], en: ["India", "Indian"] } },
  { slug: "pakistan", type: "country", country: "pk", aliases: { zh: ["巴基斯坦"], en: ["Pakistan"] } },
  { slug: "uk", type: "country", country: "gb", aliases: { zh: ["英国", "英方"], en: ["United Kingdom", "Britain", "UK", "British"] } },
  { slug: "france", type: "country", country: "fr", aliases: { zh: ["法国"], en: ["France", "French"], fr: ["France"] } },
  { slug: "germany", type: "country", country: "de", aliases: { zh: ["德国"], en: ["Germany", "German"], de: ["Deutschland"] } },
  { slug: "eu", type: "org", country: "eu", aliases: { zh: ["欧盟", "欧洲联盟"], en: ["European Union", "EU"], fr: ["Union européenne"], de: ["Europäische Union"] } },
  { slug: "taiwan-region", type: "place", country: "cn", aliases: { zh: ["台湾", "台海", "台湾地区"], en: ["Taiwan"], ja: ["台湾"] } },
  { slug: "hong-kong", type: "place", country: "cn", aliases: { zh: ["香港", "香港特区"], en: ["Hong Kong"] } },

  // ---------- 国际组织 ----------
  { slug: "un", type: "org", aliases: { zh: ["联合国"], en: ["United Nations", "UN"], ar: ["الأمم المتحدة"], fa: ["سازمان ملل"], ru: ["ООН"] } },
  { slug: "un-security-council", type: "org", aliases: { zh: ["安理会", "联合国安理会"], en: ["Security Council", "UNSC"], ar: ["مجلس الأمن"] } },
  { slug: "nato", type: "org", aliases: { zh: ["北约", "北大西洋公约组织"], en: ["NATO"], ru: ["НАТО"], fr: ["OTAN"] } },
  { slug: "iaea", type: "org", aliases: { zh: ["国际原子能机构"], en: ["IAEA"], fa: ["آژانس بین‌المللی انرژی اتمی"] } },
  { slug: "who", type: "org", aliases: { zh: ["世卫组织", "世界卫生组织"], en: ["WHO", "World Health Organization"] } },
  { slug: "wto", type: "org", aliases: { zh: ["世贸组织", "世界贸易组织"], en: ["WTO"] } },
  { slug: "opec", type: "org", aliases: { zh: ["欧佩克", "石油输出国组织"], en: ["OPEC"], ar: ["أوبك"] } },
  { slug: "icrc", type: "org", aliases: { zh: ["红十字国际委员会"], en: ["ICRC", "Red Cross"], ar: ["اللجنة الدولية للصليب الأحمر"] } },
  { slug: "icc", type: "org", aliases: { zh: ["国际刑事法院"], en: ["ICC", "International Criminal Court"] } },
  { slug: "icj", type: "org", aliases: { zh: ["国际法院"], en: ["ICJ", "International Court of Justice"] } },

  // ---------- 中国机构 ----------
  { slug: "cn-gov", type: "org", country: "cn", party: "cn", aliases: { zh: ["国务院", "中国政府"], en: ["State Council"] } },
  { slug: "cn-mofa", type: "org", country: "cn", party: "cn", aliases: { zh: ["中国外交部", "外交部"], en: ["Chinese Foreign Ministry", "China's Foreign Ministry"] } },
  { slug: "cn-mod", type: "org", country: "cn", party: "cn", aliases: { zh: ["中国国防部", "国防部"], en: ["Chinese Defense Ministry"] } },
  { slug: "cn-npc", type: "org", country: "cn", party: "cn", aliases: { zh: ["全国人大", "全国人民代表大会"], en: ["National People's Congress", "NPC"] } },
  { slug: "cn-ndrc", type: "org", country: "cn", party: "cn", aliases: { zh: ["发改委", "国家发展改革委"], en: ["NDRC"] } },
  { slug: "cn-mofcom", type: "org", country: "cn", party: "cn", aliases: { zh: ["商务部"], en: ["MOFCOM", "Commerce Ministry"] } },
  { slug: "pboc", type: "org", country: "cn", party: "cn", aliases: { zh: ["央行", "中国人民银行"], en: ["PBOC", "People's Bank of China"] } },
  { slug: "pla", type: "org", country: "cn", party: "cn", aliases: { zh: ["解放军", "中国人民解放军", "东部战区"], en: ["PLA", "People's Liberation Army"] } },

  // ---------- 美国机构 ----------
  { slug: "white-house", type: "org", country: "us", party: "us", aliases: { zh: ["白宫"], en: ["White House"], ar: ["البيت الأبيض"], fa: ["کاخ سفید"] } },
  { slug: "us-state-dept", type: "org", country: "us", party: "us", aliases: { zh: ["美国国务院"], en: ["State Department"] } },
  { slug: "pentagon", type: "org", country: "us", party: "us", aliases: { zh: ["五角大楼", "美国国防部"], en: ["Pentagon", "Defense Department"] } },
  { slug: "centcom", type: "org", country: "us", party: "us", aliases: { zh: ["美军中央司令部", "中央司令部"], en: ["CENTCOM", "Central Command"], ar: ["القيادة المركزية الأمريكية"] } },
  { slug: "us-congress", type: "org", country: "us", party: "us", aliases: { zh: ["美国国会"], en: ["Congress", "Senate", "House of Representatives"] } },
  { slug: "fed", type: "org", country: "us", aliases: { zh: ["美联储"], en: ["Federal Reserve", "Fed"] } },

  // ---------- 冲突相关组织 ----------
  { slug: "houthi", type: "group", country: "ye", party: "houthi", aliases: { zh: ["胡塞武装", "胡塞", "安萨尔真主"], en: ["Houthi", "Houthis", "Ansar Allah", "Ansarallah"], ar: ["الحوثيون", "أنصار الله", "الحوثي"], fa: ["انصارالله", "حوثی"] } },
  { slug: "hamas", type: "group", country: "ps", party: "hamas", aliases: { zh: ["哈马斯"], en: ["Hamas"], ar: ["حماس"], he: ["חמאס"], fa: ["حماس"] } },
  { slug: "hezbollah", type: "group", country: "lb", party: "hezbollah", aliases: { zh: ["真主党", "黎巴嫩真主党"], en: ["Hezbollah", "Hizbullah"], ar: ["حزب الله"], he: ["חיזבאללה"], fa: ["حزب‌الله"] } },
  { slug: "irgc", type: "org", country: "ir", party: "ir", aliases: { zh: ["伊斯兰革命卫队", "革命卫队"], en: ["IRGC", "Revolutionary Guard"], fa: ["سپاه پاسداران"], ar: ["الحرس الثوري"] } },
  { slug: "idf", type: "org", country: "il", party: "il", aliases: { zh: ["以色列国防军", "以军"], en: ["IDF", "Israel Defense Forces", "Israeli military"], he: ["צה\"ל", "צהל"], ar: ["الجيش الإسرائيلي"] } },
  { slug: "ru-mod", type: "org", country: "ru", party: "ru", aliases: { zh: ["俄罗斯国防部", "俄军"], en: ["Russian Defense Ministry", "Russian military"], ru: ["Минобороны России"] } },
  { slug: "ua-af", type: "org", country: "ua", party: "ua", aliases: { zh: ["乌克兰武装部队", "乌军"], en: ["Ukrainian Armed Forces", "Ukrainian military"], uk: ["ЗСУ"], ru: ["ВСУ"] } },
  { slug: "kremlin", type: "org", country: "ru", party: "ru", aliases: { zh: ["克里姆林宫"], en: ["Kremlin"], ru: ["Кремль"] } },

  // ---------- 人物 ----------
  { slug: "xi-jinping", type: "person", country: "cn", aliases: { zh: ["习近平"], en: ["Xi Jinping"], ru: ["Си Цзиньпин"] } },
  { slug: "li-qiang", type: "person", country: "cn", aliases: { zh: ["李强"], en: ["Li Qiang"] } },
  { slug: "wang-yi", type: "person", country: "cn", aliases: { zh: ["王毅"], en: ["Wang Yi"] } },
  { slug: "trump", type: "person", country: "us", aliases: { zh: ["特朗普", "川普"], en: ["Trump", "Donald Trump"], ar: ["ترامب"], fa: ["ترامپ"], ru: ["Трамп"], he: ["טראמפ"] } },
  { slug: "vance", type: "person", country: "us", aliases: { zh: ["万斯"], en: ["Vance", "JD Vance"] } },
  { slug: "rubio", type: "person", country: "us", aliases: { zh: ["鲁比奥"], en: ["Rubio", "Marco Rubio"] } },
  { slug: "putin", type: "person", country: "ru", aliases: { zh: ["普京"], en: ["Putin", "Vladimir Putin"], ru: ["Путин"], uk: ["Путін"] } },
  { slug: "lavrov", type: "person", country: "ru", aliases: { zh: ["拉夫罗夫"], en: ["Lavrov"], ru: ["Лавров"] } },
  { slug: "zelensky", type: "person", country: "ua", aliases: { zh: ["泽连斯基"], en: ["Zelensky", "Zelenskyy"], uk: ["Зеленський"], ru: ["Зеленский"] } },
  { slug: "netanyahu", type: "person", country: "il", aliases: { zh: ["内塔尼亚胡"], en: ["Netanyahu"], he: ["נתניהו"], ar: ["نتنياهو"] } },
  { slug: "khamenei", type: "person", country: "ir", aliases: { zh: ["哈梅内伊"], en: ["Khamenei"], fa: ["خامنه‌ای"], ar: ["خامنئي"] } },
  { slug: "pezeshkian", type: "person", country: "ir", aliases: { zh: ["佩泽希齐扬", "佩泽什基安"], en: ["Pezeshkian"], fa: ["پزشکیان"] } },
  { slug: "kim-jong-un", type: "person", country: "kp", aliases: { zh: ["金正恩"], en: ["Kim Jong Un", "Kim Jong-un"], ko: ["김정은"] } },
  { slug: "guterres", type: "person", aliases: { zh: ["古特雷斯"], en: ["Guterres", "António Guterres"], ar: ["غوتيريش"] } },
  { slug: "von-der-leyen", type: "person", country: "eu", aliases: { zh: ["冯德莱恩"], en: ["von der Leyen"], de: ["von der Leyen"] } },
  { slug: "takaichi", type: "person", country: "jp", aliases: { zh: ["高市早苗"], en: ["Takaichi", "Sanae Takaichi"], ja: ["高市早苗"] } },
  { slug: "lee-jae-myung", type: "person", country: "kr", aliases: { zh: ["李在明"], en: ["Lee Jae-myung"], ko: ["이재명"] } },
  { slug: "modi", type: "person", country: "in", aliases: { zh: ["莫迪"], en: ["Modi", "Narendra Modi"] } },
  { slug: "starmer", type: "person", country: "gb", aliases: { zh: ["斯塔默"], en: ["Starmer", "Keir Starmer"] } },
  { slug: "macron", type: "person", country: "fr", aliases: { zh: ["马克龙"], en: ["Macron"], fr: ["Macron"] } },
  { slug: "merz", type: "person", country: "de", aliases: { zh: ["默茨"], en: ["Merz", "Friedrich Merz"], de: ["Merz"] } },

  // ---------- 关键地点 ----------
  { slug: "red-sea", type: "place", aliases: { zh: ["红海"], en: ["Red Sea"], ar: ["البحر الأحمر"], fa: ["دریای سرخ"], he: ["ים סוף"] } },
  { slug: "hormuz", type: "place", aliases: { zh: ["霍尔木兹海峡"], en: ["Strait of Hormuz", "Hormuz"], fa: ["تنگه هرمز"], ar: ["مضيق هرمز"] } },
  { slug: "gaza", type: "place", country: "ps", aliases: { zh: ["加沙", "加沙地带"], en: ["Gaza"], ar: ["غزة"], he: ["עזה"] } },
  { slug: "south-china-sea", type: "place", aliases: { zh: ["南海", "南中国海"], en: ["South China Sea"] } },
  { slug: "crimea", type: "place", aliases: { zh: ["克里米亚"], en: ["Crimea"], ru: ["Крым"], uk: ["Крим"] } },
  { slug: "donbas", type: "place", aliases: { zh: ["顿巴斯", "顿涅茨克", "卢甘斯克"], en: ["Donbas", "Donetsk", "Luhansk"], ru: ["Донбасс"], uk: ["Донбас"] } },
  { slug: "sanaa", type: "place", country: "ye", aliases: { zh: ["萨那"], en: ["Sanaa", "Sana'a"], ar: ["صنعاء"] } },
  { slug: "tehran", type: "place", country: "ir", aliases: { zh: ["德黑兰"], en: ["Tehran"], fa: ["تهران"], ar: ["طهران"] } },
  { slug: "kyiv", type: "place", country: "ua", aliases: { zh: ["基辅"], en: ["Kyiv", "Kiev"], uk: ["Київ"], ru: ["Киев"] } },
  { slug: "moscow", type: "place", country: "ru", aliases: { zh: ["莫斯科"], en: ["Moscow"], ru: ["Москва"] } },
  { slug: "beijing", type: "place", country: "cn", aliases: { zh: ["北京"], en: ["Beijing"] } },
  { slug: "washington", type: "place", country: "us", aliases: { zh: ["华盛顿"], en: ["Washington"] } },
];

/** slug → 词表项 */
export const GAZETTEER_BY_SLUG: Map<string, GazetteerEntry> = new Map(GAZETTEER.map((g) => [g.slug, g]));

/** 实体的中文显示名（取 zh 第一个别名，缺省用 en/slug） */
export function entityLabel(slug: string): string {
  const g = GAZETTEER_BY_SLUG.get(slug);
  if (!g) return slug;
  return g.aliases.zh?.[0] || g.aliases.en?.[0] || slug;
}
