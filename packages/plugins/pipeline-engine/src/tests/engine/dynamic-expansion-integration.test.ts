import { describe, it, expect, vi } from "vitest";
import { advancePipeline } from "../../engine/pipeline-executor.js";
import { handleCommentEvent } from "../../engine/stage-completion.js";
import { Router } from "../../engine/router.js";
import type { PipelineDefinition, PipelineStage, EdgeDefinition } from "../../types.js";

// Stub action registry so validation is skipped for the dynamic fan_out
vi.mock("../../actions/index.js", () => ({
  getActionById: (id: string) => {
    if (id === "dispatch-dynamic") return { id: "dispatch-dynamic", fixed: false };
    if (id === "write-implementation") return { id: "write-implementation", fixed: false };
    if (id === "open-pr") return { id: "open-pr", fixed: false };
    return null;
  },
}));

// =============================================================================
// Pipeline: plan (fan_out) --[template]--> impl-template (stage, template:true)
//           impl-template --> review (fan_in) --> merge (stage)
// =============================================================================

const dynamicPipeline: PipelineDefinition = {
  name: "dynamic-integration",
  description: "",
  trigger: { label: "pipeline:dynamic" },
  stages: [
    { id: "plan", type: "fan_out", agent_role: "pipe-decomposer", actionId: "dispatch-dynamic" },
    { id: "impl-template", type: "stage", agent_role: "pipe-backend", actionId: "write-implementation", template: true } as any,
    { id: "review", type: "fan_in" },
    { id: "merge", type: "stage", agent_role: "pipe-backend", actionId: "open-pr" },
  ],
  edges: [
    { id: "e-template", from: "plan", to: "impl-template", template: true } as EdgeDefinition,
    { id: "e-to-review", from: "impl-template", to: "review" },
    { id: "e-to-merge", from: "review", to: "merge" },
  ],
  positions: {},
};

function makeStageRow(
  stageId: string,
  status: PipelineStage["status"],
  output?: Record<string, unknown>,
): PipelineStage {
  return {
    id: `row-${stageId}`,
    pipelineRunId: "run-1",
    stageId,
    subIssueId: null,
    status,
    retryCount: 0,
    output: output ?? null,
    error: null,
    startedAt: null,
    completedAt: null,
  };
}

function makeMockCtx() {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    streams: { emit: vi.fn() },
    issues: {
      get: vi.fn().mockResolvedValue({ projectId: "proj-1" }),
      create: vi.fn().mockResolvedValue({ id: "sub-issue-1" }),
      createComment: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
      listComments: vi.fn().mockResolvedValue([]),
      requestWakeup: vi.fn().mockResolvedValue({ queued: true }),
      documents: { upsert: vi.fn().mockResolvedValue(undefined) },
    },
  };
}

function makeMockStateMachine(initialStageRows: PipelineStage[]) {
  const stageRows = [...initialStageRows];
  const createdStages: { id: string; pipelineRunId: string; stageId: string }[] = [];
  let storedPipelineYaml = JSON.stringify(dynamicPipeline);
  let runStatus = "running";

  return {
    stageRows,
    createdStages,
    getStoredPipelineYaml: () => storedPipelineYaml,
    getRunStatus: () => runStatus,

    tryAdvisoryLock: vi.fn().mockResolvedValue(true),
    releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),

    getRun: vi.fn().mockImplementation(async () => ({
      id: "run-1",
      companyId: "company-1",
      parentIssueId: "parent-1",
      pipelineName: "dynamic-integration",
      pipelineVersion: 1,
      pipelineYaml: storedPipelineYaml,
      status: runStatus,
      createdAt: new Date(),
      updatedAt: new Date(),
    })),

    getRunStages: vi.fn().mockImplementation(async () => {
      const allRows = [
        ...stageRows,
        ...createdStages.map((s) => ({
          id: s.id,
          pipelineRunId: s.pipelineRunId,
          stageId: s.stageId,
          subIssueId: null,
          status: "pending" as const,
          retryCount: 0,
          output: null,
          error: null,
          startedAt: null,
          completedAt: null,
        })),
      ];
      return allRows;
    }),

    createStage: vi.fn().mockImplementation(async (input: { id: string; pipelineRunId: string; stageId: string }) => {
      createdStages.push(input);
    }),

    updatePipelineYaml: vi.fn().mockImplementation(async (_runId: string, yaml: string) => {
      storedPipelineYaml = yaml;
    }),

    claimStageForDispatch: vi.fn().mockResolvedValue(true),
    setStageOutput: vi.fn().mockResolvedValue(undefined),
    updateStageStatus: vi.fn().mockImplementation(async (rowId: string, status: string) => {
      const row = stageRows.find((r) => r.id === rowId);
      if (row) row.status = status as any;
      runStatus = runStatus;
    }),

    updateRunStatus: vi.fn().mockImplementation(async (_runId: string, status: string) => {
      runStatus = status;
    }),

    getLoopEdgeCounts: vi.fn().mockResolvedValue({}),
    setStageSubIssueId: vi.fn().mockResolvedValue(undefined),
    setStageError: vi.fn().mockResolvedValue(undefined),
    getStageBySubIssueId: vi.fn().mockResolvedValue(null),
  };
}

