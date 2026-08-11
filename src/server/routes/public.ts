import type { Hono } from "hono";
import type { AskFilters, BriefingType, HealthDTO, MinistryCode, RoutedEventItem, StatsDTO, WorkflowDashboardDTO } from "../../shared/types";
import { MINISTRY_SLUGS } from "../../shared/constants";
import type { ServiceContainer } from "../container";
import { hoursAgoIso, nowIso } from "../lib/time";
import { rateLimit } from "../middleware/security";
import { THREE_DEPARTMENTS_RULES_VERSION } from "../pipeline/ministries";

const BRIEFING_TYPES = new Set<BriefingType>(["morning", "noon", "evening", "breaking", "hourly", "topic", "watchlist"]);
const MINISTRY_BY_SLUG = new Map<string, MinistryCode>(
  Object.entries(MINISTRY_SLUGS).map(([ministry, slug]) => [slug, ministry as MinistryCode])
);

/** 无需管理权限的只读 API */
export function registerPublicRoutes(app: Hono, services: ServiceContainer): void {
  app.get("/api/ready", (c) => c.json({ ok: true, version: services.config.version, now: nowIso() }));

  app.get("/api/health", async (c) => {
    let dbOk = false;
    let counts = { sources: 0, articles: 0, events: 0, claims: 0 };
    let workflow = { backlog: 0, running: 0, remanded: 0, failed: 0, completed: 0, lastCompletedAt: null as string | null };
    try {
      const row = services.raw.prepare(`
        WITH workflow_health AS (
          SELECT
            SUM(CASE WHEN status IN ('pending','proposed','approved','dispatched') THEN 1 ELSE 0 END) AS backlog,
            SUM(CASE WHEN status = 'remanded' THEN 1 ELSE 0 END) AS remanded,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
            MAX(completed_at) AS last_completed_at
          FROM workflow_cases INDEXED BY idx_workflow_cases_health
        )
        SELECT
          (SELECT count(*) FROM sources) AS source_count,
          (SELECT count(*) FROM articles) AS article_count,
          (SELECT count(*) FROM events) AS event_count,
          (SELECT count(*) FROM claims) AS claim_count,
          workflow_health.*,
          (SELECT count(*) FROM workflow_runs WHERE status = 'running') AS running
        FROM workflow_health
      `).get() as Record<string, unknown>;
      counts = {
        sources: Number(row.source_count || 0),
        articles: Number(row.article_count || 0),
        events: Number(row.event_count || 0),
        claims: Number(row.claim_count || 0),
      };
      workflow = {
        backlog: Number(row.backlog || 0),
        running: Number(row.running || 0),
        remanded: Number(row.remanded || 0),
        failed: Number(row.failed || 0),
        completed: Number(row.completed || 0),
        lastCompletedAt: row.last_completed_at ? String(row.last_completed_at) : null,
      };
      dbOk = true;
    } catch {
      dbOk = false;
    }
    let state = services.scheduler.state();
    try {
      state = await services.scheduler.stateForApi();
    } catch {
      // 数据库繁忙时仍返回本进程状态和 503，而不是让健康路由本身抛错。
    }
    const health: HealthDTO = {
      ok: dbOk,
      version: services.config.version,
      now: nowIso(),
      db: dbOk,
      scheduler: { running: state.running, lastTickAt: state.lastTickAt },
      counts,
      workflow,
    };
    return c.json(health, dbOk ? 200 : 503);
  });

  app.get("/api/stats", async (c) => {
    const since24h = hoursAgoIso(24);
    const [articles24h, events24h, sourceHealth, lastIngestAt] = await Promise.all([
      services.articles.countSince(since24h),
      services.events.countSince(since24h),
      services.sources.healthSummary(),
      services.articles.lastIngestAt(),
    ]);
    const topEvents = decorateRoutedEvents(
      services.events.list({ since: hoursAgoIso(7 * 24), reviewedOnly: true, limit: 10 }),
      services
    );
    const stats: StatsDTO = {
      articles24h,
      events24h,
      activeEvents: topEvents.filter((event) => event.status === "developing" || event.status === "active").length,
      sourceHealth,
      lastIngestAt,
      topEvents,
    };
    return c.json(stats);
  });

  app.get("/api/events", (c) => {
    const q = c.req.query();
    const ministry = q.ministry ? MINISTRY_BY_SLUG.get(q.ministry) : undefined;
    if (q.ministry && !ministry) return c.json({ error: "无效的六部标识" }, 400);
    const items = services.events.list({
      tab: q.tab,
      topic: q.topic,
      country: q.country,
      minImportance: parseOptionalInt(q.minImportance, 0, 100),
      since: validIso(q.since) ? q.since : undefined,
      ids: ministry ? services.workflows.eventIdsForMinistry(ministry, 500) : undefined,
      reviewedOnly: true,
      limit: parseOptionalInt(q.limit, 1, 200) || 50,
      offset: parseOptionalInt(q.offset, 0, 100_000) || 0,
    });
    return c.json({ items: decorateRoutedEvents(items, services), total: items.length });
  });

  app.get("/api/events/:id", async (c) => {
    const eventId = c.req.param("id");
    if (!services.workflows.summary(eventId)) return c.json({ error: "事件尚未进入三省六部审议" }, 404);
    const detail = await services.events.detail(eventId);
    return detail ? c.json(detail) : c.json({ error: "事件不存在" }, 404);
  });

  app.get("/api/events/:id/search-plan", async (c) => {
    const eventId = c.req.param("id");
    if (!services.workflows.summary(eventId)) return c.json({ error: "事件尚未进入三省六部审议" }, 404);
    const plan = await services.reporting.searchPlan(eventId);
    return plan ? c.json(plan) : c.json({ error: "事件不存在" }, 404);
  });

  app.get("/api/events/:id/workflow", (c) => {
    const before = parseOptionalInt(c.req.query("before"), 1, Number.MAX_SAFE_INTEGER);
    const detail = services.workflows.detail(
      c.req.param("id"),
      parseOptionalInt(c.req.query("limit"), 1, 200) || 100,
      before
    );
    return detail ? c.json(detail) : c.json({ error: "事件尚未进入三省六部工作流" }, 404);
  });

  app.get("/api/workflow", async (c) => {
    const since24h = hoursAgoIso(24);
    const [articles24h, events24h, disputedClaims] = await Promise.all([
      services.articles.countSince(since24h),
      services.events.countSince(since24h),
      services.events.claimStatusCount("disputed"),
    ]);
    const counts = services.workflows.workflowCounts(since24h);
    const ministryRows = services.workflows.ministryStats(since24h);
    const ministryMap = new Map(ministryRows.map((row) => [row.ministry, row]));
    const recent = services.events.list({ ids: services.workflows.recentEventIds(12), limit: 12 });
    const dashboard: WorkflowDashboardDTO = {
      cutoff: nowIso(),
      rulesVersion: THREE_DEPARTMENTS_RULES_VERSION,
      stages: {
        zhongshu: { articles24h, events24h, pending: counts.pending },
        menxia: { awaitingReview: counts.awaitingReview, remanded: counts.remanded, disputedClaims },
        shangshu: { approved: counts.approved, completed24h: counts.completed24h, failed: counts.failed },
      },
      ministries: ([...MINISTRY_BY_SLUG.values()] as MinistryCode[]).map((ministry) =>
        ministryMap.get(ministry) || { ministry, activeEvents: 0, updates24h: 0, remanded: 0, disputedClaims: 0 }
      ),
      recentDispatches: decorateRoutedEvents(recent, services),
    };
    return c.json(dashboard);
  });

  app.get("/api/ministries/:slug", (c) => {
    const ministry = MINISTRY_BY_SLUG.get(c.req.param("slug"));
    if (!ministry) return c.json({ error: "部门不存在" }, 404);
    const limit = parseOptionalInt(c.req.query("limit"), 1, 200) || 80;
    const ids = services.workflows.eventIdsForMinistry(ministry, 500);
    const items = services.events.list({ ids, limit });
    const reports = services.workflows.reportsForMinistry(ministry, items.map((item) => item.id), limit);
    const stats = services.workflows.ministryStats(hoursAgoIso(24)).find((row) => row.ministry === ministry) || {
      ministry,
      activeEvents: 0,
      updates24h: 0,
      remanded: 0,
      disputedClaims: 0,
    };
    return c.json({ ministry, stats, reports, items: decorateRoutedEvents(items, services), total: items.length, cutoff: nowIso() });
  });

  app.get("/api/briefings", async (c) => {
    const typeRaw = c.req.query("type");
    const type = typeRaw && BRIEFING_TYPES.has(typeRaw as BriefingType) ? (typeRaw as BriefingType) : undefined;
    const items = await services.briefings.list(type, parseOptionalInt(c.req.query("limit"), 1, 100) || 30);
    return c.json({ items, total: items.length });
  });

  app.get("/api/briefings/:id", async (c) => {
    const item = await services.briefings.get(c.req.param("id"));
    return item ? c.json(item) : c.json({ error: "简报不存在" }, 404);
  });

  app.get("/api/briefings/:id/markdown", async (c) => {
    const item = await services.briefings.get(c.req.param("id"));
    if (!item) return c.json({ error: "简报不存在" }, 404);
    c.header("content-type", "text/markdown; charset=utf-8");
    c.header("content-disposition", `inline; filename="${safeFilename(item.periodKey)}.md"`);
    return c.body(item.contentMd || `# ${item.title}\n\n信息截至：${item.cutoffAt}（${item.tz}）\n`);
  });

  app.get("/api/briefings.rss", async (c) => {
    const items = await services.briefings.list(undefined, 30);
    c.header("content-type", "application/rss+xml; charset=utf-8");
    return c.body(renderRss(items, services.config.publicBaseUrl));
  });

  app.get("/api/briefings.json", async (c) => {
    const items = await services.briefings.list(undefined, 30);
    return c.json({
      version: "https://jsonfeed.org/version/1.1",
      title: "新闻雷达简报",
      home_page_url: services.config.publicBaseUrl,
      feed_url: `${services.config.publicBaseUrl}/api/briefings.json`,
      language: "zh-CN",
      items: items.map((item) => ({
        id: item.id,
        url: `${services.config.publicBaseUrl}/briefings?id=${encodeURIComponent(item.id)}`,
        title: item.title,
        content_text: item.contentMd || item.oneMinuteRead.join("\n"),
        date_published: item.createdAt,
        date_modified: item.cutoffAt,
      })),
    });
  });

  app.get("/api/search", async (c) => {
    const query = (c.req.query("q") || "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (!query) return c.json({ events: [], articles: [], claims: [], total: 0 });
    const limit = parseOptionalInt(c.req.query("limit"), 1, 100) || 50;
    const [articleRows, claims] = await Promise.all([
      Promise.resolve(services.articles.search(query, limit, true)),
      services.events.searchClaims(query, limit, true),
    ]);
    const events = services.events.searchEvents(query, limit, true);
    return c.json({
      events,
      articles: articleRows.map((row) => services.articles.toDTO(row)),
      claims,
      total: events.length + articleRows.length + claims.length,
    });
  });

  app.post("/api/ask", rateLimit({ windowMs: 60_000, max: 12, keyPrefix: "ask" }), async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.question !== "string") return c.json({ error: "缺少 question" }, 400);
    const filters = sanitizeAskFilters(body.filters);
    const response = await services.reporting.ask(body.question, filters);
    return c.json(response);
  });

  app.get("/api/sources", async (c) => {
    const category = c.req.query("category");
    const health = c.req.query("health");
    const rows = await services.sources.list(true);
    const items = rows
      .filter((row) => !category || row.category === category)
      .filter((row) => !health || (row.enabled ? row.health : "disabled") === health)
      .map((row) => services.sources.toDTO(row));
    return c.json({ items, total: items.length });
  });

  app.get("/api/fetch-logs", async (c) => {
    const items = await services.sources.recentFetchLogs(parseOptionalInt(c.req.query("limit"), 1, 500) || 100);
    return c.json({ items, total: items.length });
  });

  app.get("/api/push/public-key", (c) => c.json({ publicKey: services.config.vapidPublicKey || null }));
  app.post("/api/push/subscribe", rateLimit({ windowMs: 60_000, max: 10, keyPrefix: "push" }), async (c) => {
    const body = await readJson(c);
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    const keys = isRecord(body?.keys) ? body.keys : null;
    if (!endpoint.startsWith("https://") || typeof keys?.p256dh !== "string" || typeof keys?.auth !== "string") {
      return c.json({ error: "Push 订阅格式无效" }, 400);
    }
    await services.notifications.savePushSubscription({
      endpoint: endpoint.slice(0, 2000),
      keys: { p256dh: keys.p256dh.slice(0, 500), auth: keys.auth.slice(0, 500) },
      ua: c.req.header("user-agent")?.slice(0, 500) || null,
    });
    return c.json({ ok: true });
  });
}

