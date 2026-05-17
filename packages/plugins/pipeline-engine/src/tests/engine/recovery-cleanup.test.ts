import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleRecoveryIssueCreated, handleStageReBlocked, handlePipelineRootBlocked } from "../../engine/recovery-cleanup.js";

function createMockCtx() {
  return {
    issues: {
      get: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      relations: {
        get: vi.fn().mockResolvedValue({ blockedBy: [], blocking: [] }),
        removeBlockers: vi.fn().mockResolvedValue(undefined),
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as any;
}

function createMockStateMachine() {
  return {
    getStageBySubIssueId: vi.fn().mockResolvedValue(null),
    getAnyRunForIssue: vi.fn().mockResolvedValue(null),
    getRunStages: vi.fn().mockResolvedValue([]),
  } as any;
}

function event(overrides: Partial<{ entityId: string; companyId: string; actorType: string }> = {}) {
  return { entityId: "issue-1", companyId: "company-1", actorType: "system", ...overrides } as any;
}

describe("handleRecoveryIssueCreated", () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let sm: ReturnType<typeof createMockStateMachine>;

  beforeEach(() => {
    ctx = createMockCtx();
    sm = createMockStateMachine();
  });

  it("returns early when entityId is missing", async () => {
    await handleRecoveryIssueCreated(ctx, event({ entityId: undefined }), sm);
    expect(ctx.issues.get).not.toHaveBeenCalled();
  });

  it("returns early when issue has no parentId", async () => {
    ctx.issues.get.mockResolvedValue({ id: "issue-1", parentId: null });
    await handleRecoveryIssueCreated(ctx, event(), sm);
    expect(ctx.issues.update).not.toHaveBeenCalled();
  });

  it("returns early when issue is not a recovery issue", async () => {
    ctx.issues.get.mockResolvedValue({ id: "issue-1", parentId: "parent-1", originKind: "other" });
    await handleRecoveryIssueCreated(ctx, event({ actorType: "user" }), sm);
    expect(ctx.issues.update).not.toHaveBeenCalled();
  });

  it("returns early when parent is not a pipeline stage", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", parentId: "parent-1", originKind: "stranded_issue_recovery" })
      .mockResolvedValueOnce({ id: "parent-1", originKind: "other_kind", status: "done" });
    await handleRecoveryIssueCreated(ctx, event(), sm);
    expect(ctx.issues.update).not.toHaveBeenCalled();
  });

  it("returns early when parent stage is not done", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", parentId: "parent-1", originKind: "stranded_issue_recovery" })
      .mockResolvedValueOnce({ id: "parent-1", originKind: "plugin:paperclipai.pipeline-engine:stage", status: "in_progress" });
    await handleRecoveryIssueCreated(ctx, event(), sm);
    expect(ctx.issues.update).not.toHaveBeenCalled();
  });

  it("cancels recovery issue and removes blocker from parent", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", parentId: "parent-1", originKind: "stranded_issue_recovery", title: "Recover" })
      .mockResolvedValueOnce({ id: "parent-1", parentId: "root-1", originKind: "plugin:paperclipai.pipeline-engine:stage", status: "done", identifier: "PAP-2" });
    ctx.issues.relations.get
      .mockResolvedValueOnce({ blockedBy: [{ id: "issue-1" }] })
      .mockResolvedValueOnce({ blockedBy: [] });

    await handleRecoveryIssueCreated(ctx, event(), sm);

    expect(ctx.issues.update).toHaveBeenCalledWith("issue-1", { status: "done" }, "company-1");
    expect(ctx.issues.relations.removeBlockers).toHaveBeenCalledWith("parent-1", ["issue-1"], "company-1");
  });

  it("removes blocker from grandparent when present", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", parentId: "parent-1", originKind: "stranded_issue_recovery", title: "Recover" })
      .mockResolvedValueOnce({ id: "parent-1", parentId: "root-1", originKind: "plugin:paperclipai.pipeline-engine:stage", status: "done", identifier: "PAP-2" });
    ctx.issues.relations.get
      .mockResolvedValueOnce({ blockedBy: [{ id: "issue-1" }] })
      .mockResolvedValueOnce({ blockedBy: [{ id: "issue-1" }] });

    await handleRecoveryIssueCreated(ctx, event(), sm);

    expect(ctx.issues.relations.removeBlockers).toHaveBeenCalledWith("root-1", ["issue-1"], "company-1");
  });

  it("logs error and does not throw on API failure", async () => {
    ctx.issues.get.mockRejectedValue(new Error("network timeout"));
    await handleRecoveryIssueCreated(ctx, event(), sm);
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});

