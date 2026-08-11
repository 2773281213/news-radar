import type Database from "better-sqlite3";
import type {
  DepartmentCode,
  EventWorkflowDTO,
  GovernanceSnapshotDTO,
  MenxiaReviewDTO,
  MinistryAssignmentDTO,
  MinistryCode,
  MinistryReportProgressDTO,
  MinistryReportStatus,
  MinistryWorkReportDTO,
  ShangshuDispatchDTO,
  WorkflowState,
  WorkflowSummaryDTO,
  WorkflowTransitionDTO,
  ZhongshuProposalDTO,
} from "../../shared/types";
import { shortId } from "../lib/hash";
import { nowIso } from "../lib/time";
import { ministryCodes, THREE_DEPARTMENTS_RULES_VERSION } from "../pipeline/ministries";

interface CaseRow {
  event_id: string;
  status: string;
  current_department: string;
  revision: number;
  rules_version: string;
  input_hash: string;
  active_run_id: string | null;
  proposal: string | null;
  review: string | null;
  dispatch: string | null;
  publishable: number;
  last_error_code: string | null;
  created_at: string;
  updated_at: string;
  approved_at: string | null;
  completed_at: string | null;
}

interface RunRow {
  id: string;
  status: string;
  attempt: number;
  lease_until: string | null;
  next_attempt_at: string | null;
}

interface MinistryReportRow {
  id: number;
  run_id: string;
  event_id: string;
  ministry: string;
  attempt: number;
  status: string;
  findings: string;
  risks: string;
  evidence_gaps: string;
  actions: string;
  citations: string;
  claim_refs: string;
  rules_version: string;
  started_at: string | null;
  completed_at: string | null;
  error_code: string | null;
  error_detail: string | null;
}

type MinistryReportResult = Pick<
  MinistryWorkReportDTO,
  "ministry" | "status" | "findings" | "risks" | "evidenceGaps" | "actions" | "citations" | "claimRefs"
>;

export interface AcquireRunResult {
  runId: string;
  attempt: number;
  shouldProcess: boolean;
  reason: "new" | "retry" | "already-finished" | "leased" | "backoff";
}

export interface WorkflowHealth {
  backlog: number;
  running: number;
  remanded: number;
  failed: number;
  completed: number;
  lastCompletedAt: string | null;
}

/** 工作流持久化：当前投影、逻辑运行、六部分派和追加式迁移日志 */
export class WorkflowStore {
  constructor(private raw: Database.Database) {}

  acquireRun(eventId: string, inputHash: string, trigger: string, leaseSec: number): AcquireRunResult {
    const runId = `wfr_${shortId(`${eventId}\n${inputHash}\n${THREE_DEPARTMENTS_RULES_VERSION}`, 24)}`;
    const at = nowIso();
    const leaseUntil = new Date(Date.parse(at) + leaseSec * 1000).toISOString();
    const tx = this.raw.transaction((): AcquireRunResult => {
      const active = this.raw.prepare(`
        SELECT wr.id, wr.status, wr.attempt, wr.lease_until, wr.next_attempt_at
        FROM workflow_cases wc
        JOIN workflow_runs wr ON wr.id = wc.active_run_id
        WHERE wc.event_id = ?
      `).get(eventId) as RunRow | undefined;
      if (active && active.id !== runId && active.status === "running" && active.lease_until && active.lease_until > at) {
        return { runId: active.id, attempt: active.attempt, shouldProcess: false, reason: "leased" };
      }
      const existing = this.raw.prepare("SELECT id, status, attempt, lease_until, next_attempt_at FROM workflow_runs WHERE id = ?").get(runId) as RunRow | undefined;
      if (existing) {
        if (existing.status === "completed" || existing.status === "remanded") {
          return { runId, attempt: existing.attempt, shouldProcess: false, reason: "already-finished" };
        }
        if (existing.status === "running" && existing.lease_until && existing.lease_until > at) {
          return { runId, attempt: existing.attempt, shouldProcess: false, reason: "leased" };
        }
        if (existing.next_attempt_at && existing.next_attempt_at > at) {
          return { runId, attempt: existing.attempt, shouldProcess: false, reason: "backoff" };
        }
        this.raw.prepare(`
          UPDATE workflow_runs
          SET status = 'running', attempt = attempt + 1, lease_until = ?, next_attempt_at = NULL,
              started_at = ?, finished_at = NULL, error_code = NULL, error_detail = NULL
          WHERE id = ?
        `).run(leaseUntil, at, runId);
        this.resetCase(eventId, runId, inputHash, at);
        return { runId, attempt: existing.attempt + 1, shouldProcess: true, reason: "retry" };
      }

      this.raw.prepare(`
        INSERT INTO workflow_runs(
          id, event_id, input_hash, rules_version, trigger, status, attempt, lease_until, started_at
        ) VALUES (?, ?, ?, ?, ?, 'running', 1, ?, ?)
      `).run(runId, eventId, inputHash, THREE_DEPARTMENTS_RULES_VERSION, trigger.slice(0, 100), leaseUntil, at);
      this.resetCase(eventId, runId, inputHash, at);
      return { runId, attempt: 1, shouldProcess: true, reason: "new" };
    });
    return tx();
  }

