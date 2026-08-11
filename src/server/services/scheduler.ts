import type { BriefingType } from "../../shared/types";
import type { Config } from "../config";
import { executeGdeltSearchPlan } from "../pipeline/search";
import type { KV } from "../lib/kv";
import { localDateKey, localHm, nowIso } from "../lib/time";
import type { EventStore } from "./event-store";
import type { IngestionService } from "./ingestion";
import type { ReportingService } from "./reporting";
import type { WorkflowProcessResult, WorkflowService } from "./workflow";
import type { SourceStore } from "./source-store";

export interface SchedulerState {
  running: boolean;
  tickInProgress: boolean;
  lastTickAt: string | null;
  lastTickError: string | null;
  lastIngestAdded: number;
  lastRefreshedEvents: number;
  lastWorkflowCompleted: number;
  lastWorkflowRemanded: number;
  lastWorkflowFailed: number;
}

interface SchedulerRuntimeRecord {
  instanceId: string;
  heartbeatAt: string;
  state: SchedulerState;
}

const SCHEDULER_RUNTIME_KEY = "scheduler:runtime";
const SCHEDULER_TICK_REQUEST_KEY = "scheduler:tick-request";
const SCHEDULER_RUNTIME_TTL_SEC = 5 * 60;
const SCHEDULER_RUNTIME_FRESH_MS = 2 * 60_000;

