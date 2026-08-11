import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Hono } from "hono";
import type { BriefingType, MinistryCode, SourceCategory } from "../../shared/types";
import type { ServiceContainer } from "../container";
import { sourceFamilies, sources } from "../db/schema";
import { shortId } from "../lib/hash";
import { buildOpml, parseOpml } from "../lib/opml";
import { validatePublicUrl } from "../lib/ssrf";
import { nowIso } from "../lib/time";
import { adminAuth, rateLimit } from "../middleware/security";

const SOURCE_CATEGORIES = new Set<SourceCategory>([
  "gov_cn", "official_media_cn", "market_media_cn", "social_cn", "gov_intl", "intl_org", "wire",
  "intl_media", "local_media", "party_media", "social", "data", "factcheck",
]);
const ADAPTERS = new Set(["rss", "jsonfeed", "gdelt", "mastodon", "bluesky", "telegramweb"]);
const BRIEFING_TYPES = new Set<BriefingType>(["morning", "noon", "evening", "breaking", "hourly", "topic", "watchlist"]);
const WORKFLOW_STATES = new Set(["pending", "proposed", "remanded", "approved", "dispatched", "completed", "failed"]);
const DEPARTMENTS = new Set(["zhongshu", "menxia", "shangshu"]);
const MINISTRIES = new Set<MinistryCode>([
  "source_identity", "economy", "diplomacy_society", "conflict_security", "law_factcheck", "technology_infrastructure_disaster",
]);