  renewLease(eventId: string, runId: string, attempt: number, leaseSec: number): void {
    const at = nowIso();
    const leaseUntil = new Date(Date.parse(at) + leaseSec * 1000).toISOString();
    const tx = this.raw.transaction(() => {
      this.assertActiveAttempt(eventId, runId, attempt);
      const result = this.raw.prepare(`
        UPDATE workflow_runs SET lease_until = ?
        WHERE id = ? AND event_id = ? AND attempt = ? AND status = 'running'
      `).run(leaseUntil, runId, eventId, attempt);
      if (result.changes !== 1) throw new Error(`工作流租约续期失败：${runId}#${attempt}`);
    });
    tx();
  }

  private resetCase(eventId: string, runId: string, inputHash: string, at: string): void {
    this.raw.prepare(`
      INSERT INTO workflow_cases(
        event_id, status, current_department, revision, rules_version, input_hash, active_run_id,
        publishable, created_at, updated_at
      ) VALUES (?, 'pending', 'zhongshu', 1, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(event_id) DO UPDATE SET
        status = 'pending', current_department = 'zhongshu', revision = workflow_cases.revision + 1,
        rules_version = excluded.rules_version, input_hash = excluded.input_hash,
        active_run_id = excluded.active_run_id, proposal = NULL, review = NULL, dispatch = NULL,
        publishable = 0, last_error_code = NULL, updated_at = excluded.updated_at,
        approved_at = NULL, completed_at = NULL
    `).run(eventId, THREE_DEPARTMENTS_RULES_VERSION, inputHash, runId, at, at);
  }

  saveAssignments(eventId: string, runId: string, attempt: number, assignments: MinistryAssignmentDTO[]): void {
    const at = nowIso();
    const tx = this.raw.transaction(() => {
      this.assertActiveAttempt(eventId, runId, attempt, "pending");
      const insert = this.raw.prepare(`
        INSERT INTO workflow_ministry_assignments(run_id, event_id, ministry, score, is_primary, reasons, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(run_id, ministry) DO UPDATE SET
          score = excluded.score, is_primary = excluded.is_primary, reasons = excluded.reasons
      `);
      for (const assignment of assignments) {
        insert.run(
          runId,
          eventId,
          assignment.ministry,
          assignment.score,
          assignment.primary ? 1 : 0,
          JSON.stringify(assignment.reasons),
          at
        );
      }
    });
    tx();
  }

  /** 为当前 workflow attempt 建立六部工作单；即便未分派也保留 blocked 终态报告。 */
  initializeMinistryReports(eventId: string, runId: string, attempt: number): number {
    const at = nowIso();
    const insert = this.raw.prepare(`
      INSERT INTO workflow_ministry_reports(
        run_id, event_id, ministry, attempt, status, findings, risks, evidence_gaps,
        actions, citations, claim_refs, rules_version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', '[]', '[]', '[]', '[]', '[]', '[]', ?, ?, ?)
      ON CONFLICT(run_id, ministry, attempt) DO NOTHING
    `);
    const tx = this.raw.transaction(() => {
      this.assertActiveAttempt(eventId, runId, attempt, "dispatched");
      for (const ministry of ministryCodes()) {
        insert.run(runId, eventId, ministry, attempt, THREE_DEPARTMENTS_RULES_VERSION, at, at);
      }
    });
    tx();
    return attempt;
  }

  markMinistryReportsRunning(eventId: string, runId: string, attempt: number, assignments: MinistryAssignmentDTO[]): void {
    const at = nowIso();
    const update = this.raw.prepare(`
      UPDATE workflow_ministry_reports
      SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?,
          completed_at = NULL, error_code = NULL, error_detail = NULL
      WHERE run_id = ? AND ministry = ? AND attempt = ? AND status IN ('pending','failed')
    `);
    const tx = this.raw.transaction(() => {
      this.assertActiveAttempt(eventId, runId, attempt, "dispatched");
      for (const assignment of assignments) {
        const result = update.run(at, at, runId, assignment.ministry, attempt);
        if (result.changes !== 1) throw new Error(`六部工作单无法转入办理：${assignment.ministry}#${attempt}`);
      }
    });
    tx();
  }

  saveMinistryReport(eventId: string, runId: string, attempt: number, report: MinistryReportResult): void {
    if (report.status !== "completed" && report.status !== "blocked") throw new Error(`非法六部报告终态：${report.status}`);
    const at = nowIso();
    const tx = this.raw.transaction(() => {
      this.assertActiveAttempt(eventId, runId, attempt, "dispatched");
      const result = this.raw.prepare(`
        UPDATE workflow_ministry_reports
        SET status = ?, findings = ?, risks = ?, evidence_gaps = ?, actions = ?, citations = ?,
            claim_refs = ?, started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ?,
            error_code = NULL, error_detail = NULL
        WHERE run_id = ? AND event_id = ? AND ministry = ? AND attempt = ?
      `).run(
        report.status,
        JSON.stringify(report.findings),
        JSON.stringify(report.risks),
        JSON.stringify(report.evidenceGaps),
        JSON.stringify(report.actions),
        JSON.stringify(report.citations),
        JSON.stringify(report.claimRefs),
        at,
        at,
        at,
        runId,
        eventId,
        report.ministry,
        attempt
      );
      if (result.changes !== 1) throw new Error(`六部工作单不存在：${report.ministry}#${attempt}`);
      this.appendMinistryAudit(eventId, runId, attempt, report.ministry, report.status, report.findings, report.claimRefs, report.citations.length);
    });
    tx();
  }

