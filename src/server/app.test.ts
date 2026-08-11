import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createContainer, type ServiceContainer } from "./container";
import type { MenxiaReviewDTO, ShangshuDispatchDTO, ZhongshuProposalDTO } from "../shared/types";
import { resolveEvent, resolveEventAsync } from "./pipeline/cluster";
import { detectReprintFamily } from "./pipeline/dedupe";

describe("News Radar API", () => {
  let services: ServiceContainer;
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    services = createContainer(
      loadConfig({
        DATA_DIR: ":memory:",
        PUBLIC_BASE_URL: "https://news.example.test",
        ADMIN_TOKEN: "test-admin-token",
        AI_PROVIDER: "none",
      })
    );
    app = createApp(services);
  });

  afterAll(() => {
    services.close();
  });

  it("reports database and seeded source registry health", async () => {
    const readyResponse = await app.request("http://local.test/api/ready");
    const response = await app.request("http://local.test/api/health");
    const body = (await response.json()) as {
      counts: { sources: number };
      [key: string]: unknown;
    };

    expect(readyResponse.status).toBe(200);
    expect(await readyResponse.json()).toMatchObject({ ok: true, version: "0.2.0" });
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      db: true,
      version: "0.2.0",
      scheduler: { running: false, lastTickAt: null },
      workflow: { backlog: 0, running: 0, remanded: 0, failed: 0, completed: 0 },
    });
    expect(body.counts.sources).toBeGreaterThan(0);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("uses a covering index for workflow health aggregation", () => {
    const plan = services.raw.prepare(`
      EXPLAIN QUERY PLAN
      SELECT
        SUM(CASE WHEN status IN ('pending','proposed','approved','dispatched') THEN 1 ELSE 0 END) AS backlog,
        SUM(CASE WHEN status = 'remanded' THEN 1 ELSE 0 END) AS remanded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        MAX(completed_at) AS last_completed_at
      FROM workflow_cases INDEXED BY idx_workflow_cases_health
    `).all() as Array<{ detail: string }>;

    expect(plan.some((row) => row.detail.includes("COVERING INDEX idx_workflow_cases_health"))).toBe(true);
    expect(services.raw.pragma("wal_autocheckpoint", { simple: true })).toBe(100);
  });

  it("projects only the fields required by article dedupe and event clustering", async () => {
    const at = new Date().toISOString();
    const since = new Date(Date.parse(at) - 60_000).toISOString();
    const sourceId = "src_candidate_projection";
    services.raw.prepare(`
      INSERT OR IGNORE INTO sources(
        id, name, adapter, category, family_id, is_primary, verif_status, health, created_at, updated_at
      ) VALUES (?, '候选投影测试源', 'rss', 'wire', 'family-candidate-projection', 1, 'verified', 'ok', ?, ?)
    `).run(sourceId, at, at);
    const article = (await services.articles.insert({
      id: "art_candidate_projection",
      sourceId,
      url: "https://example.test/candidate-projection",
      canonicalUrl: null,
      normalizedUrl: "https://example.test/candidate-projection",
      guid: null,
      title: "候选投影保留去重所需正文",
      titleNorm: "候选投影保留去重所需正文",
      lang: "zh",
      publishedAt: at,
      srcUpdatedAt: at,
      firstSeenAt: at,
      bodyText: "这是用于验证转载判定行为保持一致的足够长正文，包含多个稳定词组与完整上下文。".repeat(8),
      excerpt: "候选投影测试摘要",
      contentHash: "hash-candidate-projection",
      simhash: null,
      extra: { deliberatelyLargeUnusedPayload: "x".repeat(20_000) },
    })).article;
    const event = await services.events.create({
      title: "候选投影聚类测试事件",
      firstAt: at,
      countries: ["cn"],
      topics: ["technology"],
      entities: [{ slug: "candidate-projection", count: 2 }],
    });
    services.raw.prepare("UPDATE events SET summary = ? WHERE id = ?")
      .run(JSON.stringify({ deliberatelyLargeUnusedPayload: "y".repeat(20_000) }), event.id);

    const articleCandidate = (await services.articles.recentCandidates(since, 50)).find((row) => row.id === article.id);
    const eventCandidate = (await services.events.recentCandidates(since, 50)).find((row) => row.id === event.id);
    if (!articleCandidate || !eventCandidate) throw new Error("未读取到候选投影测试数据");

    expect(Object.keys(articleCandidate).sort()).toEqual([
      "bodyText", "canonicalUrl", "contentHash", "excerpt", "firstSeenAt", "guid", "id", "isReprint", "normalizedUrl",
      "publishedAt", "reprintOf", "simhash", "sourceId", "srcUpdatedAt", "title", "titleNorm", "url", "wireFamily",
    ].sort());
    expect(Object.keys(eventCandidate).sort()).toEqual([
      "countries", "entities", "firstAt", "id", "lastUpdateAt", "oneLiner", "status", "title", "topics", "trackMode",
    ].sort());
    expect(articleCandidate).toMatchObject({
      id: article.id,
      sourceId,
      normalizedUrl: article.normalizedUrl,
      title: article.title,
      bodyText: article.bodyText,
      contentHash: article.contentHash,
      firstSeenAt: at,
    });
    expect(eventCandidate).toMatchObject({
      id: event.id,
      title: event.title,
      topics: ["technology"],
      countries: ["cn"],
      entities: [{ slug: "candidate-projection", count: 2 }],
      firstAt: at,
    });
    expect(articleCandidate).not.toHaveProperty("extra");
    expect(eventCandidate).not.toHaveProperty("summary");

    const incoming = {
      ...article,
      id: "art_candidate_projection_incoming",
      sourceId: "src_candidate_projection_incoming",
      url: "https://example.test/candidate-projection-copy",
      normalizedUrl: "https://example.test/candidate-projection-copy",
      guid: null,
    };
    expect(detectReprintFamily(incoming, [{ article: articleCandidate }]))
      .toEqual(detectReprintFamily(incoming, [{ article }]));
    const clusterInput = {
      id: "art_cluster_projection_incoming",
      title: event.title,
      titleNorm: event.title,
      bodyText: "候选投影聚类测试事件出现新的后续报道。",
      publishedAt: at,
      firstSeenAt: at,
    };
    expect(resolveEvent(clusterInput, [eventCandidate])).toEqual(resolveEvent(clusterInput, [event]));
    await expect(resolveEventAsync(clusterInput, [eventCandidate], {}, 1))
      .resolves.toEqual(resolveEvent(clusterInput, [eventCandidate]));
    services.raw.prepare("UPDATE events SET track_mode = 'breaking', importance = 100 WHERE id = ?").run(event.id);
    expect(services.events.recentBreakingEventIds(since, 20)).toContain(event.id);
  });

  it("batches claim evidence without mixing evidence between claims", async () => {
    const at = new Date().toISOString();
    const insertSource = services.raw.prepare(`
      INSERT OR IGNORE INTO sources(
        id, name, adapter, category, family_id, is_primary, verif_status, health, created_at, updated_at
      ) VALUES (?, ?, 'rss', 'data', ?, 1, 'verified', 'ok', ?, ?)
    `);
    insertSource.run("src_claim_batch_a", "证据批量测试源 A", "family-claim-batch-a", at, at);
    insertSource.run("src_claim_batch_b", "证据批量测试源 B", "family-claim-batch-b", at, at);
    const event = await services.events.create({
      title: "Claim 证据批量装载测试事件",
      firstAt: at,
      countries: [],
      topics: ["policy"],
      entities: [],
    });
    for (const suffix of ["b", "a"] as const) {
      await services.articles.insert({
        id: `art_claim_batch_${suffix}`,
        sourceId: `src_claim_batch_${suffix}`,
        url: `https://example.test/claim-batch-${suffix}`,
        normalizedUrl: `https://example.test/claim-batch-${suffix}`,
        title: `证据 ${suffix}`,
        titleNorm: `证据 ${suffix}`,
        lang: "zh",
        publishedAt: at,
        firstSeenAt: at,
        excerpt: `Claim ${suffix} 的证据摘要`,
        wireFamily: "wire:claim-batch-shared",
      });
      await services.events.attachArticle(event.id, `art_claim_batch_${suffix}`, "report", "wire:claim-batch-shared");
    }
    const firstClaim = await services.events.addClaim({
      eventId: event.id,
      text: "第一项可核验主张",
      textNorm: "第一项可核验主张",
      type: "fact",
      firstSeenAt: at,
    });
    const secondClaim = await services.events.addClaim({
      eventId: event.id,
      text: "第二项可核验主张",
      textNorm: "第二项可核验主张",
      type: "fact",
      firstSeenAt: new Date(Date.parse(at) + 1).toISOString(),
    });
    await services.events.addEvidence({ claimId: firstClaim.id, articleId: "art_claim_batch_b", stance: "supports", familyKey: "wire:claim-batch-shared", hasPrimary: true });
    await services.events.addEvidence({ claimId: firstClaim.id, articleId: "art_claim_batch_a", stance: "mentions", familyKey: "wire:claim-batch-shared", hasPrimary: false });
    await services.events.addEvidence({ claimId: secondClaim.id, articleId: "art_claim_batch_b", stance: "contradicts", familyKey: "wire:claim-batch-shared", hasPrimary: false });
    services.raw.prepare(`
      INSERT INTO event_versions(event_id, version, created_at, changes) VALUES (?, ?, ?, ?), (?, ?, ?, ?)
    `).run(
      event.id,
      event.version,
      at,
      JSON.stringify({ added: ["当前版本"], changed: [], removed: [] }),
      event.id,
      event.version + 1,
      new Date(Date.parse(at) + 1).toISOString(),
      JSON.stringify({ added: ["未来版本"], changed: [], removed: [] })
    );

    const detail = await services.events.detail(event.id);
    const briefingDetails = await services.events.briefingDetails([event.id, "evt_missing", event.id]);
    expect(detail).not.toHaveProperty("articles");
    expect(detail?.coverage.independentFamilies).toBe(1);
    expect(detail?.delta).toMatchObject({ sinceVersion: event.version, added: ["当前版本"] });
    expect(detail?.claims.find((claim) => claim.id === firstClaim.id)?.evidence.map((item) => item.articleId))
      .toEqual(["art_claim_batch_a", "art_claim_batch_b"]);
    expect(detail?.claims.find((claim) => claim.id === secondClaim.id)?.evidence.map((item) => item.articleId))
      .toEqual(["art_claim_batch_b"]);
    expect(detail?.claims.find((claim) => claim.id === firstClaim.id)?.evidence[0]).toMatchObject({
      articleId: "art_claim_batch_a",
      stance: "mentions",
      familyKey: "wire:claim-batch-shared",
      hasPrimary: false,
      citation: {
        sourceId: "src_claim_batch_a",
        sourceName: "证据批量测试源 A",
        sourceCategory: "data",
      },
    });
    expect([...briefingDetails.keys()]).toEqual([event.id]);
    expect(briefingDetails.get(event.id)).toEqual({
      summary: detail?.summary,
      citations: detail?.citations,
      delta: detail?.delta,
    });
    services.raw.prepare("UPDATE claims SET status = 'corroborated' WHERE id = ?").run(firstClaim.id);
    services.raw.prepare("UPDATE claims SET status = 'disputed' WHERE id = ?").run(secondClaim.id);
    expect(services.events.list({ ids: [event.id], limit: 1 })[0]).toMatchObject({
      id: event.id,
      articleCount: 2,
      independentSourceCount: 1,
      confirmedCount: 1,
      unverifiedCount: 0,
      disputedCount: 1,
      coverageGapCount: 5,
      sourceTrail: [expect.objectContaining({ url: expect.stringMatching(/^https:\/\/example\.test\//) })],
    });
  });

  it("rejects missing or invalid admin credentials", async () => {
    const missing = await app.request("http://local.test/api/admin/status");
    const invalid = await app.request("http://local.test/api/admin/status", {
      headers: { authorization: "Bearer wrong-token" },
    });

    expect(missing.status).toBe(401);
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain("News Radar Admin");
  });

  it("accepts a valid bearer token for admin status", async () => {
    const response = await app.request("http://local.test/api/admin/status", {
      headers: { authorization: "Bearer test-admin-token" },
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      scheduler: { running: false, lastTickAt: null },
      workflow: { backlog: 0, running: 0 },
      ai: { provider: "none", enabled: false },
    });
  });

  it("serves SPA deep links without masking API or missing asset responses", async () => {
    const clientRoot = mkdtempSync(join(tmpdir(), "news-radar-client-"));
    try {
      mkdirSync(join(clientRoot, "assets"));
      writeFileSync(join(clientRoot, "index.html"), "<!doctype html><title>News Radar test shell</title>");
      writeFileSync(join(clientRoot, "assets", "app.js"), "console.log('news-radar');");
      const staticApp = createApp(services, { clientRoot });

      const deepLink = await staticApp.request("http://local.test/ministries/war", {
        headers: { accept: "text/html" },
      });
      expect(deepLink.status).toBe(200);
      expect(deepLink.headers.get("content-type")).toContain("text/html");
      expect(await deepLink.text()).toContain("News Radar test shell");

      const missingApi = await staticApp.request("http://local.test/api/not-found", {
        headers: { accept: "text/html" },
      });
      expect(missingApi.status).toBe(404);
      expect(missingApi.headers.get("content-type")).not.toContain("text/html");

      const missingAsset = await staticApp.request("http://local.test/assets/missing.js", {
        headers: { accept: "*/*" },
      });
      expect(missingAsset.status).toBe(404);
      expect(await missingAsset.text()).not.toContain("News Radar test shell");
    } finally {
      rmSync(clientRoot, { recursive: true, force: true });
    }
  });

  it("exposes workflow dashboard and rejects invalid ministry filters", async () => {
    const dashboard = await app.request("http://local.test/api/workflow");
    const invalid = await app.request("http://local.test/api/events?ministry=unknown");

    expect(dashboard.status).toBe(200);
    expect(await dashboard.json()).toMatchObject({
      rulesVersion: "three-departments-v2",
      stages: { zhongshu: { pending: 0 }, menxia: { remanded: 0 }, shangshu: { failed: 0 } },
    });
    expect(invalid.status).toBe(400);
  });

  it("persists and exposes a remanded event workflow without AI", async () => {
    const event = await services.events.create({
      title: "只有单一线索的测试事件",
      firstAt: new Date().toISOString(),
      countries: ["cn"],
      topics: ["conflict"],
      entities: [],
      importance: 80,
      trackMode: "breaking",
    });
    const result = await services.workflow.processEvent(event.id, "test");
    const response = await app.request(`http://local.test/api/events/${event.id}/workflow`);
    const body = await response.json();
    const storedEvent = await services.events.get(event.id);

    expect(result.status).toBe("remanded");
    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      workflow: { status: "remanded", reviewDecision: "remand", publishable: false },
      review: { decision: "remand" },
    });
    expect(storedEvent?.dirty).toBe(false);

    const liveResponse = await app.request("http://local.test/api/events?limit=200");
    const liveBody = await liveResponse.json() as Record<string, any>;
    expect(liveBody.items.find((item: Record<string, unknown>) => item.id === event.id)).toMatchObject({
      workflowStatus: "remanded",
      publishable: false,
      governance: { workflow: { status: "remanded" }, review: { decision: "remand" } },
    });

    services.raw.prepare("UPDATE workflow_cases SET publishable = 1, completed_at = ? WHERE event_id = ?")
      .run(new Date().toISOString(), event.id);
    expect(services.events.list({ ids: [event.id], publishableOnly: true })).toHaveLength(0);
    services.raw.prepare("UPDATE workflow_cases SET publishable = 0, completed_at = NULL WHERE event_id = ?").run(event.id);
  });

  it("keeps unreviewed evidence out of public search and assistant retrieval", async () => {
    const at = new Date().toISOString();
    const source = (await services.sources.list(false))[0];
    if (!source) throw new Error("测试来源注册表为空");
    const event = await services.events.create({
      title: "审议旁路测试事件",
      firstAt: at,
      countries: ["cn"],
      topics: ["policy"],
      entities: [],
      importance: 60,
    });
    const article = (await services.articles.insert({
      id: "art_governance_search_gate",
      sourceId: source.id,
      url: "https://example.test/governance-search-gate",
      normalizedUrl: "https://example.test/governance-search-gate",
      title: "审议旁路测试材料",
      titleNorm: "审议旁路测试材料",
      lang: "zh",
      publishedAt: at,
      firstSeenAt: at,
      bodyText: "这份审议旁路测试材料在门下省作出决定前不得进入公共搜索。",
      excerpt: "审议旁路测试材料",
      contentHash: "hash-governance-search-gate",
    })).article;
    await services.events.attachArticle(event.id, article.id, "report", source.familyId);
    const claim = await services.events.upsertClaim({
      id: "clm_governance_search_gate",
      eventId: event.id,
      text: "审议旁路测试说法尚待复核",
      textNorm: "审议旁路测试说法尚待复核",
      type: "fact",
      firstSeenAt: at,
      status: "reported",
    });

    const before = await app.request(`http://local.test/api/search?q=${encodeURIComponent("审议旁路")}`);
    const beforeBody = await before.json() as Record<string, any>;
    expect((await app.request(`http://local.test/api/events/${event.id}`)).status).toBe(404);
    expect(beforeBody.events.some((item: Record<string, unknown>) => item.id === event.id)).toBe(false);
    expect(beforeBody.articles.some((item: Record<string, unknown>) => item.id === article.id)).toBe(false);
    expect(beforeBody.claims.some((item: Record<string, unknown>) => item.id === claim.id)).toBe(false);

    const result = await services.workflow.processEvent(event.id, "test-search-gate");
    expect(["remanded", "completed"]).toContain(result.status);
    const after = await app.request(`http://local.test/api/search?q=${encodeURIComponent("审议旁路")}`);
    const afterBody = await after.json() as Record<string, any>;
    expect((await app.request(`http://local.test/api/events/${event.id}`)).status).toBe(200);
    expect(afterBody.events.some((item: Record<string, unknown>) => item.id === event.id)).toBe(true);
    expect(afterBody.articles.some((item: Record<string, unknown>) => item.id === article.id)).toBe(true);
    expect(afterBody.claims.some((item: Record<string, unknown>) => item.id === claim.id)).toBe(true);

    const searchSpy = vi.spyOn(services.articles, "search");
    const recentSpy = vi.spyOn(services.articles, "recent");
    try {
      await services.reporting.ask("审议旁路");
      expect(searchSpy).toHaveBeenCalledWith("审议旁路", 80, true);
      expect(recentSpy).toHaveBeenCalledWith(72, 80, true);
    } finally {
      searchSpy.mockRestore();
      recentSpy.mockRestore();
    }
  });

  it("reports a fresh external scheduler heartbeat from the web process", async () => {
    const lastTickAt = new Date(Date.now() - 1_000).toISOString();
    await services.kv.setJson("scheduler:runtime", {
      instanceId: "test-worker",
      heartbeatAt: new Date().toISOString(),
      state: {
        running: true,
        tickInProgress: true,
        lastTickAt,
        lastTickError: null,
        lastIngestAdded: 4,
        lastRefreshedEvents: 2,
        lastWorkflowCompleted: 2,
        lastWorkflowRemanded: 1,
        lastWorkflowFailed: 0,
      },
    }, 300);
    try {
      const response = await app.request("http://local.test/api/health");
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        scheduler: { running: true, lastTickAt },
      });
    } finally {
      await services.kv.delete("scheduler:runtime");
    }
  });

  it("keeps an event dirty when evidence changes after the remand snapshot", async () => {
    const event = await services.events.create({
      title: "封驳后新证据测试事件",
      firstAt: new Date().toISOString(),
      countries: [],
      topics: ["policy"],
      entities: [],
    });
    const acquired = services.workflows.acquireRun(event.id, "remand-dirty-fence", "test", 60);
    services.workflows.saveAssignments(event.id, acquired.runId, acquired.attempt, []);
    services.workflows.saveProposal(event.id, acquired.runId, acquired.attempt, {
      rationale: ["测试提案。"],
    } as ZhongshuProposalDTO);
    services.workflows.saveReview(event.id, acquired.runId, acquired.attempt, {
      decision: "remand",
      rationale: ["测试封驳。"],
    } as MenxiaReviewDTO);
    const changedAt = new Date(Date.parse(event.lastUpdateAt) + 1_000).toISOString();
    services.raw.prepare("UPDATE events SET version = version + 1, last_update_at = ?, dirty = 1 WHERE id = ?")
      .run(changedAt, event.id);

    expect(services.workflows.clearDirtyAfterRemand(
      event.id,
      acquired.runId,
      acquired.attempt,
      event.version,
      event.lastUpdateAt
    )).toBe(false);
    const stored = services.raw.prepare("SELECT dirty, version, last_update_at FROM events WHERE id = ?")
      .get(event.id) as { dirty: number; version: number; last_update_at: string };
    expect(stored).toEqual({ dirty: 1, version: event.version + 1, last_update_at: changedAt });
  });

  it("executes and exposes cited six-ministry reports before Shangshu completes", async () => {
    const at = new Date().toISOString();
    const sourceRows = [
      ["src_workflow_data", "工作流统计源", "data", "family-workflow-data"],
      ["src_workflow_wire", "工作流通讯社", "wire", "family-workflow-wire"],
    ] as const;
    const insertSource = services.raw.prepare(`
      INSERT OR IGNORE INTO sources(
        id, name, adapter, category, family_id, is_primary, verif_status, health, created_at, updated_at
      ) VALUES (?, ?, 'rss', ?, ?, 1, 'verified', 'ok', ?, ?)
    `);
    for (const source of sourceRows) insertSource.run(...source, at, at);

    const event = await services.events.create({
      title: "六部后端执行测试事件",
      firstAt: at,
      countries: ["cn"],
      topics: ["economy"],
      entities: [],
      importance: 55,
      trackMode: "normal",
    });
    const insertArticle = services.raw.prepare(`
      INSERT INTO articles(
        id, source_id, url, normalized_url, title, title_norm, lang, published_at,
        first_seen_at, content_hash, excerpt
      ) VALUES (?, ?, ?, ?, ?, ?, 'zh', ?, ?, ?, ?)
    `);
    insertArticle.run("art_workflow_data", sourceRows[0][0], "https://example.test/workflow-data", "https://example.test/workflow-data", "统计机构发布测试数据", "统计机构发布测试数据", at, at, "hash-workflow-data", "季度指标更新");
    insertArticle.run("art_workflow_wire", sourceRows[1][0], "https://example.test/workflow-wire", "https://example.test/workflow-wire", "通讯社报道测试数据", "通讯社报道测试数据", at, at, "hash-workflow-wire", "独立报道同一指标");
    await services.events.attachArticle(event.id, "art_workflow_data", "data", sourceRows[0][3]);
    await services.events.attachArticle(event.id, "art_workflow_wire", "report", sourceRows[1][3]);
    const claim = await services.events.addClaim({
      eventId: event.id,
      text: "测试季度指标同比增长 3.2%",
      textNorm: "测试季度指标同比增长 3.2%",
      type: "number",
      claimedBy: "工作流统计源",
      subjectNumber: 3.2,
      numberUnit: "%",
      asOf: "2026-Q2",
      status: "corroborated",
    });
    await services.events.addEvidence({ claimId: claim.id, articleId: "art_workflow_data", stance: "supports", familyKey: sourceRows[0][3], hasPrimary: true });
    await services.events.addEvidence({ claimId: claim.id, articleId: "art_workflow_wire", stance: "supports", familyKey: sourceRows[1][3], hasPrimary: false });

    const eventArticlesSpy = vi.spyOn(services.events, "eventArticles");
    let eventLoopTurns = 0;
    let keepPumping = true;
    const pumpEventLoop = () => {
      setImmediate(() => {
        eventLoopTurns++;
        if (keepPumping) pumpEventLoop();
      });
    };
    pumpEventLoop();
    let result: Awaited<ReturnType<typeof services.workflow.processEvent>>;
    let eventArticleLoads = 0;
    try {
      result = await services.workflow.processEvent(event.id, "test-ministry-reports");
    } finally {
      keepPumping = false;
      eventArticleLoads = eventArticlesSpy.mock.calls.filter(([loadedEventId]) => loadedEventId === event.id).length;
      eventArticlesSpy.mockRestore();
    }
    const response = await app.request(`http://local.test/api/events/${event.id}/workflow`);
    const body = await response.json() as Record<string, any>;
    const ministryResponse = await app.request("http://local.test/api/ministries/revenue?limit=20");
    const ministryBody = await ministryResponse.json() as Record<string, any>;
    const liveResponse = await app.request("http://local.test/api/events?limit=200");
    const liveBody = await liveResponse.json() as Record<string, any>;

    expect(result.status).toBe("completed");
    expect(eventArticleLoads).toBe(3);
    expect(eventLoopTurns).toBeGreaterThanOrEqual(6);
    expect(response.status).toBe(200);
    expect(body.workflow).toMatchObject({
      status: "completed",
      publishable: true,
      ministryReportProgress: { total: 6, completed: 1, blocked: 5, failed: 0 },
    });
    expect(body.dispatch).toMatchObject({
      actions: { ministries: "completed", summary: "completed", alerts: "completed" },
      ministryDigest: { completedMinistries: ["economy"], citationCount: 2 },
    });
    expect(body.ministryReports).toHaveLength(6);
    expect(body.ministryReports.find((report: Record<string, unknown>) => report.ministry === "economy")).toMatchObject({
      status: "completed",
      claimRefs: [claim.id],
    });
    expect(body.transitions.filter((transition: Record<string, unknown>) => String(transition.action).startsWith("ministry_report_"))).toHaveLength(6);
    expect(ministryResponse.status).toBe(200);
    expect(ministryBody.reports.some((report: Record<string, unknown>) => report.eventId === event.id && report.status === "completed")).toBe(true);
    expect(liveBody.items.find((item: Record<string, unknown>) => item.id === event.id)).toMatchObject({
      independentSourceCount: 2,
      unverifiedCount: 0,
      sourceTrail: [
        expect.objectContaining({ url: "https://example.test/workflow-data", publishedAt: at }),
        expect.objectContaining({ url: "https://example.test/workflow-wire", publishedAt: at }),
      ],
      workflowStatus: "completed",
      publishable: true,
      governance: {
        workflow: { status: "completed", ministryReportProgress: { total: 6, completed: 1, blocked: 5 } },
        review: { decision: "approve" },
        dispatch: { ministryDigest: { citationCount: 2 } },
      },
    });

    const detailSpy = vi.spyOn(services.events, "detail");
    const briefingDetailsSpy = vi.spyOn(services.events, "briefingDetails");
    try {
      const generated = await services.reporting.createBriefing("hourly", "UTC");
      expect(briefingDetailsSpy).toHaveBeenCalledOnce();
      expect(detailSpy).not.toHaveBeenCalled();
      const briefingItem = generated.sections.flatMap((section) => section.items).find((item) => item.eventId === event.id);
      expect(briefingItem).toMatchObject({
        independentSourceCount: 2,
        unverifiedCount: 0,
        governance: {
          workflow: { status: "completed", publishable: true },
          review: { decision: "approve" },
          dispatch: { ministryDigest: { citationCount: 2 } },
        },
      });
      const persistedResponse = await app.request(`http://local.test/api/briefings/${generated.id}`);
      const persisted = await persistedResponse.json() as Record<string, any>;
      expect(persisted.sections.flatMap((section: Record<string, any>) => section.items)
        .find((item: Record<string, unknown>) => item.eventId === event.id)?.governance.workflow.status).toBe("completed");
    } finally {
      detailSpy.mockRestore();
      briefingDetailsSpy.mockRestore();
    }
  });

  it("does not create duplicate runs or transitions for the same evidence fingerprint", async () => {
    const event = await services.events.create({
      title: "工作流幂等测试事件",
      firstAt: new Date().toISOString(),
      countries: [],
      topics: ["security"],
      entities: [],
      importance: 80,
      trackMode: "breaking",
    });
    const first = await services.workflow.processEvent(event.id, "test-first");
    const second = await services.workflow.processEvent(event.id, "test-second");
    const runs = services.raw.prepare("SELECT count(*) AS n FROM workflow_runs WHERE event_id = ?").get(event.id) as { n: number };
    const transitions = services.raw.prepare("SELECT count(*) AS n FROM workflow_transitions WHERE event_id = ?").get(event.id) as { n: number };

    expect(first.status).toBe("remanded");
    expect(second.status).toBe("skipped");
    expect(runs.n).toBe(1);
    expect(transitions.n).toBe(2);
  });

  it("prevents a superseded run from overwriting the active workflow projection", async () => {
    const event = await services.events.create({
      title: "工作流旧运行栅栏测试",
      firstAt: new Date().toISOString(),
      countries: [],
      topics: ["policy"],
      entities: [],
    });
    const stale = services.workflows.acquireRun(event.id, "fence-hash-a", "test-stale", 60);
    const leased = services.workflows.acquireRun(event.id, "fence-hash-b", "test-active-blocked", 60);
    expect(leased).toMatchObject({ runId: stale.runId, attempt: stale.attempt, shouldProcess: false, reason: "leased" });
    services.raw.prepare("UPDATE workflow_runs SET lease_until = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", stale.runId);
    const active = services.workflows.acquireRun(event.id, "fence-hash-b", "test-active", 60);
    const proposal = { rationale: ["旧运行不应写入当前案件。"] } as ZhongshuProposalDTO;

    expect(stale.runId).not.toBe(active.runId);
    expect(() => services.workflows.saveProposal(event.id, stale.runId, stale.attempt, proposal))
      .toThrow(/不是当前活动案件/);
    expect(services.workflows.fail(event.id, stale.runId, stale.attempt, "STALE_RUN", "旧运行失败", 3)).toBe(false);

    const workflow = services.raw.prepare(`
      SELECT active_run_id, status, proposal FROM workflow_cases WHERE event_id = ?
    `).get(event.id) as { active_run_id: string; status: string; proposal: string | null };
    const staleTransitions = services.raw.prepare("SELECT count(*) AS n FROM workflow_transitions WHERE run_id = ?")
      .get(stale.runId) as { n: number };
    expect(workflow).toEqual({ active_run_id: active.runId, status: "pending", proposal: null });
    expect(staleTransitions.n).toBe(0);
  });

  it("prevents an expired attempt from writing into its successor attempt", async () => {
    const event = await services.events.create({
      title: "工作流旧 attempt 栅栏测试",
      firstAt: new Date().toISOString(),
      countries: [],
      topics: ["technology"],
      entities: [],
    });
    const proposal = { rationale: ["测试提案。"] } as ZhongshuProposalDTO;
    const review = { decision: "approve", rationale: ["测试准奏。"] } as MenxiaReviewDTO;
    const dispatch = {
      dispatchedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      actions: { ministries: "pending", summary: "pending", alerts: "pending" },
      ministryDigest: null,
      summaryEngine: null,
      errors: [],
    } as ShangshuDispatchDTO;
    const first = services.workflows.acquireRun(event.id, "same-fence-hash", "test-attempt-1", 60);
    services.workflows.saveAssignments(event.id, first.runId, first.attempt, []);
    services.workflows.saveProposal(event.id, first.runId, first.attempt, proposal);
    services.workflows.saveReview(event.id, first.runId, first.attempt, review);
    services.workflows.saveDispatch(event.id, first.runId, first.attempt, dispatch);
    services.workflows.initializeMinistryReports(event.id, first.runId, first.attempt);

    services.raw.prepare("UPDATE workflow_runs SET lease_until = ? WHERE id = ?")
      .run("2020-01-01T00:00:00.000Z", first.runId);
    const second = services.workflows.acquireRun(event.id, "same-fence-hash", "test-attempt-2", 60);
    services.workflows.saveAssignments(event.id, second.runId, second.attempt, []);
    services.workflows.saveProposal(event.id, second.runId, second.attempt, proposal);
    services.workflows.saveReview(event.id, second.runId, second.attempt, review);
    services.workflows.saveDispatch(event.id, second.runId, second.attempt, dispatch);

    expect(second.runId).toBe(first.runId);
    expect(second.attempt).toBe(first.attempt + 1);
    expect(() => services.workflows.saveMinistryReport(event.id, first.runId, first.attempt, {
      ministry: "technology_infrastructure_disaster",
      status: "blocked",
      findings: [],
      risks: [],
      evidenceGaps: ["旧 attempt 不得改写历史工作单。"],
      actions: [],
      citations: [],
      claimRefs: [],
    })).toThrow(/attempt 已被后续运行接管/);
    expect(() => services.workflows.updateDispatch(event.id, first.runId, first.attempt, dispatch))
      .toThrow(/attempt 已被后续运行接管/);
    expect(services.workflows.fail(event.id, first.runId, first.attempt, "STALE_ATTEMPT", "旧 attempt 失败", 3)).toBe(false);

    const oldReport = services.raw.prepare(`
      SELECT status, evidence_gaps FROM workflow_ministry_reports
      WHERE run_id = ? AND ministry = ? AND attempt = ?
    `).get(first.runId, "technology_infrastructure_disaster", first.attempt) as { status: string; evidence_gaps: string };
    const current = services.raw.prepare(`
      SELECT wc.status, wr.status AS run_status, wr.attempt
      FROM workflow_cases wc JOIN workflow_runs wr ON wr.id = wc.active_run_id
      WHERE wc.event_id = ?
    `).get(event.id) as { status: string; run_status: string; attempt: number };
    expect(oldReport).toEqual({ status: "pending", evidence_gaps: "[]" });
    expect(current).toEqual({ status: "dispatched", run_status: "running", attempt: second.attempt });
  });

  it("reschedules failed runs after backoff even when the event is no longer dirty", async () => {
    const event = await services.events.create({
      title: "退避重试测试事件",
      firstAt: new Date().toISOString(),
      countries: [],
      topics: ["investigation"],
      entities: [],
    });
    await services.workflow.processEvent(event.id, "test");
    const workflow = services.workflows.summary(event.id);
    expect(workflow).not.toBeNull();
    services.raw.prepare("UPDATE events SET dirty = 0 WHERE id = ?").run(event.id);
    services.raw.prepare("UPDATE workflow_cases SET status = 'failed' WHERE event_id = ?").run(event.id);
    services.raw.prepare("UPDATE workflow_runs SET status = 'failed', next_attempt_at = ? WHERE id = (SELECT active_run_id FROM workflow_cases WHERE event_id = ?)")
      .run("2020-01-01T00:00:00.000Z", event.id);

    expect(services.workflows.outdatedEventIds(100)).toContain(event.id);
  });

  it("does not create a new event version when the generated summary is unchanged", async () => {
    const event = await services.events.create({
      title: "摘要幂等测试事件",
      firstAt: new Date().toISOString(),
      countries: [],
      topics: ["policy"],
      entities: [],
    });
    const summary = { oneLiner: "相同摘要", confirmed: [], statements: [], unverified: [], disputed: [], whyItMatters: null };
    await services.events.saveSummary(event.id, summary, "extractive");
    const afterFirst = await services.events.get(event.id);
    await services.events.saveSummary(event.id, summary, "extractive");
    const afterSecond = await services.events.get(event.id);

    expect(afterSecond?.version).toBe(afterFirst?.version);
  });

  it("rejects a stale summary snapshot without clearing newer dirty evidence", async () => {
    const event = await services.events.create({
      title: "摘要快照栅栏测试事件",
      firstAt: new Date().toISOString(),
      countries: [],
      topics: ["science"],
      entities: [],
    });
    const fenceAt = await services.events.touch(event.id, { importance: 45 });
    const changedAt = new Date(Date.parse(fenceAt) + 1_000).toISOString();
    services.raw.prepare("UPDATE events SET last_update_at = ?, dirty = 1 WHERE id = ?").run(changedAt, event.id);
    const summary = { oneLiner: "过期摘要", confirmed: [], statements: [], unverified: [], disputed: [], whyItMatters: null };

    const saved = await services.events.saveSummary(event.id, summary, "extractive", {
      version: event.version,
      lastUpdateAt: fenceAt,
    });
    const stored = services.raw.prepare("SELECT summary, dirty, version, last_update_at FROM events WHERE id = ?")
      .get(event.id) as { summary: string | null; dirty: number; version: number; last_update_at: string };
    expect(saved).toBe(false);
    expect(stored).toEqual({ summary: null, dirty: 1, version: event.version, last_update_at: changedAt });
  });

  it("normalizes legacy double-encoded and partial event summaries", async () => {
    const event = await services.events.create({
      title: "旧摘要双层 JSON 兼容测试",
      firstAt: new Date().toISOString(),
      countries: [],
      topics: ["technology"],
      entities: [],
    });
    const legacy = {
      oneLiner: "旧版摘要",
      confirmed: [{ text: "旧版已确认事项", claimId: "legacy-claim" }],
    };
    services.raw.prepare("UPDATE events SET summary = ?, dirty = 1 WHERE id = ?")
      .run(JSON.stringify(JSON.stringify(legacy)), event.id);

    const detail = await services.events.detail(event.id);
    expect(detail?.summary).toMatchObject({
      oneLiner: "旧版摘要",
      confirmed: [{ text: "旧版已确认事项", claimId: "legacy-claim", citations: [] }],
      statements: [],
      unverified: [],
      disputed: [],
      whyItMatters: null,
    });

    const nextSummary = {
      oneLiner: "新版摘要",
      confirmed: [],
      statements: [],
      unverified: [],
      disputed: [],
      whyItMatters: null,
    };
    expect(await services.events.saveSummary(event.id, nextSummary, "extractive")).toBe(true);
    const stored = services.raw.prepare("SELECT json_type(summary) AS summary_type, version, dirty FROM events WHERE id = ?")
      .get(event.id) as { summary_type: string; version: number; dirty: number };
    expect(stored).toEqual({ summary_type: "object", version: event.version + 1, dirty: 0 });
  });
});
