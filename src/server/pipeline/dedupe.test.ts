import { describe, expect, it } from "vitest";
import { classifyDuplicate, detectReprintFamily, detectReprintFamilyAsync, extractArticleAnchors, foldUnicodeDigits } from "./dedupe";

const publishedAt = "2026-07-29T00:00:00.000Z";

function article(overrides: Record<string, unknown> = {}) {
  return {
    id: "article-a",
    sourceId: "source-a",
    url: "https://example.com/a",
    normalizedUrl: "https://example.com/a",
    title: "Regional leaders approve a new emergency response framework",
    bodyText:
      "Regional leaders approved a new emergency response framework after a lengthy public meeting. " +
      "The framework defines funding, oversight, reporting requirements, implementation dates, and independent review procedures.",
    publishedAt,
    ...overrides,
  };
}

describe("article deduplication", () => {
  it("classifies changed content at the same canonical URL as an update", () => {
    const incoming = article({ id: "incoming", contentHash: "new-hash" });
    const candidate = article({ id: "existing", contentHash: "old-hash" });

    expect(classifyDuplicate(incoming, candidate)).toMatchObject({
      kind: "update",
      score: 1,
      candidateId: "existing",
    });
  });

  it("does not treat short similar headlines as independent corroboration", () => {
    const decision = classifyDuplicate(
      article({
        id: "incoming",
        sourceId: "source-b",
        url: "https://other.example/b",
        normalizedUrl: "https://other.example/b",
        title: "Government issues update",
        bodyText: "Update issued.",
      }),
      article({
        id: "existing",
        title: "Government issues update",
        bodyText: "Update issued.",
      })
    );

    expect(decision.kind).toBe("distinct");
    expect(decision.reasons).toContain("可比较文本过短，拒绝仅凭短标题判为转载");
  });

  it("groups full-text copies under one reprint family", () => {
    const incoming = article({
      id: "incoming",
      sourceId: "source-b",
      url: "https://other.example/copied",
      normalizedUrl: "https://other.example/copied",
      contentHash: "same-long-content-hash",
    });
    const candidate = article({
      id: "wire-root",
      contentHash: "same-long-content-hash",
    });

    expect(classifyDuplicate(incoming, candidate)).toMatchObject({
      kind: "reprint",
      reprintOf: "wire-root",
      wireFamily: "reprint:wire-root",
    });
  });

  it("blocks reprint folding when identity numbers conflict", () => {
    const sharedBody =
      "The operator published a detailed statement describing the route, departure time, passengers, response actions, " +
      "investigation process, supporting records, and additional operational information for the public.";
    const incoming = article({
      id: "incoming",
      sourceId: "source-b",
      url: "https://other.example/mu124",
      normalizedUrl: "https://other.example/mu124",
      title: "Flight MU124 delayed after inspection",
      bodyText: sharedBody,
      contentHash: "same-hash",
    });
    const candidate = article({
      id: "existing",
      title: "Flight MU123 delayed after inspection",
      bodyText: sharedBody,
      contentHash: "same-hash",
    });

    const decision = classifyDuplicate(incoming, candidate);
    expect(decision.kind).toBe("distinct");
    expect(decision.reasons).toContain("航班、法案、型号或灾害编号等身份数字冲突");
  });

  it("keeps chunked reprint selection equivalent to the synchronous path", async () => {
    const incoming = article({
      id: "incoming",
      sourceId: "source-b",
      url: "https://other.example/copied",
      normalizedUrl: "https://other.example/copied",
      contentHash: "same-long-content-hash",
    });
    const candidates = [
      { article: article({ id: "unrelated", publishedAt: "2026-06-01T00:00:00.000Z" }) },
      { article: article({ id: "wire-z", contentHash: "same-long-content-hash" }) },
      { article: article({ id: "wire-a", contentHash: "same-long-content-hash" }) },
    ];

    await expect(detectReprintFamilyAsync(incoming, candidates, {}, 1))
      .resolves.toEqual(detectReprintFamily(incoming, candidates));
  });
});

describe("numeric anchors", () => {
  it("normalizes Arabic-Indic digits and retains identity anchors", () => {
    expect(foldUnicodeDigits("۱۲۳ / ٤٥٦")).toBe("123 / 456");
    expect(extractArticleAnchors("Flight MU123 departs on 2026-07-29")).toMatchObject({
      dates: ["2026-07-29"],
      identityNumbers: ["flight:mu123"],
    });
  });
});
