import { expect, test, type Page } from "@playwright/test";

const ministries = [
  "source_identity",
  "economy",
  "diplomacy_society",
  "conflict_security",
  "law_factcheck",
  "technology_infrastructure_disaster",
] as const;

async function installCommonMocks(page: Page) {
  await page.route("**/api/health", (route) => route.fulfill({
    json: {
      ok: true,
      version: "0.2.0",
      now: "2026-07-31T08:00:00.000Z",
      db: true,
      scheduler: { running: true, lastTickAt: "2026-07-31T07:59:00.000Z" },
      counts: { sources: 128, articles: 2048, events: 86, claims: 512 },
      workflow: { backlog: 12, running: 2, remanded: 7, failed: 1, completed: 66, lastCompletedAt: "2026-07-31T07:58:00.000Z" },
    },
  }));
}

function routedEvent() {
  const audit = workflowDetail();
  return {
    id: "evt-demo",
    title: "多方就地区安全事件发布最新声明",
    oneLiner: "目前可以确认多方已发布声明，具体行动结果仍在交叉核验。",
    status: "developing",
    trackMode: "breaking",
    importance: 86,
    heat: 78,
    heatTrend: "up",
    firstAt: "2026-07-31T05:00:00.000Z",
    lastUpdateAt: "2026-07-31T07:55:00.000Z",
    countries: ["ir", "il", "us"],
    topics: ["conflict", "diplomacy", "sanctions"],
    articleCount: 18,
    independentSourceCount: 3,
    confirmedCount: 3,
    unverifiedCount: 1,
    disputedCount: 2,
    coverageGapCount: 1,
    sourceTrail: [citedArticle],
    routing: {
      primary: "conflict_security",
      collaborators: ["diplomacy_society", "economy"],
      reasons: ["主题 conflict 触发职责规则（+8）", "主题 sanctions 触发职责规则（+3）"],
    },
    workflowStatus: "completed",
    publishable: true,
    governance: {
      workflow: audit.workflow,
      proposal: audit.proposal,
      review: audit.review,
      dispatch: audit.dispatch,
    },
  };
}

const citedArticle = {
  articleId: "art-demo",
  title: "通讯社发布地区安全事件更新",
  url: "https://example.test/demo",
  sourceId: "src-wire",
  sourceName: "示例通讯社",
  sourceCategory: "wire",
  lang: "zh",
  publishedAt: "2026-07-31T07:50:00.000Z",
};

function ministryReport(ministry: typeof ministries[number], index: number) {
  const assigned = ["conflict_security", "diplomacy_society", "economy"].includes(ministry);
  return {
    id: index + 1,
    runId: "wfr-demo",
    eventId: "evt-demo",
    ministry,
    attempt: 1,
    status: assigned ? "completed" : "blocked",
    assignment: assigned ? { ministry, score: ministry === "conflict_security" ? 11 : 4, primary: ministry === "conflict_security", reasons: [`${ministry} 专责规则命中`] } : null,
    findings: assigned ? ["主张「多方已发布最新声明」；当前证据状态：部分佐证。"] : [],
    risks: assigned ? ["具体行动结果仍需独立确认。"] : [],
    evidenceGaps: assigned ? ["尚缺事发地本地来源。"] : ["本轮主题与证据未触发本部专责范围，留档待命。"],
    actions: assigned ? ["继续追踪原始声明与独立来源。"] : ["新证据改变分派评分后重新交办。"],
    citations: assigned ? [citedArticle] : [],
    claimRefs: assigned ? ["clm-demo"] : [],
    rulesVersion: "three-departments-v2",
    startedAt: "2026-07-31T07:56:30.000Z",
    completedAt: "2026-07-31T07:57:30.000Z",
    errorCode: null,
    errorDetail: null,
  };
}

