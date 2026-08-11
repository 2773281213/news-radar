import { describe, expect, it } from "vitest";
import { validateResolvedHost } from "./ssrf";

describe("validateResolvedHost", () => {
  it("拒绝解析到内网地址的域名", async () => {
    const result = await validateResolvedHost(
      "example.test",
      false,
      50,
      async () => [{ address: "127.0.0.1", family: 4 }]
    );

    expect(result).toEqual({ ok: false, reason: "域名解析到内网地址 127.0.0.1" });
  });

  it("允许解析到公网地址的域名", async () => {
    const result = await validateResolvedHost(
      "example.test",
      false,
      50,
      async () => [{ address: "93.184.216.34", family: 4 }]
    );

    expect(result).toEqual({ ok: true });
  });

  it("DNS 解析不返回时会在期限内失败", async () => {
    const startedAt = Date.now();
    const result = await validateResolvedHost(
      "stalled.example",
      false,
      15,
      () => new Promise(() => undefined)
    );

    expect(result).toEqual({ ok: false, reason: "DNS 解析超时" });
    expect(Date.now() - startedAt).toBeLessThan(250);
  });
});