  failMinistryReport(eventId: string, runId: string, attempt: number, ministry: MinistryCode, detail: string): void {
    const at = nowIso();
    const safeDetail = detail.replace(/\s+/g, " ").slice(0, 500);
    const tx = this.raw.transaction(() => {
      this.assertActiveAttempt(eventId, runId, attempt, "dispatched");
      const result = this.raw.prepare(`
        UPDATE workflow_ministry_reports
        SET status = 'failed', started_at = COALESCE(started_at, ?), completed_at = ?, updated_at = ?,
            error_code = 'MINISTRY_ANALYSIS_FAILED', error_detail = ?
        WHERE run_id = ? AND event_id = ? AND ministry = ? AND attempt = ?
      `).run(at, at, at, safeDetail, runId, eventId, ministry, attempt);
      if (result.changes !== 1) throw new Error(`六部工作单不存在：${ministry}#${attempt}`);
      this.appendMinistryAudit(eventId, runId, attempt, ministry, "failed", [safeDetail], [], 0);
    });
    tx();
  }

  updateDispatch(eventId: string, runId: string, attempt: number, dispatch: ShangshuDispatchDTO): void {
    const tx = this.raw.transaction(() => {
      this.assertActiveAttempt(eventId, runId, attempt, "dispatched");
      const result = this.raw.prepare(`
        UPDATE workflow_cases SET dispatch = ?, updated_at = ?
        WHERE event_id = ? AND active_run_id = ?
      `).run(JSON.stringify(dispatch), nowIso(), eventId, runId);
      if (result.changes !== 1) throw new Error(`尚书执行令写入失败：${runId}#${attempt}`);
    });
    tx();
  }

  saveProposal(eventId: string, runId: string, attempt: number, proposal: ZhongshuProposalDTO): void {
    this.transition(eventId, runId, attempt, "pending", "proposed", "zhongshu", "proposal_drafted", "EVIDENCE_SYNTHESIZED", proposal.rationale, {
      proposal,
    });
  }

  saveReview(eventId: string, runId: string, attempt: number, review: MenxiaReviewDTO): void {
    const approved = review.decision === "approve";
    this.transition(
      eventId,
      runId,
      attempt,
      "proposed",
      approved ? "approved" : "remanded",
      "menxia",
      approved ? "review_approved" : "review_remanded",
      approved ? "EVIDENCE_THRESHOLD_MET" : "EVIDENCE_GAPS_BLOCKING",
      review.rationale,
      { review, approvedAt: approved ? nowIso() : null }
    );
    if (!approved) this.finishRun(runId, attempt, "remanded");
  }

  saveDispatch(eventId: string, runId: string, attempt: number, dispatch: ShangshuDispatchDTO): void {
    this.transition(eventId, runId, attempt, "approved", "dispatched", "shangshu", "execution_dispatched", "APPROVED_FOR_EXECUTION", ["门下省已准奏，尚书省下达执行令：六部先行专责分析，再汇总摘要并评估提醒。"], {
      dispatch,
    });
  }

  complete(eventId: string, runId: string, attempt: number, dispatch: ShangshuDispatchDTO): void {
    if (!this.ministryReportsReady(runId, attempt)) throw new Error("六部报告尚未全部到达可汇总终态");
    if (Object.values(dispatch.actions).some((status) => status !== "completed")) {
      throw new Error("尚书执行令仍有未完成动作，禁止成报");
    }
    this.transition(eventId, runId, attempt, "dispatched", "completed", "shangshu", "execution_completed", "PUBLICATION_ACTIONS_COMPLETED", ["六部专责报告、摘要与提醒动作均已完成，尚书省汇总成报。"], {
      dispatch,
      publishable: true,
      completedAt: dispatch.completedAt || nowIso(),
    });
    this.finishRun(runId, attempt, "completed");
  }

  ministryReportsReady(runId: string, attempt: number): boolean {
    if (this.runAttempt(runId) !== attempt) return false;
    const reports = this.ministryReports(runId, attempt);
    if (reports.length !== ministryCodes().length) return false;
    if (reports.some((report) => report.status !== "completed" && report.status !== "blocked")) return false;
    const assigned = new Set(this.assignments(runId).map((assignment) => assignment.ministry));
    return reports.every((report) => assigned.has(report.ministry) ? report.status === "completed" : report.status === "blocked");
  }