function workflowDetail() {
  return {
    workflow: {
      eventId: "evt-demo",
      status: "completed",
      currentDepartment: "shangshu",
      revision: 2,
      rulesVersion: "three-departments-v2",
      inputHash: "1234567890abcdef",
      publishable: true,
      assignments: [
        { ministry: "conflict_security", score: 11, primary: true, reasons: ["主题 conflict 触发职责规则（+8）"] },
        { ministry: "diplomacy_society", score: 4, primary: false, reasons: ["主题 diplomacy 触发职责规则（+6）"] },
        { ministry: "economy", score: 3, primary: false, reasons: ["主题 sanctions 触发职责规则（+5）"] },
      ],
      ministryReportProgress: { total: 6, pending: 0, running: 0, completed: 3, blocked: 3, failed: 0 },
      reviewDecision: "approve",
      updatedAt: "2026-07-31T07:58:00.000Z",
      completedAt: "2026-07-31T07:58:00.000Z",
    },
    proposal: {
      draftedAt: "2026-07-31T07:56:00.000Z",
      evidenceFingerprint: "1234567890abcdef",
      importance: 86,
      heat: 78,
      trackMode: "breaking",
      claimCounts: { reported: 0, unverified: 0, partially_corroborated: 1, corroborated: 2, disputed: 0, refuted: 0, outdated: 0 },
      independentFamilies: 3,
      originalArticles: 12,
      reprints: 6,
      coverageGaps: ["事发地当地或民间来源"],
      actions: ["execute_ministry_reports", "consolidate_ministry_findings", "refresh_summary", "evaluate_alerts"],
      rationale: ["汇集 18 篇材料，识别 3 项可核验主张。"],
    },
    review: { reviewedAt: "2026-07-31T07:57:00.000Z", decision: "approve", gaps: [], warnings: [{ code: "REQUIRED_SOURCE_CATEGORY_MISSING", severity: "warning", message: "缺少本地来源。", suggestedAction: "继续补证。" }], rationale: ["证据结构满足当前发布门槛。"] },
    dispatch: {
      dispatchedAt: "2026-07-31T07:57:10.000Z",
      completedAt: "2026-07-31T07:58:00.000Z",
      actions: { ministries: "completed", summary: "completed", alerts: "completed" },
      ministryDigest: { completedMinistries: ["economy", "diplomacy_society", "conflict_security"], blockedMinistries: ["source_identity", "law_factcheck", "technology_infrastructure_disaster"], findings: ["主张「多方已发布最新声明」；当前证据状态：部分佐证。"], risks: ["具体行动结果仍需独立确认。"], evidenceGaps: ["尚缺事发地本地来源。"], citationCount: 1, claimRefs: ["clm-demo"] },
      summaryEngine: "extractive",
      errors: [],
    },
    ministryReports: ministries.map(ministryReport),
    transitions: [
      { id: 4, runId: "run", sequence: 4, fromState: "dispatched", toState: "completed", department: "shangshu", action: "execution_completed", reasonCode: "DONE", rationale: ["六部具报、摘要与提醒动作已完成。"], createdAt: "2026-07-31T07:58:00.000Z" },
      { id: 3, runId: "run", sequence: 3, fromState: "approved", toState: "dispatched", department: "shangshu", action: "execution_dispatched", reasonCode: "DISPATCH", rationale: ["尚书省下达执行令。"], createdAt: "2026-07-31T07:57:10.000Z" },
      { id: 2, runId: "run", sequence: 2, fromState: "proposed", toState: "approved", department: "menxia", action: "review_approved", reasonCode: "PASS", rationale: ["证据结构满足当前发布门槛。"], createdAt: "2026-07-31T07:57:00.000Z" },
      { id: 1, runId: "run", sequence: 1, fromState: "pending", toState: "proposed", department: "zhongshu", action: "proposal_drafted", reasonCode: "DRAFT", rationale: ["汇集多方证据形成提案。"], createdAt: "2026-07-31T07:56:00.000Z" },
    ],
    nextBefore: null,
  };
}

test.beforeEach(async ({ page }) => {
  await installCommonMocks(page);
});

