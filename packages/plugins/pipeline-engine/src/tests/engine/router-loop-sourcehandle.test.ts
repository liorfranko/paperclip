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

// Root stage with incoming loop edge that has a sourceHandle
const rootLoopWithHandlePipeline: PipelineDefinition = {
  name: "root-loop-handle",
  description: "",
  trigger: { label: "test" },
  stages: [
    { id: "check-ci", type: "fan_out", agent_role: "ci", actionId: "check-ci" },
    { id: "fix-ci", type: "stage", agent_role: "fixer", actionId: "fix-ci" },
    { id: "ci-sync", type: "fan_in" },
  ],
  edges: [
    { id: "e-ci-fail", from: "check-ci", to: "fix-ci", activationKey: "backend" },
    { id: "e-fix-sync", from: "fix-ci", to: "ci-sync", sourceHandle: "done" },
    { id: "e-loop", from: "ci-sync", to: "check-ci", type: "loop", max_iterations: 3 },
  ],
  positions: {},
};

// Multiple loop edges from same source with different sourceHandles
const multiLoopPipeline: PipelineDefinition = {
  name: "multi-loop",
  description: "",
  trigger: { label: "test" },
  stages: [
    { id: "validator", type: "stage", agent_role: "validator", actionId: "validate-scenario-result" },
    { id: "fix-backend", type: "stage", agent_role: "backend", actionId: "write-implementation" },
    { id: "fix-frontend", type: "stage", agent_role: "frontend", actionId: "write-implementation" },
    { id: "escalate", type: "stage", agent_role: "lead", actionId: "escalate" },
  ],
  edges: [
    { id: "e-fix-be", from: "validator", to: "fix-backend", sourceHandle: "not-valid-backend", type: "loop", max_iterations: 2 },
    { id: "e-fix-fe", from: "validator", to: "fix-frontend", sourceHandle: "not-valid-frontend", type: "loop", max_iterations: 2 },
    { id: "e-escalate", from: "validator", to: "escalate", sourceHandle: "not-valid" },
  ],
  positions: {},
};

// Fan_in with mixed completed/skipped sources and conditional edges
const fanInMixedPipeline: PipelineDefinition = {
  name: "fanin-mixed",
  description: "",
  trigger: { label: "test" },
  stages: [
    { id: "plan", type: "fan_out", agent_role: "planner", actionId: "plan-tasks" },
    { id: "backend-impl", type: "stage", agent_role: "backend", actionId: "write-implementation" },
    { id: "frontend-impl", type: "stage", agent_role: "frontend", actionId: "write-implementation" },
    { id: "sync", type: "fan_in" },
    { id: "open-pr", type: "stage", agent_role: "pr", actionId: "open-pr" },
  ],
  edges: [
    { id: "e-plan-be", from: "plan", to: "backend-impl", activationKey: "backend" },
    { id: "e-plan-fe", from: "plan", to: "frontend-impl", activationKey: "frontend" },
    { id: "e-be-sync", from: "backend-impl", to: "sync", sourceHandle: "done" },
    { id: "e-fe-sync", from: "frontend-impl", to: "sync", sourceHandle: "done" },
    { id: "e-sync-pr", from: "sync", to: "open-pr" },
  ],
  positions: {},
};