describe("handleStageReBlocked", () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let sm: ReturnType<typeof createMockStateMachine>;

  beforeEach(() => {
    ctx = createMockCtx();
    sm = createMockStateMachine();
  });

  it("returns early when issue is not blocked", async () => {
    ctx.issues.get.mockResolvedValue({ id: "issue-1", status: "in_progress", originKind: "plugin:paperclipai.pipeline-engine:stage" });
    await handleStageReBlocked(ctx, event(), sm);
    expect(sm.getStageBySubIssueId).not.toHaveBeenCalled();
  });

  it("returns early when issue is not a pipeline stage", async () => {
    ctx.issues.get.mockResolvedValue({ id: "issue-1", status: "blocked", originKind: "other" });
    await handleStageReBlocked(ctx, event(), sm);
    expect(sm.getStageBySubIssueId).not.toHaveBeenCalled();
  });

  it("returns early when stage is not completed in DB", async () => {
    ctx.issues.get.mockResolvedValue({ id: "issue-1", status: "blocked", originKind: "plugin:paperclipai.pipeline-engine:stage" });
    sm.getStageBySubIssueId.mockResolvedValue({ status: "running" });
    await handleStageReBlocked(ctx, event(), sm);
    expect(ctx.issues.update).not.toHaveBeenCalled();
  });

  it("does not clean up when a blocker is pipeline-managed", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", status: "blocked", originKind: "plugin:paperclipai.pipeline-engine:stage", identifier: "PAP-1" })
      .mockResolvedValueOnce({ id: "blocker-1", originKind: "plugin:paperclipai.pipeline-engine:dep" });
    sm.getStageBySubIssueId.mockResolvedValue({ status: "completed" });
    ctx.issues.relations.get.mockResolvedValue({ blockedBy: [{ id: "blocker-1" }] });

    await handleStageReBlocked(ctx, event(), sm);
    expect(ctx.issues.update).not.toHaveBeenCalled();
  });

  it("cancels recovery blockers and restores stage to done", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", status: "blocked", originKind: "plugin:paperclipai.pipeline-engine:stage", identifier: "PAP-1" })
      .mockResolvedValueOnce({ id: "recovery-1", originKind: "stranded_issue_recovery" });
    sm.getStageBySubIssueId.mockResolvedValue({ status: "completed" });
    ctx.issues.relations.get.mockResolvedValue({ blockedBy: [{ id: "recovery-1" }] });

    await handleStageReBlocked(ctx, event(), sm);

    expect(ctx.issues.update).toHaveBeenCalledWith("recovery-1", { status: "done" }, "company-1");
    expect(ctx.issues.relations.removeBlockers).toHaveBeenCalledWith("issue-1", ["recovery-1"], "company-1");
    expect(ctx.issues.update).toHaveBeenCalledWith("issue-1", { status: "done" }, "company-1");
  });

  it("does not close non-recovery, non-pipeline blockers", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", status: "blocked", originKind: "plugin:paperclipai.pipeline-engine:stage", identifier: "PAP-1" })
      .mockResolvedValueOnce({ id: "manual-1", originKind: "user_created" });
    sm.getStageBySubIssueId.mockResolvedValue({ status: "completed" });
    ctx.issues.relations.get.mockResolvedValue({ blockedBy: [{ id: "manual-1" }] });

    await handleStageReBlocked(ctx, event(), sm);

    expect(ctx.issues.update).not.toHaveBeenCalled();
    expect(ctx.issues.relations.removeBlockers).not.toHaveBeenCalled();
  });

  it("treats deleted blockers as removable", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", status: "blocked", originKind: "plugin:paperclipai.pipeline-engine:stage", identifier: "PAP-1" })
      .mockResolvedValueOnce(null);
    sm.getStageBySubIssueId.mockResolvedValue({ status: "completed" });
    ctx.issues.relations.get.mockResolvedValue({ blockedBy: [{ id: "deleted-1" }] });

    await handleStageReBlocked(ctx, event(), sm);

    expect(ctx.issues.relations.removeBlockers).toHaveBeenCalledWith("issue-1", ["deleted-1"], "company-1");
  });

  it("only removes successfully closed blockers on partial failure", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", status: "blocked", originKind: "plugin:paperclipai.pipeline-engine:stage", identifier: "PAP-1" })
      .mockResolvedValueOnce({ id: "recovery-1", originKind: "stranded_issue_recovery" })
      .mockResolvedValueOnce({ id: "recovery-2", originKind: "stranded_issue_recovery" });
    sm.getStageBySubIssueId.mockResolvedValue({ status: "completed" });
    ctx.issues.relations.get.mockResolvedValue({ blockedBy: [{ id: "recovery-1" }, { id: "recovery-2" }] });
    ctx.issues.update
      .mockResolvedValueOnce(undefined) // recovery-1 succeeds
      .mockRejectedValueOnce(new Error("timeout")); // recovery-2 fails

    await handleStageReBlocked(ctx, event(), sm);

    expect(ctx.issues.relations.removeBlockers).toHaveBeenCalledWith("issue-1", ["recovery-1"], "company-1");
    expect(ctx.issues.update).not.toHaveBeenCalledWith("issue-1", { status: "done" }, "company-1");
  });

  it("logs error and does not throw on API failure", async () => {
    ctx.issues.get.mockRejectedValue(new Error("db down"));
    await handleStageReBlocked(ctx, event(), sm);
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});