test("四页呈递链共用同一份三省六部审议快照", async ({ page }, testInfo) => {
  const event = routedEvent();
  const dashboard = {
    cutoff: "2026-07-31T08:00:00.000Z",
    rulesVersion: "three-departments-v2",
    stages: {
      zhongshu: { articles24h: 436, events24h: 29, pending: 5 },
      menxia: { awaitingReview: 3, remanded: 7, disputedClaims: 21 },
      shangshu: { approved: 4, completed24h: 38, failed: 1 },
    },
    ministries: ministries.map((ministry, index) => ({ ministry, activeEvents: 12 + index, updates24h: 3 + index, remanded: index % 3, disputedClaims: index + 1 })),
    recentDispatches: [event],
  };
  const stats = {
    articles24h: 436,
    events24h: 29,
    activeEvents: 1,
    sourceHealth: { total: 128, ok: 121, degraded: 4, failing: 2, disabled: 1, unknown: 0, byCategory: { wire: 20 } },
    lastIngestAt: "2026-07-31T07:59:00.000Z",
    topEvents: [event],
  };
  const briefing = {
    id: "brf-demo",
    type: "morning",
    periodKey: "2026-07-31-morning",
    createdAt: "2026-07-31T08:00:00.000Z",
    cutoffAt: "2026-07-31T08:00:00.000Z",
    tz: "Asia/Shanghai",
    title: "2026-07-31 晨间新闻简报",
    oneMinuteRead: [event.oneLiner],
    sections: [{ name: "正在发生", items: [{
      eventId: event.id,
      title: event.title,
      oneLiner: event.oneLiner,
      statusLine: "3 项已确认 · 1 项待核实 · 2 项争议",
      citations: [citedArticle],
      independentSourceCount: 3,
      unverifiedCount: 1,
      governance: event.governance,
      section: "正在发生",
      isNew: true,
      changeNote: null,
    }] }],
    delta: null,
    engine: "extractive",
  };
  await page.route("**/api/stats", (route) => route.fulfill({ json: stats }));
  await page.route("**/api/workflow", (route) => route.fulfill({ json: dashboard }));
  await page.route("**/api/events?*", (route) => route.fulfill({ json: { items: [event], total: 1 } }));
  await page.route("**/api/briefings**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    return route.fulfill({ json: pathname === "/api/briefings" ? { items: [briefing], total: 1 } : briefing });
  });
  await page.route("**/api/events/evt-demo/workflow", (route) => route.fulfill({ json: workflowDetail() }));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "从证据入案，到审议呈递" })).toBeVisible();
  await expect(page.locator(`${testInfo.project.name === "mobile" ? ".mobile-bottom-nav" : ".primary-nav"} a[href="/"][aria-current="page"]`)).toBeVisible();
  await page.screenshot({ path: `test-results/screenshots/01-overview-${testInfo.project.name}.png`, fullPage: true });

  await page.goto("/live");
  await expect(page.getByRole("heading", { name: "每条事件先审议，再呈递" })).toBeVisible();
  await expect(page.getByText("01 · 中书省").first()).toBeVisible();
  await expect(page.getByText("02 · 门下省").first()).toBeVisible();
  await expect(page.getByText("03 · 尚书省").first()).toBeVisible();
  await expect(page.getByRole("link", { name: /示例通讯社/ }).first()).toHaveAttribute("href", citedArticle.url);
  await page.screenshot({ path: `test-results/screenshots/02-live-${testInfo.project.name}.png`, fullPage: true });

  await page.goto("/briefings");
  await expect(page.getByRole("heading", { name: briefing.title })).toBeVisible();
  await expect(page.getByText("完成呈递").first()).toBeVisible();
  await expect(page.getByText("3/6 部具报").first()).toBeVisible();
  await page.screenshot({ path: `test-results/screenshots/03-briefings-${testInfo.project.name}.png`, fullPage: true });

  await page.goto("/workflow");
  await expect(page.getByRole("heading", { name: "实时奏议台" })).toBeVisible();
  await expect(page.locator(`${testInfo.project.name === "mobile" ? ".mobile-bottom-nav" : ".primary-nav"} a[href="/workflow"][aria-current="page"]`)).toBeVisible();
  await page.screenshot({ path: `test-results/screenshots/04-workflow-${testInfo.project.name}.png`, fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
});