  fail(eventId: string, runId: string, attempt: number, errorCode: string, detail: string, maxAttempts: number): boolean {
    const backoffSec = Math.min(3600, 30 * 2 ** Math.max(0, attempt - 1));
    const nextAttemptAt = attempt >= maxAttempts ? null : new Date(Date.now() + backoffSec * 1000).toISOString();
    const at = nowIso();
    const safeDetail = detail.replace(/\s+/g, " ").slice(0, 500);
    const tx = this.raw.transaction((): boolean => {
      const run = this.raw.prepare("SELECT status, attempt FROM workflow_runs WHERE id = ? AND event_id = ?").get(runId, eventId) as RunRow | undefined;
      if (!run || run.status !== "running" || run.attempt !== attempt) return false;
      const current = this.caseRow(eventId);
      const isActive = current?.active_run_id === runId;
      if (isActive && current && current.status !== "failed" && current.status !== "completed" && current.status !== "remanded") {
        const attemptKey = `${runId}:attempt:${attempt}:${current.current_department}:technical_failure`;
        this.insertTransition(current, runId, "failed", current.current_department as DepartmentCode, "technical_failure", errorCode, [safeDetail], { errorCode }, attemptKey);
      }
      if (isActive && current && current.status !== "completed" && current.status !== "remanded") {
        const caseResult = this.raw.prepare(`
          UPDATE workflow_cases SET status = 'failed', last_error_code = ?, updated_at = ?, publishable = 0
          WHERE event_id = ? AND active_run_id = ?
        `).run(errorCode, at, eventId, runId);
        if (caseResult.changes !== 1) throw new Error(`工作流失败状态写入失败：${runId}#${attempt}`);
      }
      const runResult = this.raw.prepare(`
        UPDATE workflow_runs SET status = 'failed', lease_until = NULL, next_attempt_at = ?, finished_at = ?, error_code = ?, error_detail = ?
        WHERE id = ? AND event_id = ? AND attempt = ? AND status = 'running'
      `).run(nextAttemptAt, at, errorCode, safeDetail, runId, eventId, attempt);
      if (runResult.changes !== 1) throw new Error(`工作流运行失败状态写入失败：${runId}#${attempt}`);
      return isActive;
    });
    return tx();
  }

  clearDirtyAfterRemand(
    eventId: string,
    runId: string,
    attempt: number,
    expectedVersion: number,
    expectedLastUpdateAt: string
  ): boolean {
    const tx = this.raw.transaction((): boolean => {
      const current = this.caseRow(eventId);
      if (!current || current.active_run_id !== runId || current.status !== "remanded") return false;
      const run = this.raw.prepare(`
        SELECT status, attempt FROM workflow_runs WHERE id = ? AND event_id = ?
      `).get(runId, eventId) as RunRow | undefined;
      if (!run || run.status !== "remanded" || run.attempt !== attempt) return false;
      const result = this.raw.prepare(`
        UPDATE events SET dirty = 0
        WHERE id = ? AND dirty = 1 AND version = ? AND last_update_at = ?
      `).run(eventId, expectedVersion, expectedLastUpdateAt);
      return result.changes === 1;
    });
    return tx();
  }

  detail(eventId: string, limit = 100, before?: number): EventWorkflowDTO | null {
    const row = this.caseRow(eventId);
    if (!row || !row.active_run_id) return null;
    const assignments = this.assignments(row.active_run_id);
    const args: unknown[] = [eventId];
    let cursor = "";
    if (before) {
      cursor = " AND id < ?";
      args.push(before);
    }
    args.push(Math.min(Math.max(limit, 1), 200) + 1);
    const rows = this.raw.prepare(`
      SELECT * FROM workflow_transitions WHERE event_id = ?${cursor} ORDER BY id DESC LIMIT ?
    `).all(...args) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const sliced = rows.slice(0, limit);
    return {
      workflow: this.mapSummary(row, assignments),
      proposal: parseJson<ZhongshuProposalDTO | null>(row.proposal, null),
      review: parseJson<MenxiaReviewDTO | null>(row.review, null),
      dispatch: parseJson<ShangshuDispatchDTO | null>(row.dispatch, null),
      ministryReports: this.ministryReports(row.active_run_id, this.runAttempt(row.active_run_id), assignments),
      transitions: sliced.map(mapTransition),
      nextBefore: hasMore ? Number(sliced[sliced.length - 1]?.id || 0) : null,
    };
  }

  summary(eventId: string): WorkflowSummaryDTO | null {
    const row = this.caseRow(eventId);
    return row && row.active_run_id ? this.mapSummary(row, this.assignments(row.active_run_id)) : null;
  }

  summaries(eventIds: string[]): Map<string, WorkflowSummaryDTO> {
    return new Map(
      [...this.snapshots(eventIds)].map(([eventId, snapshot]) => [eventId, snapshot.workflow])
    );
  }

  /** 列表与简报共用的批量审议投影，固定三次 SQL，不随事件数量增长。 */
  snapshots(eventIds: readonly string[]): Map<string, GovernanceSnapshotDTO> {
    const ids = [...new Set(eventIds)].slice(0, 500);
    const output = new Map<string, GovernanceSnapshotDTO>();
    if (ids.length === 0) return output;
    const rows = this.raw.prepare(`
      SELECT * FROM workflow_cases
      WHERE event_id IN (${ids.map(() => "?").join(",")})
        AND active_run_id IS NOT NULL
    `).all(...ids) as CaseRow[];
    const runIds = rows.flatMap((row) => row.active_run_id ? [row.active_run_id] : []);
    const assignmentsByRun = this.assignmentsForRuns(runIds);
    const progressByRun = this.progressForRuns(runIds);
    for (const row of rows) {
      if (!row.active_run_id) continue;
      output.set(row.event_id, {
        workflow: this.mapSummaryWithProgress(
          row,
          assignmentsByRun.get(row.active_run_id) || [],
          progressByRun.get(row.active_run_id) || emptyMinistryProgress()
        ),
        proposal: parseJson<ZhongshuProposalDTO | null>(row.proposal, null),
        review: parseJson<MenxiaReviewDTO | null>(row.review, null),
        dispatch: parseJson<ShangshuDispatchDTO | null>(row.dispatch, null),
      });
    }
    return output;
  }

