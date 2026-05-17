import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleCommentEvent } from "../../engine/stage-completion.js";

function createMockCtx() {
  return {
    issues: {
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      listComments: vi.fn().mockResolvedValue([]),
      relations: {
        get: vi.fn().mockResolvedValue({ blockedBy: [], blocking: [] }),
        removeBlockers: vi.fn().mockResolvedValue(undefined),
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    streams: {
      emit: vi.fn(),
    },
  } as any;
}

function createMockStateMachine() {
  return {
    getStageBySubIssueId: vi.fn().mockResolvedValue(null),
    setStageOutput: vi.fn().mockResolvedValue(undefined),
    updateStageStatus: vi.fn().mockResolvedValue(undefined),
    setStageError: vi.fn().mockResolvedValue(undefined),
    getRun: vi.fn().mockResolvedValue(null),
  } as any;
}

function createMockRouter() {
  return {} as any;
}

function createMockDispatcher() {
  return {} as any;
}

const advancePipelineFn = vi.fn().mockResolvedValue(undefined);
const handleStageFailureFn = vi.fn().mockResolvedValue(undefined);

function event(overrides: Partial<{ entityId: string; companyId: string; payload: any }> = {}) {
  return {
    entityId: "stage-issue-1",
    companyId: "company-1",
    payload: { commentId: "comment-1" },
    ...overrides,
  } as any;
}

const PIPELINE_JSON = JSON.stringify({
  name: "test-pipeline",
  description: "",
  trigger: { label: "pipeline:test" },
  stages: [{ id: "stage-1", type: "stage", agent_role: "worker", actionId: "do-thing" }],
  edges: [],
  positions: {},
});

describe("handleCommentEvent — proactive recovery cleanup", () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let sm: ReturnType<typeof createMockStateMachine>;

  beforeEach(() => {
    ctx = createMockCtx();
    sm = createMockStateMachine();
    vi.clearAllMocks();
  });

  function setupHappyPath() {
    sm.getStageBySubIssueId.mockResolvedValue({
      id: "stage-row-1",
      stageId: "stage-1",
      pipelineRunId: "run-1",
      status: "running",
    });
    ctx.issues.listComments.mockResolvedValue([
      { id: "comment-1", body: "<!-- pipeline-output -->\n```json\n{\"result\": \"ok\"}\n```" },
    ]);
    sm.getRun.mockResolvedValue({
      id: "run-1",
      companyId: "company-1",
      pipelineYaml: PIPELINE_JSON,
    });
  }

  it("cancels active recovery issues after marking stage done", async () => {
    setupHappyPath();
    ctx.issues.list.mockResolvedValue([
      { id: "recovery-1", status: "in_progress", identifier: "REC-1" },
      { id: "recovery-2", status: "blocked", identifier: "REC-2" },
    ]);
    ctx.issues.relations.get.mockResolvedValue({ blockedBy: [{ id: "recovery-1" }, { id: "recovery-2" }] });

    await handleCommentEvent(ctx, event(), sm, createMockRouter(), createMockDispatcher(), advancePipelineFn, handleStageFailureFn);

    expect(ctx.issues.update).toHaveBeenCalledWith("recovery-1", { status: "done" }, "company-1");
    expect(ctx.issues.update).toHaveBeenCalledWith("recovery-2", { status: "done" }, "company-1");
    expect(ctx.issues.relations.removeBlockers).toHaveBeenCalledWith("stage-issue-1", ["recovery-1", "recovery-2"], "company-1");
  });

  it("skips already-done/cancelled recovery issues", async () => {
    setupHappyPath();
    ctx.issues.list.mockResolvedValue([
      { id: "recovery-1", status: "done", identifier: "REC-1" },
      { id: "recovery-2", status: "cancelled", identifier: "REC-2" },
    ]);

    await handleCommentEvent(ctx, event(), sm, createMockRouter(), createMockDispatcher(), advancePipelineFn, handleStageFailureFn);

    expect(ctx.issues.update).not.toHaveBeenCalledWith("recovery-1", { status: "done" }, "company-1");
    expect(ctx.issues.update).not.toHaveBeenCalledWith("recovery-2", { status: "done" }, "company-1");
    expect(ctx.issues.relations.removeBlockers).not.toHaveBeenCalled();
  });

  it("continues pipeline advancement even when recovery cleanup fails", async () => {
    setupHappyPath();
    ctx.issues.list.mockRejectedValue(new Error("network error"));

    await handleCommentEvent(ctx, event(), sm, createMockRouter(), createMockDispatcher(), advancePipelineFn, handleStageFailureFn);

    expect(ctx.logger.error).toHaveBeenCalledWith(
      "Failed to clean recovery issues on stage completion",
      expect.objectContaining({ issueId: "stage-issue-1" }),
    );
    expect(advancePipelineFn).toHaveBeenCalled();
  });

  it("only removes blockers that were successfully closed", async () => {
    setupHappyPath();
    ctx.issues.list.mockResolvedValue([
      { id: "recovery-1", status: "in_progress", identifier: "REC-1" },
      { id: "recovery-2", status: "blocked", identifier: "REC-2" },
    ]);
    ctx.issues.update
      .mockResolvedValueOnce(undefined) // stage-issue-1 → done
      .mockResolvedValueOnce(undefined) // recovery-1 → done (success)
      .mockRejectedValueOnce(new Error("timeout")); // recovery-2 → done (fail)
    ctx.issues.relations.get.mockResolvedValue({ blockedBy: [{ id: "recovery-1" }] });

    await handleCommentEvent(ctx, event(), sm, createMockRouter(), createMockDispatcher(), advancePipelineFn, handleStageFailureFn);

    expect(ctx.issues.relations.removeBlockers).toHaveBeenCalledWith("stage-issue-1", ["recovery-1"], "company-1");
  });

  it("does nothing when no recovery issues exist", async () => {
    setupHappyPath();
    ctx.issues.list.mockResolvedValue([]);

    await handleCommentEvent(ctx, event(), sm, createMockRouter(), createMockDispatcher(), advancePipelineFn, handleStageFailureFn);

    expect(ctx.issues.relations.removeBlockers).not.toHaveBeenCalled();
    expect(advancePipelineFn).toHaveBeenCalled();
  });
});