test("三省六部中枢和六部筛选真实渲染", async ({ page }, testInfo) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));

  await page.route("**/api/workflow", (route) => route.fulfill({
    json: {
      cutoff: "2026-07-31T08:00:00.000Z",
      rulesVersion: "three-departments-v2",
      stages: {
        zhongshu: { articles24h: 436, events24h: 29, pending: 5 },
        menxia: { awaitingReview: 3, remanded: 7, disputedClaims: 21 },
        shangshu: { approved: 4, completed24h: 38, failed: 1 },
      },
      ministries: ministries.map((ministry, index) => ({ ministry, activeEvents: 12 + index, updates24h: 3 + index, remanded: index % 3, disputedClaims: index + 1 })),
      recentDispatches: [routedEvent()],
    },
  }));
  await page.route("**/api/ministries/war", (route) => route.fulfill({
    json: {
      ministry: "conflict_security",
      stats: { ministry: "conflict_security", activeEvents: 18, updates24h: 8, remanded: 2, disputedClaims: 6 },
      reports: [ministryReport("conflict_security", 3)],
      items: [routedEvent()],
      total: 1,
      cutoff: "2026-07-31T08:00:00.000Z",
    },
  }));
  await page.route("**/api/events/evt-demo/workflow", (route) => route.fulfill({ json: workflowDetail() }));

  await page.goto("/workflow");
  await expect(page.getByRole("heading", { name: "实时奏议台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "待阅奏折" })).toBeVisible();
  const allFilter = page.getByRole("button", { name: /全部\s+1/ });
  const activeFilter = page.getByRole("button", { name: /待推进\s+0/ });
  await expect(allFilter).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: /多方就地区安全事件发布最新声明/ })).toBeVisible();
  if (testInfo.project.name !== "mobile") {
    await expect(page.getByRole("button", { name: "上一件奏折" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "下一件奏折" })).toBeDisabled();
  }
  await activeFilter.click();
  await expect(page.getByRole("heading", { name: "当前筛选下没有奏折" })).toBeVisible();
  await allFilter.click();
  await expect(page.getByRole("button", { name: /多方就地区安全事件发布最新声明/ })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  if (testInfo.project.name === "mobile") {
    const paneTabs = page.locator(".workspace-pane-tabs button");
    await expect(paneTabs).toHaveCount(3);
    for (const [index, pane] of ["docket", "memorials", "review"].entries()) {
      await paneTabs.nth(index).click();
      await expect(paneTabs.nth(index)).toHaveAttribute("aria-pressed", "true");
      await expect(page.locator(`[data-pane="${pane}"]`)).toBeVisible();
      if (pane === "review") {
        await expect(page.getByRole("button", { name: "上一件奏折" })).toBeDisabled();
        await expect(page.getByRole("button", { name: "下一件奏折" })).toBeDisabled();
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    }
  }
  await page.screenshot({ path: `test-results/screenshots/workflow-${testInfo.project.name}.png`, fullPage: true });

  await page.goto("/ministries/war");
  await expect(page.getByRole("heading", { name: "兵部工作台" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "兵部具报" })).toBeVisible();
  await expect(page.getByText("已具报", { exact: true })).toBeVisible();
  await expect(page.getByText("主送兵部")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: `test-results/screenshots/ministry-war-${testInfo.project.name}.png`, fullPage: true });

  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("事件详情展示可审计的三省迁移", async ({ page }, testInfo) => {
  await page.route("**/api/events/evt-demo/workflow", (route) => route.fulfill({ json: workflowDetail() }));
  await page.route("**/api/events/evt-demo", (route) => route.fulfill({
    json: {
      ...routedEvent(),
      version: 2,
      lastVerifiedAt: "2026-07-31T07:58:00.000Z",
      summary: {
        oneLiner: "目前可以确认多方已发布声明，具体行动结果仍在交叉核验。",
        confirmed: [],
        statements: [],
        unverified: [],
        disputed: [],
        whyItMatters: { text: "事件涉及地区安全与外交回应。", generatedBy: "rule" },
      },
      claims: [],
      timeline: [],
      coverage: { present: ["通讯社", "外国政府机构"], gaps: ["本地媒体"], byCategory: { wire: 3, gov_intl: 2 }, independentFamilies: 3 },
      delta: null,
      citations: [],
      summaryEngine: "extractive",
    },
  }));

  await page.goto("/events/evt-demo");
  await expect(page.getByRole("heading", { name: "三省审议记录" })).toBeVisible();
  await expect(page.getByText("门下准奏", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "尚书执行令" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "专责办理簿" })).toBeVisible();
  await expect(page.getByText("六部专责", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: `test-results/screenshots/event-workflow-${testInfo.project.name}.png`, fullPage: true });
});