  prepareRetry(eventId: string, expectedRevision: number): { ok: boolean; reason?: string } {
    const tx = this.raw.transaction((): { ok: boolean; reason?: string } => {
      const row = this.caseRow(eventId);
      if (!row) return { ok: false, reason: "not-found" };
      if (row.revision !== expectedRevision) return { ok: false, reason: "revision-conflict" };
      if (row.status !== "failed" || !row.active_run_id) return { ok: false, reason: "not-retryable" };
      const result = this.raw.prepare(`
        UPDATE workflow_runs SET status = 'failed', lease_until = NULL, next_attempt_at = NULL
        WHERE id = ? AND event_id = ? AND status = 'failed'
      `).run(row.active_run_id, eventId);
      return result.changes === 1 ? { ok: true } : { ok: false, reason: "not-retryable" };
    });
    return tx();
  }

  adminList(filters: { status?: string; department?: string; ministry?: string; limit: number; offset: number }): Array<Record<string, unknown>> {
    const where = ["1=1"];
    const args: unknown[] = [];
    if (filters.status) {
      where.push("wc.status = ?");
      args.push(filters.status);
    }
    if (filters.department) {
      where.push("wc.current_department = ?");
      args.push(filters.department);
    }
    if (filters.ministry) {
      where.push(`EXISTS (
        SELECT 1 FROM workflow_ministry_assignments wma
        WHERE wma.event_id = wc.event_id AND wma.run_id = wc.active_run_id AND wma.ministry = ?
      )`);
      args.push(filters.ministry);
    }
    args.push(filters.limit, filters.offset);
    return this.raw.prepare(`
      SELECT wc.event_id, e.title, wc.status, wc.current_department, wc.revision,
             wc.rules_version, wc.publishable, wc.last_error_code, wc.updated_at, wc.completed_at
      FROM workflow_cases wc
      JOIN events e ON e.id = wc.event_id
      WHERE ${where.join(" AND ")}
      ORDER BY wc.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...args) as Array<Record<string, unknown>>;
  }

  outdatedEventIds(limit = 100): string[] {
    const at = nowIso();
    const rows = this.raw.prepare(`
      SELECT e.id
      FROM events e
      LEFT JOIN workflow_cases wc ON wc.event_id = e.id
      LEFT JOIN workflow_runs wr ON wr.id = wc.active_run_id
      WHERE wc.event_id IS NULL
         OR wc.rules_version <> ?
         OR (wc.status = 'failed' AND wr.next_attempt_at IS NOT NULL AND wr.next_attempt_at <= ?)
         OR (wr.status = 'running' AND wr.lease_until IS NOT NULL AND wr.lease_until <= ?)
      ORDER BY e.importance DESC, e.last_update_at DESC
      LIMIT ?
    `).all(THREE_DEPARTMENTS_RULES_VERSION, at, at, Math.min(Math.max(limit, 1), 500)) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  health(): WorkflowHealth {
    const counts = this.raw.prepare(`
      SELECT
        SUM(CASE WHEN status IN ('pending','proposed','approved','dispatched') THEN 1 ELSE 0 END) AS backlog,
        SUM(CASE WHEN status = 'remanded' THEN 1 ELSE 0 END) AS remanded,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
        MAX(completed_at) AS last_completed_at
      FROM workflow_cases INDEXED BY idx_workflow_cases_health
    `).get() as Record<string, unknown>;
    const running = this.raw.prepare("SELECT count(*) AS n FROM workflow_runs WHERE status = 'running'").get() as { n: number };
    return {
      backlog: Number(counts.backlog || 0),
      running: Number(running.n || 0),
      remanded: Number(counts.remanded || 0),
      failed: Number(counts.failed || 0),
      completed: Number(counts.completed || 0),
      lastCompletedAt: counts.last_completed_at ? String(counts.last_completed_at) : null,
    };
  }

  workflowCounts(since: string): {
    pending: number;
    awaitingReview: number;
    remanded: number;
    approved: number;
    completed24h: number;
    failed: number;
  } {
    const row = this.raw.prepare(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) AS awaiting_review,
        SUM(CASE WHEN status = 'remanded' THEN 1 ELSE 0 END) AS remanded,
        SUM(CASE WHEN status IN ('approved','dispatched') THEN 1 ELSE 0 END) AS approved,
        SUM(CASE WHEN status = 'completed' AND completed_at >= ? THEN 1 ELSE 0 END) AS completed_24h,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM workflow_cases
    `).get(since) as Record<string, unknown>;
    return {
      pending: Number(row.pending || 0),
      awaitingReview: Number(row.awaiting_review || 0),
      remanded: Number(row.remanded || 0),
      approved: Number(row.approved || 0),
      completed24h: Number(row.completed_24h || 0),
      failed: Number(row.failed || 0),
    };
  }

  ministryStats(since: string): Array<{
    ministry: MinistryCode;
    activeEvents: number;
    updates24h: number;
    remanded: number;
    disputedClaims: number;
  }> {
    const rows = this.raw.prepare(`
      SELECT wma.ministry,
             COUNT(DISTINCT wma.event_id) AS active_events,
             COUNT(DISTINCT CASE WHEN e.last_update_at >= ? THEN wma.event_id END) AS updates_24h,
             COUNT(DISTINCT CASE WHEN wc.status = 'remanded' THEN wma.event_id END) AS remanded,
             COUNT(DISTINCT CASE WHEN c.status = 'disputed' THEN c.id END) AS disputed_claims
      FROM workflow_ministry_assignments wma
      JOIN workflow_cases wc ON wc.event_id = wma.event_id AND wc.active_run_id = wma.run_id
      JOIN events e ON e.id = wma.event_id
      LEFT JOIN claims c ON c.event_id = wma.event_id
      GROUP BY wma.ministry
    `).all(since) as Record<string, unknown>[];
    return rows.map((row) => ({
      ministry: String(row.ministry) as MinistryCode,
      activeEvents: Number(row.active_events || 0),
      updates24h: Number(row.updates_24h || 0),
      remanded: Number(row.remanded || 0),
      disputedClaims: Number(row.disputed_claims || 0),
    }));
  }

