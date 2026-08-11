// 文本规范化 / 分词 / 相似度，服务于去重、聚类与全文检索
const CJK_RE = /[一-鿿㐀-䶿]/;
const PUNCT_RE = /[\s　!-/:-@[-`{-~。，、；：？！“”‘’（）《》【】…—·「」『』〈〉～]+/g;

/** 全角转半角 + 小写 */
export function foldWidth(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - 0xfee0);
    else if (code === 0x3000) out += " ";
    else out += ch;
  }
  return out.toLowerCase();
}

/** 标题规范化：小写、全角折叠、去标点空白 */
export function normalizeTitle(t: string): string {
  return foldWidth(t).replace(PUNCT_RE, "");
}

/** 通用规范化（保留词间单空格） */
export function normalizeText(t: string): string {
  return foldWidth(t).replace(PUNCT_RE, " ").trim();
}

/**
 * 分词：拉丁词 + 中日韩字符二元组（bigram）
 * 中文无空格分词，FTS 与相似度都基于 bigram
 */
export function tokensOf(text: string): string[] {
  const norm = normalizeText(text);
  const tokens: string[] = [];
  let latinBuf = "";
  let prevCjk = "";
  const flush = () => {
    if (latinBuf.length > 0) {
      if (latinBuf.length > 1 || /\d/.test(latinBuf)) tokens.push(latinBuf);
      latinBuf = "";
    }
  };
  for (const ch of norm) {
    if (ch === " ") {
      flush();
      prevCjk = "";
      continue;
    }
    if (CJK_RE.test(ch)) {
      flush();
      if (prevCjk) tokens.push(prevCjk + ch);
      else tokens.push(ch); // 单字也入表，保证单字实体可检索
      prevCjk = ch;
    } else {
      prevCjk = "";
      latinBuf += ch;
    }
  }
  flush();
  return tokens;
}

/** FTS 预分词：写入与查询共用同一转换 */
export function ftsTokenize(text: string): string {
  return tokensOf(text).join(" ");
}

/** Jaccard 相似度（基于 tokensOf 的集合） */
export function jaccard(a: string, b: string): number {
  const sa = new Set(tokensOf(a));
  const sb = new Set(tokensOf(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 数字序列提取（标题中的数字差异是“同名不同事件”的强信号） */
export function extractNumbers(text: string): string[] {
  return (text.match(/\d+(?:\.\d+)?/g) || []).slice(0, 10);
}
