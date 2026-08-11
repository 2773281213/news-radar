import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config";
import { Scheduler } from "./scheduler";
import type { WorkflowProcessResult } from "./workflow";

function workflowResults(eventIds: string[], status: WorkflowProcessResult["status"]): WorkflowProcessResult[] {
  return eventIds.map((eventId) => ({ eventId, status, runId: `run-${eventId}`, reason: "test" }));
}

function createSchedulerFixture(touchedEventIds: string[], dueResults: WorkflowProcessResult[] = []) {
  const kv = {
    setJson: vi.fn().mockResolvedValue(undefined),
    get: vi.fn().mockResolvedValue("locked"),
    set: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    cleanup: vi.fn().mockResolvedValue(undefined),
  };
  const sources = { get: vi.fn().mockResolvedValue(null) };
  const events = { recentBreakingEventIds: vi.fn().mockReturnValue([]) };
  const ingestion = {
    runDue: vi.fn().mockResolvedValue([{
      sourceId: "test-source",
      ok: true,
      found: touchedEventIds.length,
      added: touchedEventIds.length,
      updated: 0,
      skipped: 0,
      eventIds: touchedEventIds,
      error: null,
      ms: 1,
    }]),
    processPending: vi.fn().mockResolvedValue([]),
    ingestItems: vi.fn().mockResolvedValue([]),
  };
  const reporting = {
    createBriefing: vi.fn().mockResolvedValue(undefined),
    searchPlan: vi.fn().mockResolvedValue(null),
  };
  const workflow = {
    processEventIds: vi.fn(async (eventIds: string[]) => workflowResults(eventIds, "remanded")),
    processDue: vi.fn().mockResolvedValue(dueResults),
  };
  const config = {
    defaultTz: "UTC",
    workflowBatchSize: 50,
    rsshubBase: "https://rsshub.example.test",
    userAgent: "NewsRadarTest/1.0",
  } as Config;
  const scheduler = new Scheduler(
    config,
    kv as never,
    sources as never,
    events as never,
    ingestion as never,
    reporting as never,
    workflow as never
  );
  return { scheduler, kv, ingestion, workflow };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Scheduler", () => {
  it("keeps its timers referenced so a dedicated worker stays alive", async () => {
    const fixture = createSchedulerFixture([]);
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const intervalSpy = vi.spyOn(globalThis, "setInterval");

    fixture.scheduler.start(30_000);
    const timeout = timeoutSpy.mock.results.at(-1)?.value as NodeJS.Timeout;
    const intervals = intervalSpy.mock.results.slice(-2).map((result) => result.value as NodeJS.Timeout);

    expect(timeout.hasRef()).toBe(true);
    expect(intervals).toHaveLength(2);
    expect(intervals.every((timer) => timer.hasRef())).toBe(true);
    fixture.scheduler.stop();
    await Promise.resolve();
  });

  it("caps newly touched workflow cases at the shared eight-case tick budget", async () => {
    const eventIds = Array.from({ length: 14 }, (_, index) => `event-${index + 1}`);
    const fixture = createSchedulerFixture(eventIds);

    const state = await fixture.scheduler.tick();

    expect(fixture.workflow.processEventIds).toHaveBeenCalledOnce();
    expect(fixture.workflow.processEventIds).toHaveBeenCalledWith(eventIds.slice(0, 8), "ingestion");
    expect(fixture.workflow.processDue).not.toHaveBeenCalled();
    expect(state.lastWorkflowRemanded).toBe(8);
  });

  it("uses only the remaining tick budget for overdue workflow cases", async () => {
    const touched = ["event-new-1", "event-new-2", "event-new-3"];
    const due = workflowResults(["event-due-1", "event-due-2", "event-due-3", "event-due-4", "event-due-5"], "completed");
    const fixture = createSchedulerFixture(touched, due);

    const state = await fixture.scheduler.tick();

    expect(fixture.workflow.processEventIds).toHaveBeenCalledWith(touched, "ingestion");
    expect(fixture.workflow.processDue).toHaveBeenCalledWith(5);
    expect(state.lastWorkflowCompleted).toBe(5);
    expect(state.lastWorkflowRemanded).toBe(3);
  });
});
