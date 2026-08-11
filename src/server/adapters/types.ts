// 采集适配器公共类型
import type { KV } from "../lib/kv";
import type { SafeFetchOptions } from "../lib/ssrf";

/** 适配器抓到的原始条目（尚未清洗、去重、入库） */
export interface FetchedItem {
  url: string;
  guid?: string | null;
  title: string;
  /** 原始 HTML 摘要/正文，入库前统一清洗为纯文本 */
  summaryHtml?: string | null;
  contentHtml?: string | null;
  author?: string | null;
  publishedAt?: string | null; // UTC ISO
  updatedAt?: string | null;
  imageUrl?: string | null;
  lang?: string | null;
  extra?: Record<string, unknown>;
}

export interface AdapterResult {
  items: FetchedItem[];
  httpStatus: number;
  error?: string;
}

/** 适配器运行上下文 */
export interface AdapterContext {
  kv: KV;
  fetchOpts: SafeFetchOptions;
  rsshubBase: string;
  /** 无时区时间的默认 UTC 偏移（分钟），按来源国家推断 */
  assumeOffsetMin: number;
}