function decorateRoutedEvents(
  items: ReturnType<ServiceContainer["events"]["list"]>,
  services: ServiceContainer
): RoutedEventItem[] {
  const snapshots = services.workflows.snapshots(items.map((item) => item.id));
  return items.map((item) => {
    const governance = snapshots.get(item.id) || null;
    const workflow = governance?.workflow;
    const primary = workflow?.assignments.find((assignment) => assignment.primary) || workflow?.assignments[0];
    return {
      ...item,
      routing: {
        primary: primary?.ministry || null,
        collaborators: (workflow?.assignments || [])
          .filter((assignment) => assignment.ministry !== primary?.ministry)
          .map((assignment) => assignment.ministry),
        reasons: primary?.reasons || [],
      },
      workflowStatus: workflow?.status || null,
      publishable: workflow?.publishable || false,
      governance,
    };
  });
}

function parseOptionalInt(raw: string | undefined, min: number, max: number): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : undefined;
}

function validIso(raw: string | undefined): raw is string {
  return Boolean(raw && Number.isFinite(Date.parse(raw)));
}

function sanitizeAskFilters(value: unknown): AskFilters {
  if (!isRecord(value)) return {};
  return {
    onlyOfficial: value.onlyOfficial === true,
    onlyCivilian: value.onlyCivilian === true,
    excludeReprints: value.excludeReprints === true,
    onlyCrossVerified: value.onlyCrossVerified === true,
  };
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const value = await c.req.json();
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);
}

function xml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderRss(items: Awaited<ReturnType<ServiceContainer["briefings"]["list"]>>, baseUrl: string): string {
  const body = items
    .map(
      (item) => `<item><guid isPermaLink="false">${xml(item.id)}</guid><title>${xml(item.title)}</title><link>${xml(
        `${baseUrl}/briefings?id=${encodeURIComponent(item.id)}`
      )}</link><pubDate>${new Date(item.createdAt).toUTCString()}</pubDate><description>${xml(
        item.oneMinuteRead.join("；") || `信息截至 ${item.cutoffAt}`
      )}</description></item>`
    )
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>新闻雷达简报</title><link>${xml(
    baseUrl
  )}</link><description>多来源聚合、具体主张核验与持续更新</description>${body}</channel></rss>`;
}
