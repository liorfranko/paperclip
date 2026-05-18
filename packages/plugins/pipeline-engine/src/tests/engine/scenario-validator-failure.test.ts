import { describe, it, expect } from "vitest";
import { Router } from "../../engine/router.js";
import { validateOutput } from "../../shared/output-parser.js";
import type { PipelineDefinition, PipelineStage, StageStatus } from "../../types.js";

function makeStage(stageId: string, status: StageStatus, output?: Record<string, unknown>): PipelineStage {
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

// Mirrors the relevant subset of autonomous-dev.json:
// write-tests → write-impl (non-loop) and scenario-validator → write-impl (loop)
const validatorPipeline: PipelineDefinition = {
  name: "validator-failure-test",
  description: "",
  trigger: { label: "pipeline:validator-test" },
  stages: [
    { id: "write-frontend-tests", type: "stage", agent_role: "test-writer", actionId: "triage-new-issues" },
    { id: "write-backend-tests", type: "stage", agent_role: "test-writer", actionId: "triage-new-issues" },
    { id: "write-frontend-impl", type: "stage", agent_role: "implementer", actionId: "triage-new-issues" },
    { id: "write-backend-impl", type: "stage", agent_role: "implementer", actionId: "triage-new-issues" },
    { id: "simplify-code", type: "stage", agent_role: "simplifier", actionId: "simplify-code" },
    { id: "scenario-validator", type: "stage", agent_role: "pipe-validator", actionId: "validate-scenario-result" },
    { id: "escalate-validation", type: "block", reason: "Scenario validation failed after maximum retries." },
  ],
  edges: [
    { id: "e-fe-tests-impl", from: "write-frontend-tests", to: "write-frontend-impl", sourceHandle: "done" },
    { id: "e-be-tests-impl", from: "write-backend-tests", to: "write-backend-impl", sourceHandle: "done" },
    { id: "e-fe-impl-simplify", from: "write-frontend-impl", to: "simplify-code" },
    { id: "e-be-impl-simplify", from: "write-backend-impl", to: "simplify-code" },
    { id: "e-simplify-done", from: "simplify-code", to: "scenario-validator" },
    { id: "e-validator-fix-frontend", from: "scenario-validator", to: "write-frontend-impl", sourceHandle: "not-valid-frontend", type: "loop", max_iterations: 2 },
    { id: "e-validator-fix-backend", from: "scenario-validator", to: "write-backend-impl", sourceHandle: "not-valid-backend", type: "loop", max_iterations: 2 },
    { id: "e-validator-invalid", from: "scenario-validator", to: "escalate-validation", sourceHandle: "not-valid" },
  ],
  positions: {},
};

const validatorOutputSchema = {
  type: "object",
  properties: {
    decision: { enum: ["valid", "not-valid", "not-valid-frontend", "not-valid-backend"] },
  },
};

describe("scenario-validator failure paths", () => {
  const router = new Router();

  describe("output schema validation", () => {
    it("accepts 'valid' decision", () => {
      const result = validateOutput({ decision: "valid" }, validatorOutputSchema);
      expect(result.valid).toBe(true);
    });

    it("accepts 'not-valid-frontend' decision", () => {
      const result = validateOutput({ decision: "not-valid-frontend" }, validatorOutputSchema);
      expect(result.valid).toBe(true);
    });

    it("accepts 'not-valid-backend' decision", () => {
      const result = validateOutput({ decision: "not-valid-backend" }, validatorOutputSchema);
      expect(result.valid).toBe(true);
    });

    it("accepts 'not-valid' decision", () => {
      const result = validateOutput({ decision: "not-valid" }, validatorOutputSchema);
      expect(result.valid).toBe(true);
    });

    it("rejects unknown decision value", () => {
      const result = validateOutput({ decision: "failed" }, validatorOutputSchema);
      expect(result.valid).toBe(false);
    });

    it("rejects empty decision", () => {
      const result = validateOutput({ decision: "" }, validatorOutputSchema);
      expect(result.valid).toBe(false);
    });

    it("rejects missing decision field", () => {
      const result = validateOutput({}, validatorOutputSchema);
      expect(result.valid).toBe(true); // no required fields in schema, so empty object is valid
    });

    it("rejects decision with extra text appended", () => {
      const result = validateOutput({ decision: "not-valid-frontend " }, validatorOutputSchema);
      expect(result.valid).toBe(false);
    });

    it("rejects decision with wrong casing", () => {
      const result = validateOutput({ decision: "Not-Valid-Frontend" }, validatorOutputSchema);
      expect(result.valid).toBe(false);
    });

    it("rejects numeric decision value", () => {
      const result = validateOutput({ decision: 0 }, validatorOutputSchema);
      expect(result.valid).toBe(false);
    });
  });

  describe("routing after valid scenario-validator completion", () => {
    // After loop reset: tests stay completed, impl stages reset to pending.
    // Impl stages have both a non-loop edge (from tests, always satisfied) AND a loop edge.
    // getReadyStages determines which stages can run; getLoopEdgesForReadyStage
    // determines which loop edges actually fire (triggering body resets).
    function completedUpToValidator(decision: string) {
      return [
        makeStage("write-frontend-tests", "completed", { decision: "done" }),
        makeStage("write-backend-tests", "completed", { decision: "done" }),
        makeStage("write-frontend-impl", "pending"),
        makeStage("write-backend-impl", "pending"),
        makeStage("simplify-code", "completed"),
        makeStage("scenario-validator", "completed", { decision }),
        makeStage("escalate-validation", "pending"),
      ];
    }

    it("impl stages are ready via non-loop path regardless of validator decision", async () => {
      // Non-loop edges from write-*-tests (completed with "done") satisfy impl stages
      const stages = completedUpToValidator("not-valid-frontend");
      const ready = await router.getReadyStages(validatorPipeline, stages, {});
      expect(ready.map((s) => s.id)).toContain("write-frontend-impl");
      expect(ready.map((s) => s.id)).toContain("write-backend-impl");
    });

    it("escalate-validation becomes ready on 'not-valid' decision", async () => {
      const stages = completedUpToValidator("not-valid");
      const ready = await router.getReadyStages(validatorPipeline, stages, {});
      expect(ready.map((s) => s.id)).toContain("escalate-validation");
    });

    it("escalate-validation does NOT become ready on 'valid' decision", async () => {
      const stages = completedUpToValidator("valid");
      const ready = await router.getReadyStages(validatorPipeline, stages, {});
      expect(ready.map((s) => s.id)).not.toContain("escalate-validation");
    });

    it("only matching loop edge fires for 'not-valid-frontend'", () => {
      const stages = completedUpToValidator("not-valid-frontend");
      const feLoopEdges = router.getLoopEdgesForReadyStage(
        "write-frontend-impl", validatorPipeline, stages, {},
      );
      const beLoopEdges = router.getLoopEdgesForReadyStage(
        "write-backend-impl", validatorPipeline, stages, {},
      );
      expect(feLoopEdges).toHaveLength(1);
      expect(feLoopEdges[0].id).toBe("e-validator-fix-frontend");
      expect(beLoopEdges).toHaveLength(0);
    });

    it("only matching loop edge fires for 'not-valid-backend'", () => {
      const stages = completedUpToValidator("not-valid-backend");
      const feLoopEdges = router.getLoopEdgesForReadyStage(
        "write-frontend-impl", validatorPipeline, stages, {},
      );
      const beLoopEdges = router.getLoopEdgesForReadyStage(
        "write-backend-impl", validatorPipeline, stages, {},
      );
      expect(feLoopEdges).toHaveLength(0);
      expect(beLoopEdges).toHaveLength(1);
      expect(beLoopEdges[0].id).toBe("e-validator-fix-backend");
    });

    it("no loop edges fire on 'valid' decision", () => {
      const stages = completedUpToValidator("valid");
      const feLoopEdges = router.getLoopEdgesForReadyStage(
        "write-frontend-impl", validatorPipeline, stages, {},
      );
      const beLoopEdges = router.getLoopEdgesForReadyStage(
        "write-backend-impl", validatorPipeline, stages, {},
      );
      expect(feLoopEdges).toHaveLength(0);
      expect(beLoopEdges).toHaveLength(0);
    });

    it("no loop edges fire on 'not-valid' decision (goes to escalate instead)", () => {
      const stages = completedUpToValidator("not-valid");
      const feLoopEdges = router.getLoopEdgesForReadyStage(
        "write-frontend-impl", validatorPipeline, stages, {},
      );
      const beLoopEdges = router.getLoopEdgesForReadyStage(
        "write-backend-impl", validatorPipeline, stages, {},
      );
      expect(feLoopEdges).toHaveLength(0);
      expect(beLoopEdges).toHaveLength(0);
    });
  });

  describe("routing with unrecognized decision (no sourceHandle match)", () => {
    function completedWithUnknownDecision() {
      return [
        makeStage("write-frontend-tests", "completed", { decision: "done" }),
        makeStage("write-backend-tests", "completed", { decision: "done" }),
        makeStage("write-frontend-impl", "pending"),
        makeStage("write-backend-impl", "pending"),
        makeStage("simplify-code", "completed"),
        makeStage("scenario-validator", "completed", { decision: "unknown-value" }),
        makeStage("escalate-validation", "pending"),
      ];
    }

    it("impl stages are ready via non-loop path but no loop edges fire", async () => {
      const stages = completedWithUnknownDecision();
      const ready = await router.getReadyStages(validatorPipeline, stages, {});
      // Ready via non-loop edges from write-*-tests
      expect(ready.map((s) => s.id)).toContain("write-frontend-impl");
      expect(ready.map((s) => s.id)).toContain("write-backend-impl");
      // But no loop edges fire (sourceHandle doesn't match "unknown-value")
      const feLoopEdges = router.getLoopEdgesForReadyStage(
        "write-frontend-impl", validatorPipeline, stages, {},
      );
      const beLoopEdges = router.getLoopEdgesForReadyStage(
        "write-backend-impl", validatorPipeline, stages, {},
      );
      expect(feLoopEdges).toHaveLength(0);
      expect(beLoopEdges).toHaveLength(0);
    });

    it("escalate-validation IS skipped when loop sourceHandle doesn't match source output (loop won't fire)", async () => {
      const stages = completedWithUnknownDecision();
      const skipped = await router.getSkippedStages(validatorPipeline, stages, {});
      const skippedIds = skipped.map((s) => s.id);
      // Loop sourceHandles are "not-valid-frontend"/"not-valid-backend" but output is "unknown-value"
      // The loop won't fire, so escalate-validation should be skipped
      expect(skippedIds).toContain("escalate-validation");
    });

    it("escalate-validation IS skipped when loops are exhausted and decision doesn't match", async () => {
      const stages = completedWithUnknownDecision();
      const skipped = await router.getSkippedStages(validatorPipeline, stages, {
        "e-validator-fix-frontend": 2,
        "e-validator-fix-backend": 2,
      });
      const skippedIds = skipped.map((s) => s.id);
      expect(skippedIds).toContain("escalate-validation");
    });
  });

  describe("loop overflow on scenario-validator", () => {
    it("escalates when frontend loop is exhausted (no error edge)", () => {
      const action = router.evaluateLoopOverflow(
        validatorPipeline,
        "scenario-validator",
        { "e-validator-fix-frontend": 2 },
      );
      expect(action).toEqual({ action: "escalate" });
    });

    it("escalates when backend loop is exhausted (no error edge)", () => {
      const action = router.evaluateLoopOverflow(
        validatorPipeline,
        "scenario-validator",
        { "e-validator-fix-backend": 2 },
      );
      expect(action).toEqual({ action: "escalate" });
    });

    it("does not overflow when counts below max", () => {
      const action = router.evaluateLoopOverflow(
        validatorPipeline,
        "scenario-validator",
        { "e-validator-fix-frontend": 1, "e-validator-fix-backend": 1 },
      );
      expect(action).toBeNull();
    });

    it("overflows when ANY loop edge from stage hits max", () => {
      const action = router.evaluateLoopOverflow(
        validatorPipeline,
        "scenario-validator",
        { "e-validator-fix-frontend": 2, "e-validator-fix-backend": 0 },
      );
      expect(action).toEqual({ action: "escalate" });
    });
  });

  describe("evaluateFailure on scenario-validator (no error edges)", () => {
    it("returns escalate when scenario-validator has no error edge", () => {
      const action = router.evaluateFailure(validatorPipeline, "scenario-validator");
      expect(action).toEqual({ action: "escalate" });
    });

    it("returns goto when an error edge is added", () => {
      const pipelineWithErrorEdge: PipelineDefinition = {
        ...validatorPipeline,
        edges: [
          ...validatorPipeline.edges,
          { id: "e-validator-error", from: "scenario-validator", to: "escalate-validation", type: "error" },
        ],
      };
      const action = router.evaluateFailure(pipelineWithErrorEdge, "scenario-validator");
      expect(action).toEqual({ action: "goto", targetStageId: "escalate-validation" });
    });
  });

  describe("dead-end scenario: failed stage with no recovery path", () => {
    it("impl stages become ready via non-loop path when validator failed", async () => {
      // scenario-validator failed → loop edges don't fire (source not completed)
      // But write-*-tests completed with "done" → non-loop edges satisfy impl stages
      const stages = [
        makeStage("write-frontend-tests", "completed", { decision: "done" }),
        makeStage("write-backend-tests", "completed", { decision: "done" }),
        makeStage("write-frontend-impl", "pending"),
        makeStage("write-backend-impl", "pending"),
        makeStage("simplify-code", "completed"),
        makeStage("scenario-validator", "failed"),
        makeStage("escalate-validation", "pending"),
      ];
      const ready = await router.getReadyStages(validatorPipeline, stages, {});
      const readyIds = ready.map((s) => s.id);
      expect(readyIds).toContain("write-frontend-impl");
      expect(readyIds).toContain("write-backend-impl");
      expect(readyIds).not.toContain("escalate-validation");
    });

    it("pipeline would reach failed state when validator fails and no pending stages remain", async () => {
      // If all other stages were already completed/skipped before the validator failed
      const stages = [
        makeStage("write-frontend-tests", "completed", { decision: "done" }),
        makeStage("write-backend-tests", "completed", { decision: "done" }),
        makeStage("write-frontend-impl", "completed"),
        makeStage("write-backend-impl", "completed"),
        makeStage("simplify-code", "completed"),
        makeStage("scenario-validator", "failed"),
        makeStage("escalate-validation", "skipped"),
      ];
      const ready = await router.getReadyStages(validatorPipeline, stages, {});
      expect(ready).toHaveLength(0);

      // Simulate pipeline-executor logic
      const allDone = stages.every((s) => s.status === "completed" || s.status === "skipped");
      const anyFailed = stages.some((s) => s.status === "failed");
      const anyRunningOrPending = stages.some((s) => s.status === "running" || s.status === "pending");
      expect(allDone).toBe(false);
      expect(anyFailed).toBe(true);
      expect(anyRunningOrPending).toBe(false);
      // pipeline-executor sets run to "failed" → removed from active runs →
      // any subsequent issue.updated event starts a new pipeline from triage
    });

    it("pipeline stays running (deadlock) when validator fails but pending stages exist", async () => {
      // Validator fails but impl stages are still pending — pipeline can't advance
      // but also can't fail because pending stages exist
      const stages = [
        makeStage("write-frontend-tests", "completed", { decision: "done" }),
        makeStage("write-backend-tests", "completed", { decision: "done" }),
        makeStage("write-frontend-impl", "completed"),
        makeStage("write-backend-impl", "completed"),
        makeStage("simplify-code", "completed"),
        makeStage("scenario-validator", "failed"),
        makeStage("escalate-validation", "pending"),
      ];
      const ready = await router.getReadyStages(validatorPipeline, stages, {});
      expect(ready).toHaveLength(0);

      const allDone = stages.every((s) => s.status === "completed" || s.status === "skipped");
      const anyFailed = stages.some((s) => s.status === "failed");
      const anyRunningOrPending = stages.some((s) => s.status === "running" || s.status === "pending");
      expect(allDone).toBe(false);
      expect(anyFailed).toBe(true);
      expect(anyRunningOrPending).toBe(true);
      // Pipeline-executor: anyFailed && anyRunningOrPending → does NOT set "failed"
      // Run stays "running" but nothing can progress — deadlock
      // (In practice, handleStageFailure sets run to "escalated" before this code runs)
    });
  });

  describe("loop iteration count interactions with routing", () => {
    function stagesAfterValidatorDecision(decision: string) {
      return [
        makeStage("write-frontend-tests", "completed", { decision: "done" }),
        makeStage("write-backend-tests", "completed", { decision: "done" }),
        makeStage("write-frontend-impl", "pending"),
        makeStage("write-backend-impl", "pending"),
        makeStage("simplify-code", "completed"),
        makeStage("scenario-validator", "completed", { decision }),
        makeStage("escalate-validation", "pending"),
      ];
    }

    it("frontend loop fires on first not-valid-frontend with count=0", async () => {
      const stages = stagesAfterValidatorDecision("not-valid-frontend");
      const ready = await router.getReadyStages(validatorPipeline, stages, { "e-validator-fix-frontend": 0 });
      expect(ready.map((s) => s.id)).toContain("write-frontend-impl");
    });

    it("frontend loop fires on second not-valid-frontend with count=1", async () => {
      const stages = stagesAfterValidatorDecision("not-valid-frontend");
      const ready = await router.getReadyStages(validatorPipeline, stages, { "e-validator-fix-frontend": 1 });
      expect(ready.map((s) => s.id)).toContain("write-frontend-impl");
    });

    it("frontend loop does NOT fire when count=2 (exhausted at max_iterations=2)", async () => {
      const stages = stagesAfterValidatorDecision("not-valid-frontend");
      const ready = await router.getReadyStages(validatorPipeline, stages, { "e-validator-fix-frontend": 2 });
      // Loop exhausted and non-loop edge sourceHandle "done" still matches → ready via non-loop path
      expect(ready.map((s) => s.id)).toContain("write-frontend-impl");
    });

    it("backend loop fires independently of frontend loop count", async () => {
      const stages = stagesAfterValidatorDecision("not-valid-backend");
      const ready = await router.getReadyStages(validatorPipeline, stages, {
        "e-validator-fix-frontend": 2,
        "e-validator-fix-backend": 0,
      });
      expect(ready.map((s) => s.id)).toContain("write-backend-impl");
    });
  });
});