  recentEventIds(limit = 12): string[] {
    const rows = this.raw.prepare(`
      SELECT event_id FROM workflow_cases
      ORDER BY CASE status WHEN 'completed' THEN 0 WHEN 'remanded' THEN 1 ELSE 2 END, updated_at DESC
      LIMIT ?
    `).all(Math.min(Math.max(limit, 1), 100)) as Array<{ event_id: string }>;
    return rows.map((row) => row.event_id);
  }

  eventIdsForMinistry(ministry: MinistryCode, limit = 200): string[] {
    const rows = this.raw.prepare(`
      SELECT wma.event_id
      FROM workflow_ministry_assignments wma
      JOIN workflow_cases wc ON wc.event_id = wma.event_id AND wc.active_run_id = wma.run_id
      JOIN events e ON e.id = wma.event_id
      WHERE wma.ministry = ?
      ORDER BY wma.is_primary DESC, wma.score DESC, e.importance DESC, e.last_update_at DESC
      LIMIT ?
    `).all(ministry, Math.min(Math.max(limit, 1), 500)) as Array<{ event_id: string }>;
    return rows.map((row) => row.event_id);
  }

  reportsForMinistry(ministry: MinistryCode, eventIds: string[], limit = 200): MinistryWorkReportDTO[] {
    const ids = [...new Set(eventIds)].slice(0, 500);
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.raw.prepare(`
      SELECT wmr.*, wma.score AS assignment_score, wma.is_primary AS assignment_primary,
             wma.reasons AS assignment_reasons
      FROM workflow_ministry_reports wmr
      JOIN workflow_cases wc ON wc.event_id = wmr.event_id AND wc.active_run_id = wmr.run_id
      JOIN workflow_runs wr ON wr.id = wmr.run_id AND wr.attempt = wmr.attempt
      LEFT JOIN workflow_ministry_assignments wma
        ON wma.run_id = wmr.run_id AND wma.ministry = wmr.ministry
      WHERE wmr.ministry = ? AND wmr.event_id IN (${placeholders})
      ORDER BY wmr.updated_at DESC
      LIMIT ?
    `).all(ministry, ...ids, Math.min(Math.max(limit, 1), 500)) as Array<MinistryReportRow & Record<string, unknown>>;
    return rows.map((row) => this.mapMinistryReport(row, assignmentFromJoinedRow(row)));
  }

  private appendMinistryAudit(
    eventId: string,
    runId: string,
    attempt: number,
    ministry: MinistryCode,
    status: MinistryReportStatus,
    findings: string[],
    claimRefs: string[],
    citationCount: number
  ): void {
    const current = this.caseRow(eventId);
    if (!current) throw new Error("工作流投影不存在");
    const rationale = status === "completed"
      ? [`${ministry}专责报告完成，形成 ${findings.length} 项发现并保留 ${citationCount} 条引用。`]
      : status === "blocked"
        ? [`${ministry}本轮未获分派，生成无职责范围留痕。`]
        : [`${ministry}专责报告执行失败。`, ...findings.slice(0, 1)];
    this.insertTransition(
      current,
      runId,
      current.status as WorkflowState,
      "shangshu",
      `ministry_report_${status}_${ministry}`,
      status === "completed" ? "MINISTRY_REPORT_COMPLETED" : status === "blocked" ? "MINISTRY_OUT_OF_SCOPE" : "MINISTRY_REPORT_FAILED",
      rationale,
      { ministry, status, attempt, claimRefs, citationCount },
      `${runId}:attempt:${attempt}:ministry:${ministry}:${status}`
    );
  }

  private transition(
    eventId: string,
    runId: string,
    attempt: number,
    expectedState: WorkflowState,
    toState: WorkflowState,
    department: DepartmentCode,
    action: string,
    reasonCode: string,
    rationale: string[],
    patch: {
      proposal?: ZhongshuProposalDTO;
      review?: MenxiaReviewDTO;
      dispatch?: ShangshuDispatchDTO;
      publishable?: boolean;
      approvedAt?: string | null;
      completedAt?: string | null;
    }
  ): void {
    const tx = this.raw.transaction(() => {
      const current = this.assertActiveAttempt(eventId, runId, attempt);
      const key = `${runId}:attempt:${attempt}:${department}:${action}`;
      const exists = this.raw.prepare("SELECT 1 FROM workflow_transitions WHERE idempotency_key = ?").get(key);
      if (exists) return;
      if (current.status !== expectedState) throw new Error(`案件状态不是 ${expectedState}：${current.status}`);
      this.insertTransition(current, runId, toState, department, action, reasonCode, rationale, patch as Record<string, unknown>, key);
      const at = nowIso();
      const result = this.raw.prepare(`
        UPDATE workflow_cases SET
          status = ?, current_department = ?, updated_at = ?,
          proposal = COALESCE(?, proposal), review = COALESCE(?, review), dispatch = COALESCE(?, dispatch),
          publishable = COALESCE(?, publishable), approved_at = COALESCE(?, approved_at),
          completed_at = COALESCE(?, completed_at), last_error_code = NULL
        WHERE event_id = ? AND active_run_id = ?
      `).run(
        toState,
        department,
        at,
        patch.proposal ? JSON.stringify(patch.proposal) : null,
        patch.review ? JSON.stringify(patch.review) : null,
        patch.dispatch ? JSON.stringify(patch.dispatch) : null,
        patch.publishable === undefined ? null : patch.publishable ? 1 : 0,
        patch.approvedAt ?? null,
        patch.completedAt ?? null,
        eventId,
        runId
      );
      if (result.changes !== 1) throw new Error(`工作流投影写入失败：${runId}#${attempt}`);
    });
    tx();
  }

