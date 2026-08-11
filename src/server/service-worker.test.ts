import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(resolve(process.cwd(), "public", "sw.js"), "utf8");

describe("Service Worker release safety", () => {
  it("does not pin the root HTML in a cache-first shell list", () => {
    expect(source).toContain('const SHELL_CACHE = "nr-shell-v4"');
    expect(source).toContain('const DATA_CACHE = "nr-data-v3"');
    expect(source).toContain('const SHELL_URLS = ["/manifest.webmanifest"');
    expect(source).not.toMatch(/SHELL_URLS\s*=\s*\[\s*["']\/["']/);
  });

  it("handles navigations network-first with an offline-only fallback", () => {
    const navigationBlock = source.slice(
      source.indexOf('if (e.request.mode === "navigate")'),
      source.indexOf("// 简报接口"),
    );
    expect(navigationBlock).toContain('fetch(e.request, { cache: "no-store" })');
    expect(navigationBlock).toContain("caches.match(NAVIGATION_FALLBACK)");
    expect(navigationBlock.indexOf("fetch(e.request")).toBeLessThan(navigationBlock.indexOf("caches.match"));
  });

  it("keeps non-briefing APIs outside the cache", () => {
    expect(source).toContain('if (url.pathname.startsWith("/api/")) return;');
  });
});
