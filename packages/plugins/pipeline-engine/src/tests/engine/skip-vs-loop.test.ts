import { describe, it, expect } from "vitest";
import { Router } from "../../engine/router.js";
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

// Mirrors the CI retry loop in autonomous-dev:
// check-ci → dispatch-reviews (activationKey: "pass")
// check-ci → fix-ci-backend (activationKey: "backend")
// fix-ci-backend → ci-fix-sync (sourceHandle: "done")
// ci-fix-sync → check-ci (loop, max_iterations: 3)
const ciLoopPipeline: PipelineDefinition = {
  name: "ci-loop-test",
  description: "",
  trigger: { label: "test" },
  stages: [
    { id: "check-ci", type: "fan_out", agent_role: "ci", actionId: "check-ci" },
    { id: "fix-ci-backend", type: "stage", agent_role: "backend", actionId: "fix-ci" },
    { id: "fix-ci-frontend", type: "stage", agent_role: "frontend", actionId: "fix-ci" },
    { id: "ci-fix-sync", type: "fan_in" },
    { id: "dispatch-reviews", type: "fan_out", agent_role: "reviewer", actionId: "dispatch-code-reviews" },
  ],
  edges: [
    { id: "e-ci-pass", from: "check-ci", to: "dispatch-reviews", activationKey: "pass" },
    { id: "e-ci-backend", from: "check-ci", to: "fix-ci-backend", activationKey: "backend" },
    { id: "e-ci-frontend", from: "check-ci", to: "fix-ci-frontend", activationKey: "frontend" },
    { id: "e-fixbe-sync", from: "fix-ci-backend", to: "ci-fix-sync", sourceHandle: "done" },
    { id: "e-fixfe-sync", from: "fix-ci-frontend", to: "ci-fix-sync", sourceHandle: "done" },
    { id: "e-cisync-recheck", from: "ci-fix-sync", to: "check-ci", type: "loop", max_iterations: 3 },
  ],
  positions: {},
};

// Mirrors evaluate-findings → simplify-code vs loop back to write-backend-impl
const reviewLoopPipeline: PipelineDefinition = {
  name: "review-loop-test",
  description: "",
  trigger: { label: "test" },
  stages: [
    { id: "evaluate-findings", type: "stage", agent_role: "evaluator", actionId: "evaluate-critical-findings" },
    { id: "simplify-code", type: "stage", agent_role: "simplifier", actionId: "simplify-code" },
    { id: "write-backend-impl", type: "stage", agent_role: "backend", actionId: "write-implementation" },
  ],
  edges: [
    { id: "e-pass", from: "evaluate-findings", to: "simplify-code", sourceHandle: "pass" },
    { id: "e-fail", from: "evaluate-findings", to: "write-backend-impl", sourceHandle: "fail-impl", type: "loop", max_iterations: 3 },
  ],
  positions: {},
};

// Mirrors scenario-validator → escalate-validation vs loop back to write-*-impl:
// scenario-validator → escalate-validation (sourceHandle: "not-valid")
// scenario-validator → write-backend-impl (sourceHandle: "not-valid-backend", loop, max=2)
const validatorPipeline: PipelineDefinition = {
  name: "validator-test",
  description: "",
  trigger: { label: "test" },
  stages: [
    { id: "scenario-validator", type: "stage", agent_role: "validator", actionId: "validate-scenario-result" },
    { id: "escalate-validation", type: "stage", agent_role: "escalator", actionId: "escalate" },
    { id: "write-backend-impl", type: "stage", agent_role: "backend", actionId: "write-implementation" },
  ],
  edges: [
    { id: "e-validator-invalid", from: "scenario-validator", to: "escalate-validation", sourceHandle: "not-valid" },
    { id: "e-validator-fix-backend", from: "scenario-validator", to: "write-backend-impl", sourceHandle: "not-valid-backend", type: "loop", max_iterations: 2 },
  ],
  positions: {},
};

