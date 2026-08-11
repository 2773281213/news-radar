import { describe, expect, it } from "vitest";
import {
  extractCasualtyMentions,
  extractClaims,
  parseHumanNumber,
  type ClaimExtractionInput,
} from "./claims";
import { evaluateClaimStatus, handleCasualtyNumberConflicts } from "./verify";

const partySource: ClaimExtractionInput["source"] = {
  id: "party-source",
  name: "冲突当事方新闻办公室",
  category: "party_media",
  adapter: "rss",
  isParty: true,
  partyOf: "party-a",
  isPrimary: true,
};

describe("claim extraction", () => {
  it("parses multilingual human-readable numbers", () => {
    expect(parseHumanNumber("2.5万")).toBe(25_000);
    expect(parseHumanNumber("۱۲")).toBe(12);
    expect(parseHumanNumber("1.2 million")).toBe(1_200_000);
  });

  it("extracts casualty values without averaging competing figures", () => {
    const mentions = extractCasualtyMentions("截至7月29日，至少25名平民死亡，41人受伤。");

    expect(mentions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ number: 25, unit: "civilian_deaths", qualifier: "at_least" }),
        expect.objectContaining({ number: 41, unit: "injuries", qualifier: "exact" }),
      ])
    );
  });

  it("keeps a party statement separate from its underlying casualty claim", () => {
    const claims = extractClaims({
      eventId: "event-1",
      articleId: "article-1",
      title: "冲突当事方新闻办公室表示，至少25名平民死亡。",
      firstSeenAt: "2026-07-29T01:00:00.000Z",
      publishedAt: "2026-07-29T00:30:00.000Z",
      source: partySource,
    });

    const statement = claims.find((claim) => claim.type === "statement");
    const casualty = claims.find((claim) => claim.type === "casualty");
    expect(statement).toMatchObject({
      status: "reported",
      proposition: "statement",
      evidenceStance: "supports",
    });
    expect(casualty).toMatchObject({
      status: "unverified",
      proposition: "underlying_fact",
      evidenceStance: "reports",
      subjectNumber: 25,
    });
  });
});

describe("claim verification", () => {
  const claim = {
    id: "claim-1",
    eventId: "event-1",
    text: "救援机构已抵达现场",
    type: "event" as const,
  };

  it("requires two independent supporting families for corroboration", () => {
    const result = evaluateClaimStatus(claim, [
      { articleId: "a", stance: "supports", sourceId: "source-a", hasPrimary: true },
      { articleId: "b", stance: "supports", sourceId: "source-b" },
    ]);

    expect(result.status).toBe("corroborated");
    expect(result.rationale.independentChains).toBe(2);
  });

  it("does not count repeated reports or common ownership as independent support", () => {
    const reportsOnly = evaluateClaimStatus(claim, [
      { articleId: "a", stance: "reports", sourceId: "source-a" },
      { articleId: "b", stance: "reports", sourceId: "source-b" },
    ]);
    const commonOwner = evaluateClaimStatus(claim, [
      {
        articleId: "c",
        stance: "supports",
        sourceId: "outlet-a",
        sourceFamilyId: "media-group",
        sourceFamilyKind: "ownership",
      },
      {
        articleId: "d",
        stance: "supports",
        sourceId: "outlet-b",
        sourceFamilyId: "media-group",
        sourceFamilyKind: "ownership",
      },
    ]);

    expect(reportsOnly.status).toBe("reported");
    expect(reportsOnly.rationale.independentChains).toBe(2);
    expect(commonOwner.status).toBe("partially_corroborated");
    expect(commonOwner.rationale.independentChains).toBe(1);
  });

  it("marks incompatible casualty figures from different parties as disputed", () => {
    const checkedAt = "2026-07-29T02:00:00.000Z";
    const result = handleCasualtyNumberConflicts(
      [
        {
          id: "cas-a",
          eventId: "event-1",
          text: "甲方称死亡10人",
          type: "casualty",
          claimedBy: "甲方",
          party: "party-a",
          subjectNumber: 10,
          numberUnit: "deaths",
          firstSeenAt: "2026-07-29T01:00:00.000Z",
          status: "unverified",
        },
        {
          id: "cas-b",
          eventId: "event-1",
          text: "乙方称死亡30人",
          type: "casualty",
          claimedBy: "乙方",
          party: "party-b",
          subjectNumber: 30,
          numberUnit: "deaths",
          firstSeenAt: "2026-07-29T01:05:00.000Z",
          status: "unverified",
        },
      ],
      { checkedAt }
    );

    expect(result.conflicts).toHaveLength(1);
    expect(result.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "cas-a", status: "disputed" }),
        expect.objectContaining({ id: "cas-b", status: "disputed" }),
      ])
    );
  });
});