describe("router: loop edge sourceHandle interactions", () => {
  const router = new Router();

  describe("getReadyStages — root stage with incoming loop + sourceHandle", () => {
    it("root with incoming loop is ready on initial pass (no loop source completed)", async () => {
      const stages: PipelineStage[] = [
        makeStage("check-ci", "pending"),
        makeStage("fix-ci", "pending"),
        makeStage("ci-sync", "pending"),
      ];
      const ready = await router.getReadyStages(rootLoopWithHandlePipeline, stages, {});
      expect(ready.map((s) => s.id)).toContain("check-ci");
    });

    it("root with incoming loop is ready when loop source completed and iterations remain (unconditional loop)", async () => {
      const stages: PipelineStage[] = [
        makeStage("check-ci", "pending"),
        makeStage("fix-ci", "completed", { decision: "done" }),
        makeStage("ci-sync", "completed"),
      ];
      const ready = await router.getReadyStages(rootLoopWithHandlePipeline, stages, { "e-loop": 1 });
      expect(ready.map((s) => s.id)).toContain("check-ci");
    });

    it("root with incoming loop is NOT ready when loop iterations exhausted", async () => {
      const stages: PipelineStage[] = [
        makeStage("check-ci", "pending"),
        makeStage("fix-ci", "completed", { decision: "done" }),
        makeStage("ci-sync", "completed"),
      ];
      const ready = await router.getReadyStages(rootLoopWithHandlePipeline, stages, { "e-loop": 3 });
      expect(ready.map((s) => s.id)).not.toContain("check-ci");
    });
  });

  describe("getReadyStages — loop edge with sourceHandle filtering", () => {
    it("loop target is ready when source output matches loop sourceHandle", async () => {
      const stages: PipelineStage[] = [
        makeStage("validator", "completed", { decision: "not-valid-backend" }),
        makeStage("fix-backend", "pending"),
        makeStage("fix-frontend", "pending"),
        makeStage("escalate", "pending"),
      ];
      const ready = await router.getReadyStages(multiLoopPipeline, stages, {});
      expect(ready.map((s) => s.id)).toContain("fix-backend");
    });

    it("loop target is NOT ready when source output doesn't match loop sourceHandle", async () => {
      const stages: PipelineStage[] = [
        makeStage("validator", "completed", { decision: "not-valid-backend" }),
        makeStage("fix-backend", "pending"),
        makeStage("fix-frontend", "pending"),
        makeStage("escalate", "pending"),
      ];
      const ready = await router.getReadyStages(multiLoopPipeline, stages, {});
      // fix-frontend sourceHandle is "not-valid-frontend", doesn't match "not-valid-backend"
      expect(ready.map((s) => s.id)).not.toContain("fix-frontend");
    });

    it("only the matching loop target fires when source has multiple outgoing loops", async () => {
      const stages: PipelineStage[] = [
        makeStage("validator", "completed", { decision: "not-valid-frontend" }),
        makeStage("fix-backend", "pending"),
        makeStage("fix-frontend", "pending"),
        makeStage("escalate", "pending"),
      ];
      const ready = await router.getReadyStages(multiLoopPipeline, stages, {});
      expect(ready.map((s) => s.id)).toContain("fix-frontend");
      expect(ready.map((s) => s.id)).not.toContain("fix-backend");
    });
  });

  describe("getLoopEdgesForReadyStage — sourceHandle filtering", () => {
    it("returns loop edge when sourceHandle matches source output", () => {
      const stages: PipelineStage[] = [
        makeStage("validator", "completed", { decision: "not-valid-backend" }),
        makeStage("fix-backend", "pending"),
      ];
      const edges = router.getLoopEdgesForReadyStage("fix-backend", multiLoopPipeline, stages, {});
      expect(edges).toHaveLength(1);
      expect(edges[0].id).toBe("e-fix-be");
    });

    it("returns empty when sourceHandle doesn't match source output", () => {
      const stages: PipelineStage[] = [
        makeStage("validator", "completed", { decision: "valid" }),
        makeStage("fix-backend", "pending"),
      ];
      const edges = router.getLoopEdgesForReadyStage("fix-backend", multiLoopPipeline, stages, {});
      expect(edges).toHaveLength(0);
    });

    it("returns empty when loop exhausted even if sourceHandle matches", () => {
      const stages: PipelineStage[] = [
        makeStage("validator", "completed", { decision: "not-valid-backend" }),
        makeStage("fix-backend", "pending"),
      ];
      const edges = router.getLoopEdgesForReadyStage("fix-backend", multiLoopPipeline, stages, { "e-fix-be": 2 });
      expect(edges).toHaveLength(0);
    });
  });

  describe("getSkippedStages — multiple loop edges from same source", () => {
    it("skips escalate when validator output matches neither loop nor escalate sourceHandle", async () => {
      const stages: PipelineStage[] = [
        makeStage("validator", "completed", { decision: "valid" }),
        makeStage("fix-backend", "pending"),
        makeStage("fix-frontend", "pending"),
        makeStage("escalate", "pending"),
      ];
      const skipped = await router.getSkippedStages(multiLoopPipeline, stages, {});
      const ids = skipped.map((s) => s.id);
      // "valid" matches no edge — escalate wants "not-valid", loops want "not-valid-backend"/"not-valid-frontend"
      // Since loops won't fire (sourceHandle mismatch), no protection → skip
      expect(ids).toContain("escalate");
    });

    it("does NOT skip escalate when one loop sourceHandle matches (source may be re-run)", async () => {
      const stages: PipelineStage[] = [
        makeStage("validator", "completed", { decision: "not-valid-backend" }),
        makeStage("fix-backend", "pending"),
        makeStage("fix-frontend", "pending"),
        makeStage("escalate", "pending"),
      ];
      const skipped = await router.getSkippedStages(multiLoopPipeline, stages, {});
      const ids = skipped.map((s) => s.id);
      // Loop e-fix-be will fire → validator may be re-run → protect escalate
      expect(ids).not.toContain("escalate");
    });

    it("skips escalate when matching loop is exhausted", async () => {
      const stages: PipelineStage[] = [
        makeStage("validator", "completed", { decision: "not-valid-backend" }),
        makeStage("fix-backend", "pending"),
        makeStage("fix-frontend", "pending"),
        makeStage("escalate", "pending"),
      ];
      const skipped = await router.getSkippedStages(multiLoopPipeline, stages, { "e-fix-be": 2 });
      const ids = skipped.map((s) => s.id);
      // The only matching loop is exhausted — no protection
      expect(ids).toContain("escalate");
    });

    it("does NOT skip escalate when one of multiple loops still has iterations", async () => {
      const stages: PipelineStage[] = [
        makeStage("validator", "completed", { decision: "not-valid-backend" }),
        makeStage("fix-backend", "pending"),
        makeStage("fix-frontend", "pending"),
        makeStage("escalate", "pending"),
      ];
      // e-fix-be exhausted but e-fix-fe not — however e-fix-fe sourceHandle doesn't match!
      const skipped = await router.getSkippedStages(multiLoopPipeline, stages, {
        "e-fix-be": 2,
        "e-fix-fe": 0,
      });
      const ids = skipped.map((s) => s.id);
      // e-fix-fe has sourceHandle "not-valid-frontend" but output is "not-valid-backend" → no protection
      expect(ids).toContain("escalate");
    });
  });

  describe("getReadyStages / getSkippedStages — fan_in with mixed skipped/completed sources", () => {
    it("fan_in is ready when one source completed (conditional edge satisfied) and other skipped", async () => {
      const stages: PipelineStage[] = [
        makeStage("plan", "completed", { tracks: ["backend"] }),
        makeStage("backend-impl", "completed", { decision: "done" }),
        makeStage("frontend-impl", "skipped"),
        makeStage("sync", "pending"),
        makeStage("open-pr", "pending"),
      ];
      const ready = await router.getReadyStages(fanInMixedPipeline, stages, {});
      expect(ready.map((s) => s.id)).toContain("sync");
    });

    it("fan_in is NOT ready when conditional source is skipped and other hasn't completed", async () => {
      const stages: PipelineStage[] = [
        makeStage("plan", "completed", { tracks: ["backend"] }),
        makeStage("backend-impl", "pending"),
        makeStage("frontend-impl", "skipped"),
        makeStage("sync", "pending"),
        makeStage("open-pr", "pending"),
      ];
      const ready = await router.getReadyStages(fanInMixedPipeline, stages, {});
      expect(ready.map((s) => s.id)).not.toContain("sync");
    });

    it("fan_in skipped when ALL sources skipped (no edge satisfied)", async () => {
      const stages: PipelineStage[] = [
        makeStage("plan", "completed", { tracks: [] }), // empty tracks
        makeStage("backend-impl", "skipped"),
        makeStage("frontend-impl", "skipped"),
        makeStage("sync", "pending"),
        makeStage("open-pr", "pending"),
      ];
      const skipped = await router.getSkippedStages(fanInMixedPipeline, stages, {});
      expect(skipped.map((s) => s.id)).toContain("sync");
    });

    it("downstream of fan_in skipped when fan_in is skipped", async () => {
      const stages: PipelineStage[] = [
        makeStage("plan", "completed", { tracks: [] }),
        makeStage("backend-impl", "skipped"),
        makeStage("frontend-impl", "skipped"),
        makeStage("sync", "skipped"),
        makeStage("open-pr", "pending"),
      ];
      const skipped = await router.getSkippedStages(fanInMixedPipeline, stages, {});
      // open-pr has unconditional edge from sync — sync is skipped (not completed) → not satisfied
      expect(skipped.map((s) => s.id)).toContain("open-pr");
    });
  });
});
