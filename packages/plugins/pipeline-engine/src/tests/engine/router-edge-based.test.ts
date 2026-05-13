import { describe, it, expect } from "vitest";
import { Router } from "../../engine/router.js";
import type { PipelineDefinition, PipelineStage, StageStatus } from "../../types.js";

function makeStage(stageId: string, status: StageStatus, output?: Record<string, unknown>, retryCount = 0): PipelineStage {
  return {
    id: `row-${stageId}`,
    pipelineRunId: "run-1",
    stageId,
    subIssueId: null,
    status,
    retryCount,
    output: output ?? null,
    error: null,
    startedAt: null,
    completedAt: null,
  };
}

const featurePipeline: PipelineDefinition = {
  name: "feature",
  description: "",
  trigger: { label: "pipeline:feature" },
  stages: [
    { id: "spec-review", type: "stage", agent_role: "spec-reviewer", actionId: "triage-new-issues" },
    { id: "decompose", type: "stage", agent_role: "decomposer", actionId: "triage-new-issues" },
    { id: "implement", type: "stage", agent_role: "code-writer", actionId: "triage-new-issues" },
    { id: "validate", type: "stage", agent_role: "validator", actionId: "triage-new-issues" },
  ],
  edges: [
    { id: "e1", from: "spec-review", to: "decompose", sourceHandle: "approved" },
    { id: "e2", from: "decompose", to: "implement" },
    { id: "e3", from: "implement", to: "validate" },
    { id: "e4", from: "validate", to: "implement", type: "error" },
  ],
  positions: {},
};