  private insertTransition(
    current: CaseRow,
    runId: string,
    toState: WorkflowState,
    department: DepartmentCode,
    action: string,
    reasonCode: string,
    rationale: string[],
    artifact: Record<string, unknown>,
    idempotencyKey: string
  ): void {
    const sequenceRow = this.raw.prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS n FROM workflow_transitions WHERE run_id = ?").get(runId) as { n: number };
    this.raw.prepare(`
      INSERT INTO workflow_transitions(
        run_id, event_id, sequence, idempotency_key, from_state, to_state, department,
        action, reason_code, rationale, artifact, actor_type, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'system', ?)
      ON CONFLICT(idempotency_key) DO NOTHING
    `).run(
      runId,
      current.event_id,
      sequenceRow.n,
      idempotencyKey,
      current.status,
      toState,
      department,
      action,
      reasonCode,
      JSON.stringify(rationale),
      JSON.stringify(artifact),
      nowIso()
    );
  }

  private finishRun(runId: string, attempt: number, status: "completed" | "remanded"): void {
    const result = this.raw.prepare(`
      UPDATE workflow_runs SET status = ?, lease_until = NULL, next_attempt_at = NULL, finished_at = ?
      WHERE id = ? AND attempt = ? AND status = 'running'
    `).run(status, nowIso(), runId, attempt);
    if (result.changes === 1) return;
    const current = this.raw.prepare("SELECT status, attempt FROM workflow_runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (!current || current.attempt !== attempt || current.status !== status) {
      throw new Error(`工作流运行已被后续 attempt 接管：${runId}#${attempt}`);
    }
  }

  private caseRow(eventId: string): CaseRow | null {
    return (this.raw.prepare("SELECT * FROM workflow_cases WHERE event_id = ?").get(eventId) as CaseRow | undefined) || null;
  }

  private assertActiveRun(eventId: string, runId: string, expectedState?: WorkflowState): CaseRow {
    const row = this.caseRow(eventId);
    if (!row || row.active_run_id !== runId) throw new Error(`工作流运行已不是当前活动案件：${runId}`);
    if (expectedState && row.status !== expectedState) throw new Error(`案件状态不是 ${expectedState}：${row.status}`);
    return row;
  }

  private assertActiveAttempt(eventId: string, runId: string, attempt: number, expectedState?: WorkflowState): CaseRow {
    const row = this.assertActiveRun(eventId, runId, expectedState);
    const run = this.raw.prepare("SELECT status, attempt FROM workflow_runs WHERE id = ? AND event_id = ?").get(runId, eventId) as RunRow | undefined;
    if (!run || run.status !== "running" || run.attempt !== attempt) {
      throw new Error(`工作流 attempt 已被后续运行接管：${runId}#${attempt}`);
    }
    return row;
  }

  private runAttempt(runId: string): number {
    const row = this.raw.prepare("SELECT attempt FROM workflow_runs WHERE id = ?").get(runId) as { attempt: number } | undefined;
    if (!row) throw new Error(`工作流运行不存在：${runId}`);
    return Number(row.attempt || 1);
  }

  private assignments(runId: string): MinistryAssignmentDTO[] {
    const rows = this.raw.prepare(`
      SELECT ministry, score, is_primary, reasons
      FROM workflow_ministry_assignments
      WHERE run_id = ?
      ORDER BY is_primary DESC, score DESC, ministry ASC
    `).all(runId) as Record<string, unknown>[];
    return rows.map((row) => ({
      ministry: String(row.ministry) as MinistryCode,
      score: Number(row.score || 0),
      primary: Boolean(Number(row.is_primary)),
      reasons: parseJson<string[]>(row.reasons, []),
    }));
  }

  private assignmentsForRuns(runIds: readonly string[]): Map<string, MinistryAssignmentDTO[]> {
    const ids = [...new Set(runIds)];
    const output = new Map<string, MinistryAssignmentDTO[]>();
    if (ids.length === 0) return output;
    const rows = this.raw.prepare(`
      SELECT run_id, ministry, score, is_primary, reasons
      FROM workflow_ministry_assignments
      WHERE run_id IN (${ids.map(() => "?").join(",")})
      ORDER BY run_id, is_primary DESC, score DESC, ministry ASC
    `).all(...ids) as Record<string, unknown>[];
    for (const row of rows) {
      const runId = String(row.run_id);
      const grouped = output.get(runId) || [];
      grouped.push({
        ministry: String(row.ministry) as MinistryCode,
        score: Number(row.score || 0),
        primary: Boolean(Number(row.is_primary)),
        reasons: parseJson<string[]>(row.reasons, []),
      });
      output.set(runId, grouped);
    }
    return output;
  }