test("旧 Service Worker HTML 壳仍可加载当前应用", async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const legacyAssetResponses = new Map<string, number>();
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));
  page.on("response", (response) => {
    const pathname = new URL(response.url()).pathname;
    if (["/assets/index-B2Eg34rp.js", "/assets/index-b0lJDpbs.css"].includes(pathname)) {
      legacyAssetResponses.set(pathname, response.status());
    }
  });

  await page.route("**/api/workflow", (route) => route.fulfill({
    json: {
      cutoff: "2026-07-31T08:00:00.000Z",
      rulesVersion: "three-departments-v2",
      stages: {
        zhongshu: { articles24h: 0, events24h: 0, pending: 0 },
        menxia: { awaitingReview: 0, remanded: 0, disputedClaims: 0 },
        shangshu: { approved: 0, completed24h: 0, failed: 0 },
      },
      ministries: ministries.map((ministry) => ({ ministry, activeEvents: 0, updates24h: 0, remanded: 0, disputedClaims: 0 })),
      recentDispatches: [],
    },
  }));
  await page.route("**/", (route) => route.fulfill({
    status: 200,
    contentType: "text/html; charset=utf-8",
    body: `<!doctype html>
      <html lang="zh-CN">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
          <title>旧缓存壳验收</title>
          <script type="module" crossorigin src="/assets/index-B2Eg34rp.js"></script>
          <link rel="modulepreload" crossorigin href="/assets/vendor-D9vGD2o_.js" />
          <link rel="stylesheet" crossorigin href="/assets/index-b0lJDpbs.css" />
        </head>
        <body><div id="root"></div></body>
      </html>`,
  }));

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "从证据入案，到审议呈递" })).toBeVisible();
  await expect.poll(() => legacyAssetResponses.get("/assets/index-B2Eg34rp.js")).toBe(200);
  await expect.poll(() => legacyAssetResponses.get("/assets/index-b0lJDpbs.css")).toBe(200);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});

test("旧版或部分工作流载荷降级展示而不崩溃", async ({ page }) => {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("requestfailed", (request) => failedRequests.push(`${request.method()} ${request.url()}`));
  await page.route("**/api/events/evt-demo/workflow", (route) => route.fulfill({
    json: {
      workflow: {
        eventId: "evt-demo",
        status: "archived",
        currentDepartment: "legacy-office",
        revision: 1,
        rulesVersion: "legacy-v1",
        inputHash: "legacy",
        publishable: false,
        assignments: [null],
      },
      proposal: { importance: 0, heat: 0, independentFamilies: 0, originalArticles: 0 },
      review: { decision: "approve", gaps: [null], warnings: [null] },
      dispatch: { ministryDigest: {} },
      ministryReports: [null, {
        id: 99,
        runId: "legacy-run",
        eventId: "evt-demo",
        ministry: "legacy-ministry",
        attempt: 1,
        status: "archived",
        assignment: { primary: false, score: 0 },
      }],
      transitions: [null, { id: 1, runId: "legacy-run", department: "legacy-office", toState: "archived" }],
      nextBefore: null,
    },
  }));
  await page.route("**/api/events/evt-demo", (route) => route.fulfill({
    json: {
      ...routedEvent(),
      version: 1,
      lastVerifiedAt: null,
      summary: null,
      claims: [],
      timeline: [],
      coverage: { present: [], gaps: [], byCategory: {}, independentFamilies: 0 },
      delta: null,
      citations: [],
      summaryEngine: "extractive",
    },
  }));

  await page.goto("/events/evt-demo");
  await expect(page.getByRole("heading", { name: "三省审议记录" })).toBeVisible();
  await expect(page.getByText("未知状态", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("未知部具报", { exact: true })).toBeVisible();
  await expect(page.getByText("旧版奏议未附拟稿说明。", { exact: true })).toBeVisible();
  expect(consoleErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
});
