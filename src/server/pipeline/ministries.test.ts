import { describe, expect, it } from "vitest";
import { assignMinistries } from "./ministries";

const verifiedArticle = {
  sourceVerifStatus: "verified",
  sourceHealth: "ok",
  sourceCategory: "wire",
  isReprint: false,
};

describe("六部分派规则", () => {
  it("将冲突与外交事件主送兵部并会同礼部", () => {
    const result = assignMinistries({
      topics: ["diplomacy", "conflict"],
      claimStatuses: ["reported"],
      articles: [verifiedArticle, verifiedArticle],
      independentFamilies: 2,
    });

    expect(result[0]).toMatchObject({ ministry: "conflict_security", primary: true });
    expect(result.some((item) => item.ministry === "diplomacy_society")).toBe(true);
  });

  it("不会让转载数量虚增为来源多样性", () => {
    const result = assignMinistries({
      topics: ["economy"],
      claimStatuses: ["unverified", "unverified", "unverified"],
      articles: [
        { ...verifiedArticle, isReprint: true },
        { ...verifiedArticle, isReprint: true },
        { ...verifiedArticle, isReprint: true },
      ],
      independentFamilies: 1,
    });

    const identity = result.find((item) => item.ministry === "source_identity");
    expect(identity?.reasons.join(" ")).toContain("转载内容占比");
    expect(identity?.reasons.join(" ")).toContain("独立来源家族不足");
  });

  it("相同输入顺序变化不会改变输出", () => {
    const first = assignMinistries({
      topics: ["sanctions", "economy", "diplomacy"],
      claimStatuses: ["disputed", "reported"],
      articles: [verifiedArticle, { ...verifiedArticle, sourceCategory: "factcheck" }],
      independentFamilies: 2,
    });
    const second = assignMinistries({
      topics: ["diplomacy", "economy", "sanctions"],
      claimStatuses: ["reported", "disputed"],
      articles: [{ ...verifiedArticle, sourceCategory: "factcheck" }, verifiedArticle],
      independentFamilies: 2,
    });

    expect(second).toEqual(first);
  });
});