/** 需要管理令牌的私有与运维 API */
export function registerAdminRoutes(app: Hono, services: ServiceContainer): void {
  const auth = adminAuth(services.config);
  const adminRate = rateLimit({ windowMs: 60_000, max: 40, keyPrefix: "admin" });
  for (const path of [
    "/api/watchlists", "/api/watchlists/*", "/api/alerts", "/api/alerts/*",
    "/api/admin", "/api/admin/*", "/api/sources/import-opml", "/api/sources/export-opml",
    "/api/sources/:id/retry", "/api/sources/:id/settings",
  ]) {
    app.use(path, adminRate, auth);
  }

  app.get("/api/watchlists", async (c) => c.json({ items: await services.notifications.listWatchlists() }));
  app.post("/api/watchlists", async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.name !== "string") return c.json({ error: "缺少观察列表名称" }, 400);
    const item = await services.notifications.saveWatchlist({
      id: typeof body.id === "string" ? body.id.slice(0, 100) : undefined,
      name: body.name,
      keywords: stringArray(body.keywords),
      entities: stringArray(body.entities),
      minImportance: numberInRange(body.minImportance, 0, 100, 40),
      channels: stringArray(body.channels),
      enabled: body.enabled !== false,
    });
    return c.json(item, 201);
  });
  app.put("/api/watchlists/:id", async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.name !== "string") return c.json({ error: "缺少观察列表名称" }, 400);
    const item = await services.notifications.saveWatchlist({
      id: c.req.param("id"),
      name: body.name,
      keywords: stringArray(body.keywords),
      entities: stringArray(body.entities),
      minImportance: numberInRange(body.minImportance, 0, 100, 40),
      channels: stringArray(body.channels),
      enabled: body.enabled !== false,
    });
    return c.json(item);
  });
  app.delete("/api/watchlists/:id", async (c) =>
    (await services.notifications.deleteWatchlist(c.req.param("id"))) ? c.body(null, 204) : c.json({ error: "观察列表不存在" }, 404)
  );

  app.get("/api/alerts", async (c) => {
    const unread = c.req.query("unread") === "true";
    return c.json({ items: await services.notifications.listAlerts(numberInRange(c.req.query("limit"), 1, 300, 100), unread) });
  });
  app.post("/api/alerts/:id/read", async (c) => {
    const id = Number(c.req.param("id"));
    return Number.isInteger(id) && (await services.notifications.markRead(id))
      ? c.json({ ok: true })
      : c.json({ error: "提醒不存在" }, 404);
  });

  app.post("/api/sources", async (c) => {
    const body = await readJson(c);
    const feedUrl = typeof body?.feedUrl === "string" ? body.feedUrl.trim() : "";
    const name = typeof body?.name === "string" ? body.name.trim().slice(0, 200) : "";
    if (!name || !feedUrl) return c.json({ error: "来源名称和 feedUrl 必填" }, 400);
    const check = validatePublicUrl(feedUrl);
    if (!check.ok) return c.json({ error: `来源 URL 不安全：${check.reason}` }, 400);
    const adapter = typeof body?.adapter === "string" && ADAPTERS.has(body.adapter) ? body.adapter : "rss";
    const category = typeof body?.category === "string" && SOURCE_CATEGORIES.has(body.category as SourceCategory)
      ? (body.category as SourceCategory)
      : "intl_media";
    const now = nowIso();
    const id = `custom-${shortId(feedUrl, 16)}`;
    await ensureCustomFamily(services, "custom-sources", "用户自定义来源");
    await services.db
      .insert(sources)
      .values({
        id,
        name,
        homepage: typeof body?.homepage === "string" ? body.homepage.slice(0, 1000) : new URL(feedUrl).origin,
        feedUrl,
        adapter,
        config: null,
        country: typeof body?.country === "string" ? body.country.slice(0, 20) : null,
        region: typeof body?.region === "string" ? body.region.slice(0, 100) : "自定义",
        lang: typeof body?.lang === "string" ? body.lang.slice(0, 20) : "mul",
        category,
        owner: typeof body?.owner === "string" ? body.owner.slice(0, 200) : name,
        ownershipNote: "由用户添加，所有权与身份需人工复核。",
        isParty: body?.isParty === true,
        partyOf: typeof body?.partyOf === "string" ? body.partyOf.slice(0, 100) : null,
        isPrimary: body?.isPrimary === true,
        paywalled: body?.paywalled === true,
        fetchFulltext: false,
        intervalMin: numberInRange(body?.intervalMin, 2, 360, 30),
        verifStatus: "pending",
        verifBasis: "用户自定义来源，等待从机构官网或权威目录反向确认。",
        lastReviewedAt: null,
        familyId: "custom-sources",
        enabled: body?.enabled !== false,
        health: body?.enabled === false ? "disabled" : "unknown",
        addedBy: "user",
        notes: typeof body?.notes === "string" ? body.notes.slice(0, 1000) : null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: sources.id,
        set: { name, feedUrl, category, adapter, updatedAt: now },
      });
    const row = await services.sources.get(id);
    return c.json(row ? services.sources.toDTO(row) : { id }, 201);
  });

  app.post("/api/sources/:id/retry", async (c) => {
    const source = await services.sources.get(c.req.param("id"));
    if (!source) return c.json({ error: "来源不存在" }, 404);
    await services.sources.clearBackoff(source.id);
    const fresh = (await services.sources.get(source.id)) || source;
    const result = await services.ingestion.ingestSource(fresh);
    if (result.eventIds.length > 0) await services.workflow.processEventIds(result.eventIds, "source-retry");
    return c.json(result);
  });

  app.patch("/api/sources/:id/settings", async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.enabled !== "boolean") return c.json({ error: "enabled 必须是布尔值" }, 400);
    return (await services.sources.setEnabled(c.req.param("id"), body.enabled))
      ? c.json({ ok: true })
      : c.json({ error: "来源不存在" }, 404);
  });

  app.get("/api/sources/export-opml", async (c) => {
    const rows = (await services.sources.list(true)).filter((row) => row.feedUrl);
    const opml = buildOpml(rows.map((row) => ({ title: row.name, xmlUrl: row.feedUrl!, htmlUrl: row.homepage })));
    c.header("content-type", "text/x-opml; charset=utf-8");
    c.header("content-disposition", 'attachment; filename="news-radar-sources.opml"');
    return c.body(opml);
  });

  app.post("/api/sources/import-opml", async (c) => {
    const body = await readJson(c);
    if (!body || typeof body.opml !== "string" || body.opml.length > 2_000_000) return c.json({ error: "OPML 内容无效或过大" }, 400);
    const entries = parseOpml(body.opml).slice(0, 500);
    await ensureCustomFamily(services, "custom-opml", "用户 OPML 导入来源");
    const now = nowIso();
    let added = 0;
    let rejected = 0;
    for (const entry of entries) {
      const check = validatePublicUrl(entry.xmlUrl);
      if (!check.ok) {
        rejected++;
        continue;
      }
      const id = `opml-${shortId(entry.xmlUrl, 16)}`;
      await services.db
        .insert(sources)
        .values({
          id,
          name: entry.title.slice(0, 200),
          homepage: entry.htmlUrl || new URL(entry.xmlUrl).origin,
          feedUrl: entry.xmlUrl,
          adapter: "rss",
          config: null,
          country: null,
          region: "OPML 导入",
          lang: "mul",
          category: "intl_media",
          owner: entry.title.slice(0, 200),
          ownershipNote: "从用户 OPML 导入，身份与所有权待复核。",
          isParty: false,
          partyOf: null,
          isPrimary: false,
          paywalled: false,
          fetchFulltext: false,
          intervalMin: 30,
          verifStatus: "pending",
          verifBasis: "OPML 导入，尚未从机构官网反向验证。",
          lastReviewedAt: null,
          familyId: "custom-opml",
          enabled: true,
          health: "unknown",
          addedBy: "opml",
          notes: null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
      added++;
    }
    return c.json({ found: entries.length, added, rejected });
  });

  app.get("/api/admin/workflows", (c) => {
    const statusRaw = c.req.query("status");
    const departmentRaw = c.req.query("department");
    const ministryRaw = c.req.query("ministry");
    const status = statusRaw && WORKFLOW_STATES.has(statusRaw) ? statusRaw : undefined;
    const department = departmentRaw && DEPARTMENTS.has(departmentRaw) ? departmentRaw : undefined;
    const ministry = ministryRaw && MINISTRIES.has(ministryRaw as MinistryCode) ? ministryRaw : undefined;
    const items = services.workflows.adminList({
      status,
      department,
      ministry,
      limit: numberInRange(c.req.query("limit"), 1, 200, 50),
      offset: numberInRange(c.req.query("offset"), 0, 100_000, 0),
    });
    return c.json({ items, total: items.length });
  });

  app.post("/api/admin/workflows/:eventId/retry", async (c) => {
    const body = await readJson(c);
    const expectedRevision = numberInRange(body?.expectedRevision, 1, Number.MAX_SAFE_INTEGER, 0);
    if (!expectedRevision) return c.json({ error: "expectedRevision 必须是正整数" }, 400);
    const result = await services.workflow.retryFailed(c.req.param("eventId"), expectedRevision);
    return result ? c.json(result) : c.json({ error: "工作流不存在、修订号冲突或当前状态不可重试" }, 409);
  });

  app.get("/api/admin/status", async (c) => c.json({
    scheduler: await services.scheduler.stateForApi(),
    workflow: services.workflows.health(),
    ai: { provider: services.reporting.provider.name, model: services.reporting.provider.model, enabled: services.reporting.provider.enabled },
  }));
  app.post("/api/admin/tick", async (c) => c.json(
    process.env.DISABLE_SCHEDULER === "1"
      ? { ...(await services.scheduler.requestTick()), queued: true }
      : await services.scheduler.tick()
  ));
  app.post("/api/admin/ingest", async (c) => c.json({ results: await services.ingestion.runDue(50) }));
  app.post("/api/admin/briefings", async (c) => {
    const body = await readJson(c);
    const type = typeof body?.type === "string" && BRIEFING_TYPES.has(body.type as BriefingType) ? (body.type as BriefingType) : "hourly";
    const tz = typeof body?.tz === "string" ? body.tz.slice(0, 100) : services.config.defaultTz;
    try {
      // 仅允许 Intl 支持的时区
      new Intl.DateTimeFormat("zh-CN", { timeZone: tz }).format();
    } catch {
      return c.json({ error: "无效时区" }, 400);
    }
    return c.json(await services.reporting.createBriefing(type, tz));
  });

  app.post("/api/admin/backup", (c) => {
    const dir = resolve(services.config.dataDir, "backups");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const path = join(dir, `news-${stamp}.db`);
    // 路径由服务端生成，不接受用户输入，避免 SQL/路径注入
    services.raw.prepare("VACUUM INTO ?").run(path);
    return c.json({ ok: true, file: path });
  });

  app.post("/api/admin/retention", async (c) => {
    const body = await readJson(c);
    const fetchLogDays = numberInRange(body?.fetchLogDays, 7, 365, 30);
    const alertDays = numberInRange(body?.alertDays, 7, 3650, 90);
    const fetchCutoff = new Date(Date.now() - fetchLogDays * 86_400_000).toISOString();
    const alertCutoff = new Date(Date.now() - alertDays * 86_400_000).toISOString();
    const a = services.raw.prepare("DELETE FROM fetch_log WHERE started_at < ?").run(fetchCutoff);
    const b = services.raw.prepare("DELETE FROM alerts WHERE created_at < ?").run(alertCutoff);
    return c.json({ fetchLogsDeleted: a.changes, alertsDeleted: b.changes, articleContentDeleted: 0 });
  });
}

async function ensureCustomFamily(services: ServiceContainer, id: string, name: string): Promise<void> {
  await services.db.insert(sourceFamilies).values({ id, name, kind: "ownership", note: "用户维护" }).onConflictDoNothing();
}

async function readJson(c: { req: { json(): Promise<unknown> } }): Promise<Record<string, any> | null> {
  try {
    const value = await c.req.json();
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, any>) : null;
  } catch {
    return null;
  }
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean).slice(0, 100) : [];
}

function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}