describe("skip vs loop: stages should NOT be skipped when source has pending loop re-entry", () => {
  const router = new Router();

  describe("CI loop: check-ci outputs non-pass → dispatch-reviews should NOT be skipped", () => {
    it("does NOT skip dispatch-reviews when check-ci outputs 'backend' and loop iterations remain", async () => {
      const stages: PipelineStage[] = [
        makeStage("check-ci", "completed", { tracks: ["backend"] }),
        makeStage("fix-ci-backend", "pending"),
        makeStage("fix-ci-frontend", "pending"),
        makeStage("ci-fix-sync", "pending"),
        makeStage("dispatch-reviews", "pending"),
      ];

      const skipped = await router.getSkippedStages(ciLoopPipeline, stages, {});
      const skippedIds = skipped.map((s) => s.id);

      expect(skippedIds).not.toContain("dispatch-reviews");
    });

    it("DOES skip fix-ci-frontend (inside loop body — fan_in needs it resolved; will be reset on loop fire)", async () => {
      const stages: PipelineStage[] = [
        makeStage("check-ci", "completed", { tracks: ["backend"] }),
        makeStage("fix-ci-backend", "pending"),
        makeStage("fix-ci-frontend", "pending"),
        makeStage("ci-fix-sync", "pending"),
        makeStage("dispatch-reviews", "pending"),
      ];

      const skipped = await router.getSkippedStages(ciLoopPipeline, stages, {});
      const skippedIds = skipped.map((s) => s.id);

      // fix-ci-frontend IS skipped: it's inside the loop body, the fan_in needs it resolved
      expect(skippedIds).toContain("fix-ci-frontend");
    });

    it("DOES skip dispatch-reviews when loop iterations are exhausted", async () => {
      const stages: PipelineStage[] = [
        makeStage("check-ci", "completed", { tracks: ["backend"] }),
        makeStage("fix-ci-backend", "pending"),
        makeStage("fix-ci-frontend", "pending"),
        makeStage("ci-fix-sync", "pending"),
        makeStage("dispatch-reviews", "pending"),
      ];

      // Loop exhausted (count=3, max=3)
      const skipped = await router.getSkippedStages(ciLoopPipeline, stages, { "e-cisync-recheck": 3 });
      const skippedIds = skipped.map((s) => s.id);

      expect(skippedIds).toContain("dispatch-reviews");
    });

    it("skips fix stages (inside loop body) but NOT dispatch-reviews when check-ci outputs 'pass'", async () => {
      const stages: PipelineStage[] = [
        makeStage("check-ci", "completed", { tracks: ["pass"] }),
        makeStage("fix-ci-backend", "pending"),
        makeStage("fix-ci-frontend", "pending"),
        makeStage("ci-fix-sync", "pending"),
        makeStage("dispatch-reviews", "pending"),
      ];

      const skipped = await router.getSkippedStages(ciLoopPipeline, stages, {});
      const skippedIds = skipped.map((s) => s.id);

      // Fix stages are inside the loop body — skipped so fan_in can proceed
      expect(skippedIds).toContain("fix-ci-backend");
      expect(skippedIds).toContain("fix-ci-frontend");
      // dispatch-reviews is OUTSIDE the loop body — NOT skipped (activationKey "pass" matches!)
      expect(skippedIds).not.toContain("dispatch-reviews");
    });

    it("DOES skip fix stages when loop is exhausted and check-ci outputs 'pass'", async () => {
      const stages: PipelineStage[] = [
        makeStage("check-ci", "completed", { tracks: ["pass"] }),
        makeStage("fix-ci-backend", "pending"),
        makeStage("fix-ci-frontend", "pending"),
        makeStage("ci-fix-sync", "pending"),
        makeStage("dispatch-reviews", "pending"),
      ];

      const skipped = await router.getSkippedStages(ciLoopPipeline, stages, { "e-cisync-recheck": 3 });
      const skippedIds = skipped.map((s) => s.id);

      expect(skippedIds).toContain("fix-ci-backend");
      expect(skippedIds).toContain("fix-ci-frontend");
      expect(skippedIds).not.toContain("dispatch-reviews");
    });
  });

  describe("review loop: evaluate-findings outputs fail-impl → simplify-code should NOT be skipped", () => {
    it("does NOT skip simplify-code when evaluate-findings outputs 'fail-impl' and loop iterations remain", async () => {
      const stages: PipelineStage[] = [
        makeStage("evaluate-findings", "completed", { decision: "fail-impl" }),
        makeStage("simplify-code", "pending"),
        makeStage("write-backend-impl", "pending"),
      ];

      const skipped = await router.getSkippedStages(reviewLoopPipeline, stages, {});
      const skippedIds = skipped.map((s) => s.id);

      expect(skippedIds).not.toContain("simplify-code");
    });

    it("DOES skip simplify-code when evaluate-findings outputs 'fail-impl' but loop is exhausted", async () => {
      const stages: PipelineStage[] = [
        makeStage("evaluate-findings", "completed", { decision: "fail-impl" }),
        makeStage("simplify-code", "pending"),
        makeStage("write-backend-impl", "pending"),
      ];

      const skipped = await router.getSkippedStages(reviewLoopPipeline, stages, { "e-fail": 3 });
      const skippedIds = skipped.map((s) => s.id);

      expect(skippedIds).toContain("simplify-code");
    });

    it("DOES skip simplify-code when evaluate-findings outputs 'fail-impl' but loop sourceHandle matches (loop will fire, source will be re-run)", async () => {
      // This verifies that when the loop CAN fire (sourceHandle matches), the stage is protected
      const stages: PipelineStage[] = [
        makeStage("evaluate-findings", "completed", { decision: "fail-impl" }),
        makeStage("simplify-code", "pending"),
        makeStage("write-backend-impl", "pending"),
      ];

      const skipped = await router.getSkippedStages(reviewLoopPipeline, stages, {});
      const skippedIds = skipped.map((s) => s.id);

      // simplify-code is NOT skipped — the loop will fire and eventually re-run evaluate-findings
      expect(skippedIds).not.toContain("simplify-code");
    });

    it("does NOT skip simplify-code when evaluate-findings outputs 'pass' (edge satisfied)", async () => {
      const stages: PipelineStage[] = [
        makeStage("evaluate-findings", "completed", { decision: "pass" }),
        makeStage("simplify-code", "pending"),
        makeStage("write-backend-impl", "pending"),
      ];

      const skipped = await router.getSkippedStages(reviewLoopPipeline, stages, {});
      const skippedIds = skipped.map((s) => s.id);

      expect(skippedIds).not.toContain("simplify-code");
    });
  });

  describe("validator loop: sourceHandle check prevents false protection", () => {
    it("DOES skip escalate-validation when scenario-validator outputs 'valid' (loop sourceHandle doesn't match)", async () => {
      const stages: PipelineStage[] = [
        makeStage("scenario-validator", "completed", { decision: "valid" }),
        makeStage("escalate-validation", "pending"),
        makeStage("write-backend-impl", "pending"),
      ];

      const skipped = await router.getSkippedStages(validatorPipeline, stages, {});
      const skippedIds = skipped.map((s) => s.id);

      // Loop sourceHandle is "not-valid-backend" but output is "valid" — loop won't fire
      // So escalate-validation should be skipped (no edge satisfied, no protection)
      expect(skippedIds).toContain("escalate-validation");
    });

    it("does NOT skip escalate-validation when scenario-validator outputs 'not-valid-backend' (loop will fire)", async () => {
      const stages: PipelineStage[] = [
        makeStage("scenario-validator", "completed", { decision: "not-valid-backend" }),
        makeStage("escalate-validation", "pending"),
        makeStage("write-backend-impl", "pending"),
      ];

      const skipped = await router.getSkippedStages(validatorPipeline, stages, {});
      const skippedIds = skipped.map((s) => s.id);

      // Loop sourceHandle matches — source will be re-run, so don't skip
      expect(skippedIds).not.toContain("escalate-validation");
    });

    it("DOES skip escalate-validation when loop sourceHandle matches but iterations exhausted", async () => {
      const stages: PipelineStage[] = [
        makeStage("scenario-validator", "completed", { decision: "not-valid-backend" }),
        makeStage("escalate-validation", "pending"),
        makeStage("write-backend-impl", "pending"),
      ];

      const skipped = await router.getSkippedStages(validatorPipeline, stages, { "e-validator-fix-backend": 2 });
      const skippedIds = skipped.map((s) => s.id);

      expect(skippedIds).toContain("escalate-validation");
    });
  });
});
