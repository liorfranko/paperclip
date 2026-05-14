import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateDAG } from "../../engine/dag-parser.js";
import { advancePipeline } from "../../engine/pipeline-executor.js";
import type { PipelineDefinition } from "../../types.js";

describe("sub-pipeline handling", () => {
  describe("validateDAG warnings", () => {
    it("produces a warning for sub-pipeline stages", () => {
      const pipeline: PipelineDefinition = {
        name: "test-sub-pipeline",
        description: "test",
        trigger: { label: "test" },
        stages: [
          { id: "start", type: "stage", agent_role: "dev", actionId: "triage-new-issues" },
          { id: "sub", type: "sub-pipeline", pipeline: "child-pipeline" },
        ],
        edges: [{ id: "e1", from: "start", to: "sub" }],
        positions: {},
      };

      const result = validateDAG(pipeline);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("sub-pipeline");
      expect(result.warnings[0]).toContain("sub");
    });

    it("produces no warnings when pipeline has no sub-pipeline stages", () => {
      const pipeline: PipelineDefinition = {
        name: "normal",
        description: "test",
        trigger: { label: "test" },
        stages: [
          { id: "a", type: "stage", agent_role: "dev", actionId: "triage-new-issues" },
        ],
        edges: [],
        positions: {},
      };

      const result = validateDAG(pipeline);
      expect(result.valid).toBe(true);
      expect(result.warnings).toHaveLength(0);
    });
  });

  describe("advancePipeline sub-pipeline failure", () => {
    const pipeline: PipelineDefinition = {
      name: "test",
      description: "",
      trigger: { label: "test" },
      stages: [
        { id: "sub-stage", type: "sub-pipeline", pipeline: "child" },
      ],
      edges: [],
      positions: {},
    };

    const runId = "run-1";
    const companyId = "company-1";

    let stateMachine: Record<string, ReturnType<typeof vi.fn>>;
    let router: Record<string, ReturnType<typeof vi.fn>>;
    let dispatcher: Record<string, ReturnType<typeof vi.fn>>;
    let ctx: Record<string, unknown>;
    let emittedEvents: Array<{ event: string; data: unknown }>;

    beforeEach(() => {
      emittedEvents = [];

      ctx = {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        issues: {
          get: vi.fn().mockResolvedValue({ projectId: "proj-1" }),
          createComment: vi.fn().mockResolvedValue(undefined),
        },
        streams: {
          emit: vi.fn((event: string, data: unknown) => {
            emittedEvents.push({ event, data });
          }),
        },
      };

      stateMachine = {
        tryAdvisoryLock: vi.fn().mockResolvedValue(true),
        releaseAdvisoryLock: vi.fn().mockResolvedValue(undefined),
        getRun: vi.fn().mockResolvedValue({ parentIssueId: "issue-1", status: "running" }),
        getRunStages: vi.fn().mockResolvedValue([
          { id: "row-1", stageId: "sub-stage", status: "pending", output: null },
        ]),
        getLoopEdgeCounts: vi.fn().mockResolvedValue({}),
        updateStageStatus: vi.fn().mockResolvedValue(undefined),
        setStageError: vi.fn().mockResolvedValue(undefined),
        claimStageForDispatch: vi.fn().mockResolvedValue(true),
        updateRunStatus: vi.fn().mockResolvedValue(undefined),
      };

      router = {
        getSkippedStages: vi.fn().mockResolvedValue([]),
        getReadyStages: vi.fn().mockResolvedValue([pipeline.stages[0]]),
        evaluateLoopOverflow: vi.fn().mockReturnValue(null),
        getLoopEdgesForReadyStage: vi.fn().mockReturnValue([]),
        getFixedFanoutOutput: vi.fn().mockReturnValue(null),
        requiresAgentDispatch: vi.fn().mockReturnValue(false),
      };

      dispatcher = {};
    });

    it("fails the sub-pipeline stage with explicit error instead of skipping", async () => {
      const handleStageFailureFn = vi.fn().mockResolvedValue(undefined);

      await advancePipeline(
        ctx as never,
        runId,
        pipeline,
        companyId,
        stateMachine as never,
        router as never,
        dispatcher as never,
        handleStageFailureFn,
      );

      // Stage should be marked as failed
      expect(stateMachine.updateStageStatus).toHaveBeenCalledWith("row-1", "failed");

      // Error message should be set
      expect(stateMachine.setStageError).toHaveBeenCalledWith(
        "row-1",
        expect.stringContaining("sub-pipeline"),
      );

      // A comment should be posted on the parent issue
      expect(ctx.issues.createComment).toHaveBeenCalledWith(
        "issue-1",
        expect.stringContaining("sub-pipeline"),
        companyId,
        {},
      );

      // STREAM_RUN_PROGRESS should emit with failed status
      const failedEmit = emittedEvents.find(
        (e) => (e.data as Record<string, unknown>).stageId === "sub-stage" &&
               (e.data as Record<string, unknown>).status === "failed",
      );
      expect(failedEmit).toBeDefined();

      // handleStageFailure should be called
      expect(handleStageFailureFn).toHaveBeenCalled();
    });
  });
});
