import type { WorkflowState } from "../../shared/types";
import { yieldToEventLoop } from "../lib/async";
import { nowIso } from "../lib/time";
import { assertWorkflowTransition, createShangshuDispatch, draftByZhongshu, reviewByMenxia } from "../pipeline/governance";
import { consolidateMinistryReports, executeMinistryReports } from "../pipeline/ministry-reports";
import type { AlertingService } from "./alerting";
import type { EventStore } from "./event-store";
import type { ReportingService } from "./reporting";
import type { WorkflowStore } from "./workflow-store";

export interface WorkflowProcessResult {
  eventId: string;
  status: WorkflowState | "skipped";
  runId: string | null;
  reason: string;
}

/** 三省六部应用服务；所有决策由确定性规则产生，AI 只负责受约束的文字生成 */
export class WorkflowService {
  constructor(
    private events: EventStore,
    private store: WorkflowStore,
    private reporting: ReportingService,
    private alerting: AlertingService,
    private leaseSec: number,
    private maxAttempts: number
  ) {}

  async processDue(limit = 30): Promise<WorkflowProcessResult[]> {
    const dirty = await this.events.dirty(limit);
    const outdated = this.store.outdatedEventIds(limit);
    const ids = [...new Set([...dirty.map((event) => event.id), ...outdated])].slice(0, Math.max(1, limit));
    return this.processEventIds(ids, "scheduler");
  }

  async processEventIds(eventIds: string[], trigger: string): Promise<WorkflowProcessResult[]> {
    const results: WorkflowProcessResult[] = [];
    for (const eventId of [...new Set(eventIds)]) {
      results.push(await this.processEvent(eventId, trigger));
      await yieldToEventLoop();
    }
    return results;
  }

  async retryFailed(eventId: string, expectedRevision: number): Promise<WorkflowProcessResult | null> {
    const prepared = this.store.prepareRetry(eventId, expectedRevision);
    if (!prepared.ok) return null;
    return this.processEvent(eventId, "admin-retry");
  }

  async processEvent(eventId: string, trigger = "manual"): Promise<WorkflowProcessResult> {
    const loaded = await this.events.detailWithArticles(eventId);
    if (!loaded) return { eventId, status: "skipped", runId: null, reason: "event-not-found" };
    const { detail, articles } = loaded;
    const now = nowIso();
    const draft = draftByZhongshu({ detail, articles, now });
    const acquired = this.store.acquireRun(eventId, draft.inputHash, trigger, this.leaseSec);
    if (!acquired.shouldProcess) {
      return { eventId, status: "skipped", runId: acquired.runId, reason: acquired.reason };
    }
    await yieldToEventLoop();

    try {
      this.store.saveAssignments(eventId, acquired.runId, acquired.attempt, draft.assignments);
      assertWorkflowTransition("pending", "proposed");
      this.store.saveProposal(eventId, acquired.runId, acquired.attempt, draft.proposal);
      await yieldToEventLoop();

      const review = reviewByMenxia({ detail, articles, now }, draft.proposal);
      assertWorkflowTransition("proposed", review.decision === "approve" ? "approved" : "remanded");
      this.store.saveReview(eventId, acquired.runId, acquired.attempt, review);
      if (review.decision === "remand") {
        await yieldToEventLoop();
        this.store.clearDirtyAfterRemand(eventId, acquired.runId, acquired.attempt, detail.version, detail.lastUpdateAt);
        return { eventId, status: "remanded", runId: acquired.runId, reason: "evidence-gaps" };
      }

      const dispatch = createShangshuDispatch(nowIso());
      assertWorkflowTransition("approved", "dispatched");
      this.store.saveDispatch(eventId, acquired.runId, acquired.attempt, dispatch);

      const reportAttempt = this.store.initializeMinistryReports(eventId, acquired.runId, acquired.attempt);
      this.store.markMinistryReportsRunning(eventId, acquired.runId, reportAttempt, draft.assignments);
      this.store.renewLease(eventId, acquired.runId, acquired.attempt, this.leaseSec);
      await yieldToEventLoop();
      const reportArtifacts = await executeMinistryReports({ detail, articles, now }, draft.assignments);
      const reportErrors: string[] = [];
      for (const report of reportArtifacts) {
        try {
          this.store.saveMinistryReport(eventId, acquired.runId, reportAttempt, report);
        } catch (error) {
          const message = safeMessage(error);
          reportErrors.push(`${report.ministry}: ${message}`);
          this.store.failMinistryReport(eventId, acquired.runId, reportAttempt, report.ministry, message);
        }
        await yieldToEventLoop();
      }
      const reportsReady = reportErrors.length === 0 && this.store.ministryReportsReady(acquired.runId, acquired.attempt);
      dispatch.actions.ministries = reportsReady ? "completed" : "failed";
      dispatch.ministryDigest = reportsReady ? consolidateMinistryReports(reportArtifacts) : null;
      if (!reportsReady) dispatch.errors.push(...reportErrors, "六部报告未全部到达可汇总终态。");
      this.store.updateDispatch(eventId, acquired.runId, acquired.attempt, dispatch);
      if (!reportsReady) throw new Error("六部报告执行未完成");

      let refreshed: Awaited<ReturnType<ReportingService["refreshEvent"]>>;
      try {
        this.store.renewLease(eventId, acquired.runId, acquired.attempt, this.leaseSec);
        await yieldToEventLoop();
        refreshed = await this.reporting.refreshEvent(eventId);
        if (!refreshed) throw new Error("摘要刷新后未能读取事件");
        dispatch.actions.summary = "completed";
        dispatch.summaryEngine = refreshed.summaryEngine;
      } catch (error) {
        dispatch.actions.summary = "failed";
        dispatch.errors.push(`摘要：${safeMessage(error)}`);
        this.store.updateDispatch(eventId, acquired.runId, acquired.attempt, dispatch);
        throw error;
      }
      this.store.updateDispatch(eventId, acquired.runId, acquired.attempt, dispatch);
      await yieldToEventLoop();

      try {
        this.store.renewLease(eventId, acquired.runId, acquired.attempt, this.leaseSec);
        await yieldToEventLoop();
        const latest = refreshed || (await this.events.detail(eventId));
        if (!latest) throw new Error("提醒评估前未能读取事件");
        await this.alerting.evaluateEvent(latest);
        dispatch.actions.alerts = "completed";
      } catch (error) {
        dispatch.actions.alerts = "failed";
        dispatch.errors.push(`提醒：${safeMessage(error)}`);
        this.store.updateDispatch(eventId, acquired.runId, acquired.attempt, dispatch);
        throw error;
      }
      this.store.updateDispatch(eventId, acquired.runId, acquired.attempt, dispatch);
      await yieldToEventLoop();
      dispatch.completedAt = nowIso();
      assertWorkflowTransition("dispatched", "completed");
      this.store.complete(eventId, acquired.runId, acquired.attempt, dispatch);
      return { eventId, status: "completed", runId: acquired.runId, reason: "workflow-completed" };
    } catch (error) {
      const message = safeMessage(error);
      const recorded = this.store.fail(eventId, acquired.runId, acquired.attempt, "WORKFLOW_EXECUTION_FAILED", message, this.maxAttempts);
      return {
        eventId,
        status: recorded ? "failed" : "skipped",
        runId: acquired.runId,
        reason: recorded ? message : `superseded-run: ${message}`,
      };
    }
  }
}

function safeMessage(error: unknown): string {
  return String(error instanceof Error ? error.message : error).replace(/\s+/g, " ").slice(0, 500);
}
