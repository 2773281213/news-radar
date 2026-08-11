// 轻量语言识别：按字符区块统计 + 拉丁语系停用词区分
// 覆盖：zh / ja / ko / en / ar / fa / he / ru / fr / de / es，其余归 other

const RANGES: [RegExp, string][] = [
  [/[぀-ヿ]/g, "kana"], // 日文假名
  [/[가-힯]/g, "hangul"],
  [/[一-鿿㐀-䶿]/g, "han"],
  [/[֐-׿]/g, "he"],
  [/[؀-ۿݐ-ݿ]/g, "arabic"],
  [/[Ѐ-ӿ]/g, "ru"],
];

// 波斯语特有字符（区分 ar / fa）
const FA_CHARS = /[پچژگیک]/;

const STOP: Record<string, RegExp> = {
  fr: /\b(le|la|les|des|une|est|dans|pour|avec|sur|qui|pas)\b/gi,
  de: /\b(der|die|das|und|ist|nicht|mit|ein|eine|für|auf|den)\b/gi,
  es: /\b(el|la|los|las|una|es|en|por|con|para|que|del)\b/gi,
  en: /\b(the|of|and|to|in|is|for|that|with|on|as|are)\b/gi,
};

export function detectLang(text: string, hint?: string | null): string {
  const s = text.slice(0, 2000);
  if (!s.trim()) return hint || "other";
  const counts: Record<string, number> = {};
  let total = 0;
  for (const [re, key] of RANGES) {
    const m = s.match(re);
    counts[key] = m ? m.length : 0;
    total += counts[key];
  }
  const letters = (s.match(/[a-zA-Z]/g) || []).length;

  if (counts.kana > 2) return "ja";
  if (counts.hangul > 2) return "ko";
  if (counts.han > 3 && counts.han > letters) return "zh";
  if (counts.he > 3) return "he";
  if (counts.arabic > 3) return FA_CHARS.test(s) ? "fa" : "ar";
  if (counts.ru > 3) return "ru";

  if (letters > 10) {
    let best = "en";
    let bestScore = 0;
    for (const [langKey, re] of Object.entries(STOP)) {
      const m = s.match(re);
      const score = m ? m.length : 0;
      if (score > bestScore) {
        bestScore = score;
        best = langKey;
      }
    }
    return best;
  }
  if (counts.han > 0) return "zh";
  return hint || "other";
}