describe("router (edge-based)", () => {
  const router = new Router();

  describe("getReadyStages", () => {
    it("returns root stages when nothing has run", async () => {
      const stages = [makeStage("spec-review", "pending")];
      const ready = await router.getReadyStages(featurePipeline, stages);
      expect(ready.map((s) => s.id)).toContain("spec-review");
    });

    it("returns next stage when unconditional edge source is completed", async () => {
      const stages = [
        makeStage("spec-review", "completed", { decision: "approved" }),
        makeStage("decompose", "completed"),
        makeStage("implement", "pending"),
        makeStage("validate", "pending"),
      ];
      const ready = await router.getReadyStages(featurePipeline, stages);
      expect(ready.map((s) => s.id)).toContain("implement");
    });

    it("returns stage when sourceHandle matches source decision", async () => {
      const stages = [
        makeStage("spec-review", "completed", { decision: "approved" }),
        makeStage("decompose", "pending"),
      ];
      const ready = await router.getReadyStages(featurePipeline, stages);
      expect(ready.map((s) => s.id)).toContain("decompose");
    });

    it("does not return stage when sourceHandle does not match source decision", async () => {
      const stages = [
        makeStage("spec-review", "completed", { decision: "rejected" }),
        makeStage("decompose", "pending"),
      ];
      const ready = await router.getReadyStages(featurePipeline, stages);
      expect(ready.map((s) => s.id)).not.toContain("decompose");
    });

    it("does not return already-running stages", async () => {
      const stages = [makeStage("spec-review", "running")];
      const ready = await router.getReadyStages(featurePipeline, stages);
      expect(ready).toHaveLength(0);
    });

    it("does not return sub-pipeline stages", async () => {
      const pipelineWithSubPipeline: PipelineDefinition = {
        ...featurePipeline,
        stages: [
          { id: "start", type: "stage", agent_role: "worker", actionId: "triage-new-issues" },
          { id: "sub", type: "sub-pipeline", pipeline: "other" },
        ],
        edges: [{ id: "e1", from: "start", to: "sub" }],
      };
      const stages = [
        makeStage("start", "completed"),
        makeStage("sub", "pending"),
      ];
      const ready = await router.getReadyStages(pipelineWithSubPipeline, stages);
      // Sub-pipeline stages are now returned as ready — the executor handles explicit failure
      expect(ready.map((s) => s.id)).toContain("sub");
    });

    it("handles fan_in: waits for all sources", async () => {
      const fanPipeline: PipelineDefinition = {
        name: "fan",
        description: "",
        trigger: { label: "fan" },
        stages: [
          { id: "a", type: "stage", agent_role: "r", actionId: "triage-new-issues" },
          { id: "b", type: "stage", agent_role: "r", actionId: "triage-new-issues" },
          { id: "join", type: "fan_in" },
        ],
        edges: [
          { id: "e1", from: "a", to: "join" },
          { id: "e2", from: "b", to: "join" },
        ],
        positions: {},
      };
      const stages = [
        makeStage("a", "completed"),
        makeStage("b", "pending"),
        makeStage("join", "pending"),
      ];
      const ready = await router.getReadyStages(fanPipeline, stages);
      expect(ready.map((s) => s.id)).not.toContain("join");
    });

    it("fan_in with conditional edges: ready when source resolved and at least one edge satisfied", async () => {
      const decisionFanInPipeline: PipelineDefinition = {
        name: "decision-fan-in",
        description: "",
        trigger: { label: "dfan" },
        stages: [
          { id: "triage", type: "stage", agent_role: "r", actionId: "triage-new-issues" },
          { id: "feat-work", type: "stage", agent_role: "r", actionId: "triage-new-issues" },
          { id: "bug-work", type: "stage", agent_role: "r", actionId: "triage-new-issues" },
          { id: "merge", type: "fan_in" },
        ],
        edges: [
          { id: "e1", from: "triage", to: "feat-work", sourceHandle: "feature" },
          { id: "e2", from: "triage", to: "bug-work", sourceHandle: "bug" },
          { id: "e3", from: "feat-work", to: "merge" },
          { id: "e4", from: "bug-work", to: "merge" },
        ],
        positions: {},
      };
      // triage decided "feature", so feat-work runs and bug-work is skipped
      const stages = [
        makeStage("triage", "completed", { decision: "feature" }),
        makeStage("feat-work", "completed"),
        makeStage("bug-work", "skipped"),
        makeStage("merge", "pending"),
      ];
      const ready = await router.getReadyStages(decisionFanInPipeline, stages);
      expect(ready.map((s) => s.id)).toContain("merge");
    });

    it("fan_in with conditional edges: not ready when sources not resolved", async () => {
      const decisionFanInPipeline: PipelineDefinition = {
        name: "decision-fan-in",
        description: "",
        trigger: { label: "dfan" },
        stages: [
          { id: "triage", type: "stage", agent_role: "r", actionId: "triage-new-issues" },
          { id: "feat-work", type: "stage", agent_role: "r", actionId: "triage-new-issues" },
          { id: "bug-work", type: "stage", agent_role: "r", actionId: "triage-new-issues" },
          { id: "merge", type: "fan_in" },
        ],
        edges: [
          { id: "e1", from: "triage", to: "feat-work", sourceHandle: "feature" },
          { id: "e2", from: "triage", to: "bug-work", sourceHandle: "bug" },
          { id: "e3", from: "feat-work", to: "merge" },
          { id: "e4", from: "bug-work", to: "merge" },
        ],
        positions: {},
      };
      const stages = [
        makeStage("triage", "completed", { decision: "feature" }),
        makeStage("feat-work", "running"),
        makeStage("bug-work", "pending"),
        makeStage("merge", "pending"),
      ];
      const ready = await router.getReadyStages(decisionFanInPipeline, stages);
      expect(ready.map((s) => s.id)).not.toContain("merge");
    });
  });

  describe("getSkippedStages", () => {
    it("marks stage as skipped when sourceHandle does not match source decision", async () => {
      const stages = [
        makeStage("spec-review", "completed", { decision: "rejected" }),
        makeStage("decompose", "pending"),
      ];
      const skipped = await router.getSkippedStages(featurePipeline, stages);
      expect(skipped.map((s) => s.id)).toContain("decompose");
    });

    it("does not skip stage when sourceHandle matches source decision", async () => {
      const stages = [
        makeStage("spec-review", "completed", { decision: "approved" }),
        makeStage("decompose", "pending"),
      ];
      const skipped = await router.getSkippedStages(featurePipeline, stages);
      expect(skipped.map((s) => s.id)).not.toContain("decompose");
    });

    it("does not skip stage with unconditional edge from completed source", async () => {
      const stages = [
        makeStage("spec-review", "completed", { decision: "approved" }),
        makeStage("decompose", "completed"),
        makeStage("implement", "pending"),
      ];
      const skipped = await router.getSkippedStages(featurePipeline, stages);
      expect(skipped.map((s) => s.id)).not.toContain("implement");
    });

    it("does not skip root stages", async () => {
      const stages = [makeStage("spec-review", "pending")];
      const skipped = await router.getSkippedStages(featurePipeline, stages);
      expect(skipped).toHaveLength(0);
    });
  });

  describe("evaluateFailure", () => {
    it("returns goto action when error edge exists", () => {
      const stageRow = makeStage("validate", "failed", { errors: ["test failed"] }, 0);
      const result = router.evaluateFailure(featurePipeline, "validate");
      expect(result.action).toBe("goto");
      if (result.action === "goto") {
        expect(result.targetStageId).toBe("implement");
      }
    });

    it("returns escalate when no error edges exist for the failed stage", () => {
      const stageRow = makeStage("spec-review", "failed", undefined, 0);
      const result = router.evaluateFailure(featurePipeline, "spec-review");
      expect(result.action).toBe("escalate");
    });
  });

  describe("requiresAgentDispatch", () => {
    it("returns true for stage type", () => {
      const stage = featurePipeline.stages.find((s) => s.type === "stage")!;
      expect(router.requiresAgentDispatch(stage)).toBe(true);
    });

    it("returns true for fan_out type with non-fixed action", () => {
      const stage = { id: "fan", type: "fan_out" as const, agent_role: "r", actionId: "plan-tasks" };
      expect(router.requiresAgentDispatch(stage)).toBe(true);
    });

    it("returns false for fan_in type", () => {
      const stage = { id: "join", type: "fan_in" as const };
      expect(router.requiresAgentDispatch(stage)).toBe(false);
    });

    it("returns false for sub-pipeline type", () => {
      const stage = { id: "sub", type: "sub-pipeline" as const, pipeline: "other" };
      expect(router.requiresAgentDispatch(stage)).toBe(false);
    });
  });
});
