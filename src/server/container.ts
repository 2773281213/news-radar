import type Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Config } from "./config";
import { openDb, type DB } from "./db/client";
import { KV } from "./lib/kv";
import { ArticleStore } from "./services/article-store";
import { EventStore } from "./services/event-store";
import { SourceStore } from "./services/source-store";
import { BriefingStore } from "./services/briefing-store";
import { NotificationStore } from "./services/notification-store";
import { WorkflowStore } from "./services/workflow-store";
import { IngestionService } from "./services/ingestion";
import { ReportingService } from "./services/reporting";
import { AlertingService } from "./services/alerting";
import { WorkflowService } from "./services/workflow";
import { Scheduler } from "./services/scheduler";
import { ensureSourceRegistry } from "./services/bootstrap";

export interface ServiceContainer {
  config: Config;
  db: DB;
  raw: Database.Database;
  kv: KV;
  sources: SourceStore;
  articles: ArticleStore;
  events: EventStore;
  briefings: BriefingStore;
  notifications: NotificationStore;
  workflows: WorkflowStore;
  ingestion: IngestionService;
  reporting: ReportingService;
  alerting: AlertingService;
  workflow: WorkflowService;
  scheduler: Scheduler;
  close(): void;
}

export interface ContainerOptions {
  syncSourceRegistry?: boolean;
}

export function createContainer(config: Config, options: ContainerOptions = {}): ServiceContainer {
  const migrations = resolveMigrationsFolder();
  const { db, raw } = openDb(config.dataDir, migrations);
  if (options.syncSourceRegistry !== false) ensureSourceRegistry(db);

  const kv = new KV(db);
  const sources = new SourceStore(db);
  const articles = new ArticleStore(db, raw);
  const events = new EventStore(db, raw);
  const briefings = new BriefingStore(db);
  const notifications = new NotificationStore(db);
  const workflows = new WorkflowStore(raw);
  const ingestion = new IngestionService(config, kv, sources, articles, events);
  const reporting = new ReportingService(config, kv, articles, events, briefings, workflows);
  const alerting = new AlertingService(config, notifications);
  const workflow = new WorkflowService(
    events,
    workflows,
    reporting,
    alerting,
    config.workflowLeaseSec,
    config.workflowMaxAttempts
  );
  const scheduler = new Scheduler(config, kv, sources, events, ingestion, reporting, workflow);

  return {
    config,
    db,
    raw,
    kv,
    sources,
    articles,
    events,
    briefings,
    notifications,
    workflows,
    ingestion,
    reporting,
    alerting,
    workflow,
    scheduler,
    close() {
      scheduler.stop();
      raw.close();
    },
  };
}

function resolveMigrationsFolder(): string {
  const candidates = [
    resolve(process.cwd(), "migrations"),
    resolve(process.cwd(), "dist", "migrations"),
    resolve(process.cwd(), "..", "migrations"),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`找不到数据库迁移目录，已检查：${candidates.join("；")}`);
  return found;
}