describe("handlePipelineRootBlocked", () => {
  let ctx: ReturnType<typeof createMockCtx>;
  let sm: ReturnType<typeof createMockStateMachine>;

  beforeEach(() => {
    ctx = createMockCtx();
    sm = createMockStateMachine();
  });

  it("returns early when issue is not blocked", async () => {
    ctx.issues.get.mockResolvedValue({ id: "issue-1", status: "in_progress" });
    await handlePipelineRootBlocked(ctx, event(), sm);
    expect(sm.getAnyRunForIssue).not.toHaveBeenCalled();
  });

  it("returns early when no pipeline run exists for the issue", async () => {
    ctx.issues.get.mockResolvedValue({ id: "issue-1", status: "blocked" });
    sm.getAnyRunForIssue.mockResolvedValue(null);
    await handlePipelineRootBlocked(ctx, event(), sm);
    expect(ctx.issues.relations.get).not.toHaveBeenCalled();
  });

  it("removes recovery blockers and restores root to in_progress when all are removable", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", status: "blocked", identifier: "PAP-1" })
      .mockResolvedValueOnce({ id: "recovery-1", originKind: "stranded_issue_recovery", parentId: "stage-1" });
    sm.getAnyRunForIssue.mockResolvedValue({ id: "run-1" });
    sm.getStageBySubIssueId.mockResolvedValue({ status: "completed" });
    ctx.issues.relations.get.mockResolvedValue({ blockedBy: [{ id: "recovery-1" }] });

    await handlePipelineRootBlocked(ctx, event(), sm);

    expect(ctx.issues.update).toHaveBeenCalledWith("recovery-1", { status: "done" }, "company-1");
    expect(ctx.issues.relations.removeBlockers).toHaveBeenCalledWith("issue-1", ["recovery-1"], "company-1");
    expect(ctx.issues.update).toHaveBeenCalledWith("issue-1", { status: "in_progress" }, "company-1");
  });

  it("does not restore root to in_progress when some blockers remain", async () => {
    ctx.issues.get
      .mockResolvedValueOnce({ id: "issue-1", status: "blocked", identifier: "PAP-1" })
      .mockResolvedValueOnce({ id: "recovery-1", originKind: "stranded_issue_recovery", parentId: "stage-1" })
      .mockResolvedValueOnce({ id: "legit-1", originKind: "other" });
    sm.getAnyRunForIssue.mockResolvedValue({ id: "run-1" });
    sm.getStageBySubIssueId.mockResolvedValue({ status: "completed" });
    ctx.issues.relations.get.mockResolvedValue({ blockedBy: [{ id: "recovery-1" }, { id: "legit-1" }] });

    await handlePipelineRootBlocked(ctx, event(), sm);

    expect(ctx.issues.update).toHaveBeenCalledWith("recovery-1", { status: "done" }, "company-1");
    expect(ctx.issues.update).not.toHaveBeenCalledWith("issue-1", { status: "in_progress" }, "company-1");
  });

  it("falls through to strategy 2 when no direct blockers are recovery issues", async () => {
    ctx.issues.get.mockResolvedValueOnce({ id: "issue-1", status: "blocked", identifier: "PAP-1" });
    sm.getAnyRunForIssue.mockResolvedValue({ id: "run-1" });
    ctx.issues.relations.get.mockResolvedValue({ blockedBy: [] });
    sm.getRunStages.mockResolvedValue([
      { status: "completed", subIssueId: "stage-sub-1" },
    ]);
    ctx.issues.list.mockResolvedValue([
      { id: "orphan-1", status: "blocked", identifier: "PAP-99" },
    ]);
    // After cleanup, re-fetch root
    ctx.issues.get.mockResolvedValueOnce({ id: "issue-1", status: "blocked", identifier: "PAP-1" });
    ctx.issues.relations.get
      .mockResolvedValueOnce({ blockedBy: [] }) // root relations (first call)
      .mockResolvedValueOnce({ blockedBy: [{ id: "orphan-1" }] }) // stage relations
      .mockResolvedValueOnce({ blockedBy: [] }); // root relations after cleanup

    await handlePipelineRootBlocked(ctx, event(), sm);

    expect(ctx.issues.update).toHaveBeenCalledWith("orphan-1", { status: "done" }, "company-1");
  });

  it("logs error and does not throw on API failure", async () => {
    ctx.issues.get.mockRejectedValue(new Error("timeout"));
    await handlePipelineRootBlocked(ctx, event(), sm);
    expect(ctx.logger.error).toHaveBeenCalled();
  });
});