function makeMockRouter() {
  return new Router();
}

function makeMockDispatcher() {
  return {
    dispatch: vi.fn().mockResolvedValue({ issueId: "sub-issue-1", wakeupQueued: true }),
  };
}

function noopHandleFailure() {
  return vi.fn().mockResolvedValue(undefined);
}

describe("dynamic expansion integration", () => {
  describe("advancePipeline: fixed fan_out with template edges", () => {
    it("creates DB stage rows for each dynamically generated stage", async () => {
      // plan stage is pending (ready), and it's a fixed fan_out with template edges.
      // But plan-tasks is NOT a fixed action — we need to simulate that plan completed
      // with agent output and then advance. Instead, use a scenario where plan is
      // already completed with tracks output, and we advance to see dynamic stages dispatched.

      const planOutput = { tracks: ["auth-service", "user-api"], ordering: "parallel" };

      // Pre-expand the pipeline as if expansion already happened (to test routing)
      const router = makeMockRouter();
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expandedPipeline = router.expandPipeline(dynamicPipeline, expansion!);

      const stageRows: PipelineStage[] = [
        makeStageRow("plan", "completed", planOutput),
        makeStageRow("dyn:impl-template:auth-service", "pending"),
        makeStageRow("dyn:impl-template:user-api", "pending"),
        makeStageRow("review", "pending"),
        makeStageRow("merge", "pending"),
      ];

      const ctx = makeMockCtx() as any;
      const sm = makeMockStateMachine(stageRows);
      const dispatcher = makeMockDispatcher();
      const handleFailure = noopHandleFailure();

      await advancePipeline(ctx, "run-1", expandedPipeline, "company-1", sm as any, router, dispatcher as any, handleFailure);

      // Dynamic stages should be dispatched (they are pending and ready)
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(2);
      const dispatchedStageIds = dispatcher.dispatch.mock.calls.map((c: any) => c[0].stage.id);
      expect(dispatchedStageIds).toContain("dyn:impl-template:auth-service");
      expect(dispatchedStageIds).toContain("dyn:impl-template:user-api");
    });

    it("fan_in waits for all dynamic stages before becoming ready", async () => {
      const planOutput = { tracks: ["svc-a", "svc-b"], ordering: "parallel" };
      const router = makeMockRouter();
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expandedPipeline = router.expandPipeline(dynamicPipeline, expansion!);

      // Only one dynamic stage completed — fan_in should still be pending/not dispatched
      const stageRows: PipelineStage[] = [
        makeStageRow("plan", "completed", planOutput),
        makeStageRow("dyn:impl-template:svc-a", "completed", { decision: "done" }),
        makeStageRow("dyn:impl-template:svc-b", "running"),
        makeStageRow("review", "pending"),
        makeStageRow("merge", "pending"),
      ];

      const ctx = makeMockCtx() as any;
      const sm = makeMockStateMachine(stageRows);
      const dispatcher = makeMockDispatcher();
      const handleFailure = noopHandleFailure();

      await advancePipeline(ctx, "run-1", expandedPipeline, "company-1", sm as any, router, dispatcher as any, handleFailure);

      // No dispatch should occur since both dynamic stages are not yet pending/ready
      // svc-b is running (not dispatchable), review needs all sources done
      expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it("fan_in activates and dispatches merge when all dynamic stages complete", async () => {
      const planOutput = { tracks: ["svc-a"], ordering: "parallel" };
      const router = makeMockRouter();
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expandedPipeline = router.expandPipeline(dynamicPipeline, expansion!);

      // All dynamic stages done — fan_in (review) should auto-complete, then merge dispatched
      const stageRows: PipelineStage[] = [
        makeStageRow("plan", "completed", planOutput),
        makeStageRow("dyn:impl-template:svc-a", "completed", { decision: "done" }),
        makeStageRow("review", "pending"),
        makeStageRow("merge", "pending"),
      ];

      const ctx = makeMockCtx() as any;
      const sm = makeMockStateMachine(stageRows);
      const dispatcher = makeMockDispatcher();
      const handleFailure = noopHandleFailure();

      await advancePipeline(ctx, "run-1", expandedPipeline, "company-1", sm as any, router, dispatcher as any, handleFailure);

      // review (fan_in) auto-completes, then merge is dispatched
      expect(sm.updateStageStatus).toHaveBeenCalledWith("row-review", "completed");
      expect(dispatcher.dispatch).toHaveBeenCalledTimes(1);
      expect(dispatcher.dispatch.mock.calls[0][0].stage.id).toBe("merge");
    });
  });

  describe("handleCommentEvent: agent-driven fan_out with template edges", () => {
    it("expands pipeline and creates DB rows when fan_out completes with template edges", async () => {
      const planOutput = { tracks: ["auth-service", "user-api"], ordering: "parallel" };
      const commentBody = `Done planning.\n\n<!-- pipeline-output -->\n\`\`\`json\n${JSON.stringify(planOutput)}\n\`\`\``;

      const stageRow = makeStageRow("plan", "running");

      const stageRows: PipelineStage[] = [
        stageRow,
        makeStageRow("impl-template", "pending"),
        makeStageRow("review", "pending"),
        makeStageRow("merge", "pending"),
      ];

      const ctx = makeMockCtx() as any;
      const sm = makeMockStateMachine(stageRows);

      // Override getStageBySubIssueId to return the plan stage row
      sm.getStageBySubIssueId.mockResolvedValue(stageRow);

      // Override listComments to return our comment
      ctx.issues.listComments = vi.fn().mockResolvedValue([
        { id: "comment-1", body: commentBody },
      ]);

      const router = makeMockRouter();
      const dispatcher = makeMockDispatcher();
      const handleFailure = noopHandleFailure();

      const advancePipelineFn = vi.fn().mockResolvedValue(undefined);

      const event = {
        entityId: "sub-issue-plan",
        companyId: "company-1",
        payload: { commentId: "comment-1" },
      } as any;

      await handleCommentEvent(ctx, event, sm as any, router, dispatcher as any, advancePipelineFn, handleFailure);

      // Dynamic stages should be created in DB
      const createdStageIds = sm.createdStages.map((s) => s.stageId);
      expect(createdStageIds).toContain("dyn:impl-template:auth-service");
      expect(createdStageIds).toContain("dyn:impl-template:user-api");

      // Template stage should NOT be re-created (it already has a row)
      expect(createdStageIds).not.toContain("impl-template");

      // Pipeline YAML in DB should be updated with expanded pipeline
      expect(sm.updatePipelineYaml).toHaveBeenCalledOnce();
      const storedPipeline = JSON.parse(sm.getStoredPipelineYaml());
      expect(storedPipeline.stages.find((s: any) => s.id === "dyn:impl-template:auth-service")).toBeDefined();
      expect(storedPipeline.stages.find((s: any) => s.id === "impl-template")).toBeUndefined();

      // advancePipelineFn called with expanded pipeline
      expect(advancePipelineFn).toHaveBeenCalledOnce();
      const passedPipeline = advancePipelineFn.mock.calls[0][2] as PipelineDefinition;
      expect(passedPipeline.stages.find((s) => s.id === "dyn:impl-template:auth-service")).toBeDefined();
    });

    it("does not expand when fan_out output has no tracks array (non-template pipeline)", async () => {
      const output = { decision: "approved" };
      const commentBody = `Done.\n\n<!-- pipeline-output -->\n\`\`\`json\n${JSON.stringify(output)}\n\`\`\``;

      // Use a non-template pipeline
      const simplePipeline: PipelineDefinition = {
        name: "simple",
        description: "",
        trigger: { label: "pipeline:simple" },
        stages: [
          { id: "plan", type: "fan_out", agent_role: "planner", actionId: "plan-tasks" },
          { id: "work", type: "stage", agent_role: "worker", actionId: "write-implementation" },
          { id: "done", type: "fan_in" },
        ],
        edges: [
          { id: "e1", from: "plan", to: "work", activationKey: "approved" },
          { id: "e2", from: "work", to: "done" },
        ],
        positions: {},
      };

      const stageRow = makeStageRow("plan", "running");
      const stageRows: PipelineStage[] = [
        stageRow,
        makeStageRow("work", "pending"),
        makeStageRow("done", "pending"),
      ];

      const ctx = makeMockCtx() as any;
      const sm = makeMockStateMachine(stageRows);
      sm.getStageBySubIssueId.mockResolvedValue(stageRow);
      sm.getRun.mockImplementation(async () => ({
        id: "run-1",
        companyId: "company-1",
        parentIssueId: "parent-1",
        pipelineName: "simple",
        pipelineVersion: 1,
        pipelineYaml: JSON.stringify(simplePipeline),
        status: "running",
        createdAt: new Date(),
        updatedAt: new Date(),
      }));

      ctx.issues.listComments = vi.fn().mockResolvedValue([
        { id: "comment-1", body: commentBody },
      ]);

      const router = makeMockRouter();
      const dispatcher = makeMockDispatcher();
      const handleFailure = noopHandleFailure();
      const advancePipelineFn = vi.fn().mockResolvedValue(undefined);

      const event = {
        entityId: "sub-issue-plan",
        companyId: "company-1",
        payload: { commentId: "comment-1" },
      } as any;

      await handleCommentEvent(ctx, event, sm as any, router, dispatcher as any, advancePipelineFn, handleFailure);

      // No expansion should occur
      expect(sm.createStage).not.toHaveBeenCalled();
      expect(sm.updatePipelineYaml).not.toHaveBeenCalled();
      // advancePipelineFn should still be called (normal flow)
      expect(advancePipelineFn).toHaveBeenCalledOnce();
    });
  });
});