/** 7×24 调度器：短周期 tick + 数据库/KV 锁，重启后也不会重复生成同一简报 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private initialTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private readonly instanceId = `${process.pid}:${Date.now()}`;
  private state_: SchedulerState = {
    running: false,
    tickInProgress: false,
    lastTickAt: null,
    lastTickError: null,
    lastIngestAdded: 0,
    lastRefreshedEvents: 0,
    lastWorkflowCompleted: 0,
    lastWorkflowRemanded: 0,
    lastWorkflowFailed: 0,
  };

  constructor(
    private config: Config,
    private kv: KV,
    private sources: SourceStore,
    private events: EventStore,
    private ingestion: IngestionService,
    private reporting: ReportingService,
    private workflow: WorkflowService
  ) {}

  state(): SchedulerState {
    return { ...this.state_ };
  }

  /** Web 与调度进程分离时，从共享 SQLite 心跳读取真实调度状态。 */
  async stateForApi(): Promise<SchedulerState> {
    if (this.state_.running) return this.state();
    const runtime = await this.kv.getJson<SchedulerRuntimeRecord>(SCHEDULER_RUNTIME_KEY);
    if (!runtime || !runtime.state || !runtime.heartbeatAt) return this.state();
    const heartbeatMs = Date.parse(runtime.heartbeatAt);
    if (!Number.isFinite(heartbeatMs) || Date.now() - heartbeatMs > SCHEDULER_RUNTIME_FRESH_MS) return this.state();
    return { ...runtime.state };
  }

  start(initialDelayMs = 0): void {
    if (this.timer) return;
    this.state_.running = true;
    void this.persistRuntimeState().catch((error) => {
      console.warn(`[调度器] 启动心跳写入失败: ${safeMessage(error)}`);
    });
    if (initialDelayMs > 0) {
      this.initialTimer = setTimeout(() => {
        this.initialTimer = null;
        void this.tick();
      }, initialDelayMs);
    } else {
      void this.tick();
    }
    this.timer = setInterval(() => void this.tick(), 60_000);
    this.heartbeatTimer = setInterval(() => void this.heartbeat(), 10_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.timer = null;
    this.initialTimer = null;
    this.heartbeatTimer = null;
    this.state_.running = false;
  }

  async stopAndPersist(): Promise<void> {
    this.stop();
    await this.persistRuntimeState();
  }

  /** 外置调度模式下，管理 API 通过共享键请求尽快执行一次 tick。 */
  async requestTick(): Promise<SchedulerState> {
    await this.kv.set(SCHEDULER_TICK_REQUEST_KEY, nowIso(), SCHEDULER_RUNTIME_TTL_SEC);
    return this.stateForApi();
  }

  async tick(force = false): Promise<SchedulerState> {
    if (this.state_.tickInProgress && !force) return this.state();
    this.state_.tickInProgress = true;
    this.state_.lastTickAt = nowIso();
    this.state_.lastTickError = null;
    try {
      await this.persistRuntimeState();
      const ingestionResults = await this.ingestion.runDue(2);
      this.state_.lastIngestAdded = ingestionResults.reduce((sum, result) => sum + result.added, 0);
      const pendingEventIds = await this.ingestion.processPending(20);
      const touchedEventIds = [...new Set([...ingestionResults.flatMap((result) => result.eventIds), ...pendingEventIds])];
      const workflowBudget = Math.max(1, Math.min(this.config.workflowBatchSize, 8));
      const workflowResults: WorkflowProcessResult[] = [];
      if (touchedEventIds.length > 0) {
        workflowResults.push(...await this.workflow.processEventIds(touchedEventIds.slice(0, workflowBudget), "ingestion"));
      }
      const dueBudget = workflowBudget - workflowResults.length;
      if (dueBudget > 0) workflowResults.push(...await this.workflow.processDue(dueBudget));

      await this.runScheduledBriefings();
      workflowResults.push(...await this.runActiveSearch(Math.max(0, workflowBudget - workflowResults.length)));
      this.state_.lastRefreshedEvents = workflowResults.filter((result) => result.status === "completed").length;
      this.state_.lastWorkflowCompleted = this.state_.lastRefreshedEvents;
      this.state_.lastWorkflowRemanded = workflowResults.filter((result) => result.status === "remanded").length;
      this.state_.lastWorkflowFailed = workflowResults.filter((result) => result.status === "failed").length;
      await this.kv.cleanup();
    } catch (error) {
      this.state_.lastTickError = safeMessage(error);
      console.error(`[调度器] tick 失败: ${this.state_.lastTickError}`);
    } finally {
      this.state_.tickInProgress = false;
      try {
        await this.persistRuntimeState();
      } catch (error) {
        console.warn(`[调度器] 终态心跳写入失败: ${safeMessage(error)}`);
      }
    }
    return this.state();
  }

  private async heartbeat(): Promise<void> {
    try {
      await this.persistRuntimeState();
      if (this.state_.tickInProgress || !(await this.kv.get(SCHEDULER_TICK_REQUEST_KEY))) return;
      await this.kv.delete(SCHEDULER_TICK_REQUEST_KEY);
      void this.tick();
    } catch (error) {
      console.warn(`[调度器] 心跳写入失败: ${safeMessage(error)}`);
    }
  }

  private async persistRuntimeState(): Promise<void> {
    await this.kv.setJson(
      SCHEDULER_RUNTIME_KEY,
      { instanceId: this.instanceId, heartbeatAt: nowIso(), state: this.state() } satisfies SchedulerRuntimeRecord,
      SCHEDULER_RUNTIME_TTL_SEC
    );
  }

  private async runScheduledBriefings(): Promise<void> {
    const now = new Date();
    const dateKey = localDateKey(now, this.config.defaultTz);
    const hm = localHm(now, this.config.defaultTz);
    const scheduled: Array<[BriefingType, string]> = [
      ["morning", "07:00"],
      ["noon", "12:30"],
      ["evening", "19:00"],
    ];
    for (const [type, at] of scheduled) {
      if (hm < at) continue;
      const key = `briefing-lock:${dateKey}:${type}`;
      if (await this.kv.get(key)) continue;
      await this.reporting.createBriefing(type, this.config.defaultTz);
      await this.kv.set(key, nowIso(), 3 * 24 * 3600);
    }

    // 每小时第 5 分钟后生成一次过去一小时变化，错过精确时刻也能补跑
    const hour = hm.slice(0, 2);
    const minute = Number(hm.slice(3, 5));
    const hourlyKey = `briefing-lock:${dateKey}:hourly:${hour}`;
    if (minute >= 5 && !(await this.kv.get(hourlyKey))) {
      await this.reporting.createBriefing("hourly", this.config.defaultTz);
      await this.kv.set(hourlyKey, nowIso(), 30 * 3600);
    }
  }

  /**
   * 重大事件主动多语言扩展搜索。GDELT 公共 API 曾出现限流，因此：
   * 每事件 30 分钟最多一次、每次只执行优先级最高的 3 个语言查询、并发 1。
   */
  private async runActiveSearch(workflowBudget: number): Promise<WorkflowProcessResult[]> {
    const workflowResults: WorkflowProcessResult[] = [];
    const attemptedEventIds = new Set<string>();
    const gdelt = await this.sources.get("gdelt-crisis-index");
    if (!gdelt) return workflowResults;
    const activeIds = this.events.recentBreakingEventIds(new Date(Date.now() - 48 * 3_600_000).toISOString(), 2);
    for (const eventId of activeIds) {
      const lock = `active-search:${eventId}`;
      if (await this.kv.get(lock)) continue;
      const plan = await this.reporting.searchPlan(eventId);
      if (!plan || plan.queries.length === 0) continue;
      await this.kv.set(lock, nowIso(), 30 * 60);
      const limitedPlan = { ...plan, queries: plan.queries.slice(0, 3).map((query) => ({ ...query, maxRecords: 20 })) };
      try {
        const execution = await executeGdeltSearchPlan(
          limitedPlan,
          {
            kv: this.kv,
            rsshubBase: this.config.rsshubBase,
            assumeOffsetMin: 0,
            fetchOpts: {
              userAgent: this.config.userAgent,
              timeoutMs: 20_000,
              maxBytes: 3 * 1024 * 1024,
            },
          },
          { concurrency: 1 }
        );
        if (execution.items.length > 0) {
          const eventIds = await this.ingestion.ingestItems(gdelt, execution.items);
          const remainingBudget = workflowBudget - attemptedEventIds.size;
          const eligibleEventIds = [...new Set(eventIds)]
            .filter((id) => !attemptedEventIds.has(id))
            .slice(0, Math.max(0, remainingBudget));
          for (const eventId of eligibleEventIds) attemptedEventIds.add(eventId);
          if (eligibleEventIds.length > 0) {
            workflowResults.push(...await this.workflow.processEventIds(eligibleEventIds, "active-search"));
          }
        }
      } catch (error) {
        console.warn(`[主动搜索] 事件 ${eventId} 扩展失败: ${safeMessage(error)}`);
      }
    }
    return workflowResults;
  }
}

function safeMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 500);
}
