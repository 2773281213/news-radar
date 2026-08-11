import { createHash, randomUUID } from "node:crypto";

/** SHA-256 十六进制 */
export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

/** 稳定短 ID（内容寻址） */
export function shortId(input: string, len = 16): string {
  return sha256Hex(input).slice(0, len);
}

/** 随机 ID */
export function randomId(len = 12): string {
  return randomUUID().replace(/-/g, "").slice(0, len);
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64 位哈希（SimHash 特征用） */
export function fnv1a64(str: string): bigint {
  let h = FNV_OFFSET;
  for (let i = 0; i < str.length; i++) {
    h ^= BigInt(str.charCodeAt(i));
    h = (h * FNV_PRIME) & MASK64;
  }
  return h;
}
