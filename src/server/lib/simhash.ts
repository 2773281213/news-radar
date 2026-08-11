import { fnv1a64 } from "./hash";
import { tokensOf } from "./textsim";

/** 64 位 SimHash（返回 16 位十六进制字符串） */
export function simhash64(text: string): string {
  const weights = new Map<string, number>();
  for (const t of tokensOf(text)) weights.set(t, (weights.get(t) || 0) + 1);
  const v = new Array<number>(64).fill(0);
  for (const [token, w] of weights) {
    const h = fnv1a64(token);
    for (let i = 0; i < 64; i++) {
      if ((h >> BigInt(i)) & 1n) v[i] += w;
      else v[i] -= w;
    }
  }
  let out = 0n;
  for (let i = 0; i < 64; i++) if (v[i] > 0) out |= 1n << BigInt(i);
  return out.toString(16).padStart(16, "0");
}

/** 两个 SimHash 的汉明距离 */
export function hamming(hexA: string, hexB: string): number {
  let x = BigInt("0x" + hexA) ^ BigInt("0x" + hexB);
  let count = 0;
  while (x > 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