  private progressForRuns(runIds: readonly string[]): Map<string, MinistryReportProgressDTO> {
    const ids = [...new Set(runIds)];
    const output = new Map<string, MinistryReportProgressDTO>();
    if (ids.length === 0) return output;
    const rows = this.raw.prepare(`
      SELECT mr.run_id, mr.status, COUNT(*) AS count
      FROM workflow_ministry_reports mr
      JOIN workflow_runs wr ON wr.id = mr.run_id AND wr.attempt = mr.attempt
      WHERE mr.run_id IN (${ids.map(() => "?").join(",")})
      GROUP BY mr.run_id, mr.status
    `).all(...ids) as Array<{ run_id: string; status: string; count: number }>;
    for (const row of rows) {
      const progress = output.get(row.run_id) || emptyMinistryProgress();
      const status = row.status as MinistryReportStatus;
      if (status in progress) progress[status] = Number(row.count || 0);
      progress.total += Number(row.count || 0);
      output.set(row.run_id, progress);
    }
    return output;
  }

  private ministryReports(
    runId: string,
    attempt: number,
    assignments = this.assignments(runId)
  ): MinistryWorkReportDTO[] {
    const rows = this.raw.prepare(`
      SELECT * FROM workflow_ministry_reports
      WHERE run_id = ? AND attempt = ?
      ORDER BY CASE status WHEN 'completed' THEN 0 WHEN 'running' THEN 1 WHEN 'pending' THEN 2 WHEN 'blocked' THEN 3 ELSE 4 END,
               ministry ASC
    `).all(runId, attempt) as MinistryReportRow[];
    const assignmentMap = new Map(assignments.map((assignment) => [assignment.ministry, assignment]));
    return rows.map((row) => this.mapMinistryReport(row, assignmentMap.get(row.ministry as MinistryCode) || null));
  }

  private mapMinistryReport(row: MinistryReportRow, assignment: MinistryAssignmentDTO | null): MinistryWorkReportDTO {
    return {
      id: Number(row.id),
      runId: row.run_id,
      eventId: row.event_id,
      ministry: row.ministry as MinistryCode,
      attempt: Number(row.attempt),
      status: row.status as MinistryReportStatus,
      assignment,
      findings: parseJson<string[]>(row.findings, []),
      risks: parseJson<string[]>(row.risks, []),
      evidenceGaps: parseJson<string[]>(row.evidence_gaps, []),
      actions: parseJson<string[]>(row.actions, []),
      citations: parseJson<MinistryWorkReportDTO["citations"]>(row.citations, []),
      claimRefs: parseJson<string[]>(row.claim_refs, []),
      rulesVersion: row.rules_version,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      errorCode: row.error_code,
      errorDetail: row.error_detail,
    };
  }

  private ministryProgress(runId: string): MinistryReportProgressDTO {
    const reports = this.ministryReports(runId, this.runAttempt(runId));
    const progress: MinistryReportProgressDTO = {
      total: reports.length,
      pending: 0,
      running: 0,
      completed: 0,
      blocked: 0,
      failed: 0,
    };
    for (const report of reports) {
      if (report.status in progress) progress[report.status] += 1;
    }
    return progress;
  }

  private mapSummary(row: CaseRow, assignments: MinistryAssignmentDTO[]): WorkflowSummaryDTO {
    return this.mapSummaryWithProgress(
      row,
      assignments,
      row.active_run_id ? this.ministryProgress(row.active_run_id) : emptyMinistryProgress()
    );
  }

  private mapSummaryWithProgress(
    row: CaseRow,
    assignments: MinistryAssignmentDTO[],
    ministryReportProgress: MinistryReportProgressDTO
  ): WorkflowSummaryDTO {
    const review = parseJson<MenxiaReviewDTO | null>(row.review, null);
    return {
      eventId: row.event_id,
      status: row.status as WorkflowState,
      currentDepartment: row.current_department as DepartmentCode,
      revision: row.revision,
      rulesVersion: row.rules_version,
      inputHash: row.input_hash.slice(0, 16),
      publishable: Boolean(row.publishable),
      assignments,
      ministryReportProgress,
      reviewDecision: review?.decision || null,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
    };
  }
}

function emptyMinistryProgress(): MinistryReportProgressDTO {
  return { total: 0, pending: 0, running: 0, completed: 0, blocked: 0, failed: 0 };
}

function assignmentFromJoinedRow(row: Record<string, unknown>): MinistryAssignmentDTO | null {
  if (row.assignment_score === null || row.assignment_score === undefined) return null;
  return {
    ministry: String(row.ministry) as MinistryCode,
    score: Number(row.assignment_score),
    primary: Boolean(Number(row.assignment_primary)),
    reasons: parseJson<string[]>(row.assignment_reasons, []),
  };
}

function mapTransition(row: Record<string, unknown>): WorkflowTransitionDTO {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    sequence: Number(row.sequence),
    fromState: row.from_state ? (String(row.from_state) as WorkflowState) : null,
    toState: String(row.to_state) as WorkflowState,
    department: String(row.department) as DepartmentCode,
    action: String(row.action),
    reasonCode: String(row.reason_code),
    rationale: parseJson<string[]>(row.rationale, []),
    createdAt: String(row.created_at),
  };
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== "string") return value as T;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
