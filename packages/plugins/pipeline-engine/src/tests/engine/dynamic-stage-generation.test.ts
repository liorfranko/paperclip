import { describe, it, expect, vi } from "vitest";
import { Router } from "../../engine/router.js";
import type { PipelineDefinition, PipelineStage, StageStatus, EdgeDefinition, StageDefinition } from "../../types.js";

/**
 * Dynamic Stage Generation Tests (TDD - RED phase)
 *
 * Use-case: A fan_out stage (e.g., "plan-tasks") returns a tracks array with
 * ARBITRARY values at runtime. Unlike static activationKey routing where each
 * possible track must be pre-defined in the pipeline JSON, dynamic stage generation
 * creates new stages at runtime based on what the agent discovers.
 *
 * Flow:
 *   1. Agent completes fan_out stage → output: { tracks: ["auth-service", "user-api", "frontend-widget"] }
 *   2. Engine detects template edges (edges with `template: true`)
 *   3. For each track, engine clones the template target stage with namespaced ID
 *   4. New edges + stages are inserted into the running pipeline
 *   5. Pipeline advances through dynamically generated stages
 *   6. A downstream fan_in waits for all generated stages to complete
 *
 * Template edge definition:
 *   { id: "t1", from: "plan", to: "impl-template", template: true }
 *
 * Template stage definition:
 *   { id: "impl-template", type: "stage", agent_role: "pipe-backend", actionId: "write-implementation", template: true }
 *
 * After expansion with tracks: ["auth-service", "user-api"]:
 *   New stages: "dyn:impl-template:auth-service", "dyn:impl-template:user-api"
 *   New edges from "plan" to each generated stage
 *   New edges from each generated stage to downstream fan_in
 *   Template stage itself is marked "skipped" (it's a blueprint, not executed)
 */

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

// =============================================================================
// Pipeline with TEMPLATE edges for dynamic generation
// =============================================================================
//
// Topology:
//   plan (fan_out) --[template]--> impl-template (stage, template: true)
//   impl-template ---> review (fan_in)
//   review --> merge (stage)
//
// When plan completes with tracks: ["auth-service", "user-api", "frontend-widget"]:
//   plan --> dyn:impl-template:auth-service --> review
//   plan --> dyn:impl-template:user-api --> review
//   plan --> dyn:impl-template:frontend-widget --> review
//   review --> merge
//
const dynamicPipeline: PipelineDefinition = {
  name: "dynamic-fanout",
  description: "Pipeline with dynamic stage generation via template edges",
  trigger: { label: "pipeline:dynamic" },
  stages: [
    { id: "plan", type: "fan_out", agent_role: "pipe-decomposer", actionId: "plan-tasks" },
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

describe("dynamic stage generation (template edges)", () => {
  const router = new Router();

  describe("expansion detection", () => {
    it("detects template edges that need expansion when fan_out completes with tracks", () => {
      // The router should provide a method to detect that a fan_out stage's
      // completion requires dynamic expansion (template edges exist + tracks
      // contain values that don't match any static activationKey edges)
      const planOutput = { tracks: ["auth-service", "user-api", "frontend-widget"], ordering: "parallel" };

      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);

      expect(expansion).not.toBeNull();
      expect(expansion!.templateEdges).toHaveLength(1);
      expect(expansion!.templateEdges[0].id).toBe("e-template");
      expect(expansion!.tracks).toEqual(["auth-service", "user-api", "frontend-widget"]);
    });

    it("returns null when no template edges exist (static routing only)", () => {
      const staticPipeline: PipelineDefinition = {
        name: "static",
        description: "",
        trigger: { label: "pipeline:static" },
        stages: [
          { id: "plan", type: "fan_out", agent_role: "planner", actionId: "plan-tasks" },
          { id: "backend", type: "stage", agent_role: "backend-dev", actionId: "write-implementation" },
          { id: "merge", type: "fan_in" },
        ],
        edges: [
          { id: "e1", from: "plan", to: "backend", activationKey: "backend" },
          { id: "e2", from: "backend", to: "merge" },
        ],
        positions: {},
      };
      const output = { tracks: ["backend"], ordering: "parallel" };

      const expansion = router.detectDynamicExpansion(staticPipeline, "plan", output);

      expect(expansion).toBeNull();
    });

    it("returns null when fan_out produces empty tracks array", () => {
      const output = { tracks: [], ordering: "parallel" };

      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", output);

      expect(expansion).toBeNull();
    });
  });

  describe("pipeline expansion", () => {
    it("generates expanded pipeline with new stages per track", () => {
      const planOutput = { tracks: ["auth-service", "user-api"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);

      // expandPipeline takes the original pipeline + expansion plan and returns
      // a new PipelineDefinition with dynamic stages inserted
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      // Template stage should be removed or marked as non-dispatchable
      const templateStage = expanded.stages.find(s => s.id === "impl-template");
      expect(templateStage).toBeUndefined(); // template is replaced by concrete instances

      // Two new stages should be created
      const authStage = expanded.stages.find(s => s.id === "dyn:impl-template:auth-service");
      const userStage = expanded.stages.find(s => s.id === "dyn:impl-template:user-api");
      expect(authStage).toBeDefined();
      expect(userStage).toBeDefined();

      // New stages inherit properties from template
      expect(authStage!.type).toBe("stage");
      expect((authStage as any).agent_role).toBe("pipe-backend");
      expect((authStage as any).actionId).toBe("write-implementation");
      expect((authStage as any).template).toBeUndefined(); // not a template itself

      expect(userStage!.type).toBe("stage");
      expect((userStage as any).agent_role).toBe("pipe-backend");
      expect((userStage as any).actionId).toBe("write-implementation");
    });

    it("generates edges from fan_out to each dynamic stage", () => {
      const planOutput = { tracks: ["auth-service", "user-api"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      // Edges from plan to each generated stage
      const edgesFromPlan = expanded.edges.filter(e => e.from === "plan" && !e.template);
      const dynamicEdgesFromPlan = edgesFromPlan.filter(e =>
        e.to === "dyn:impl-template:auth-service" || e.to === "dyn:impl-template:user-api"
      );
      expect(dynamicEdgesFromPlan).toHaveLength(2);
    });

    it("generates edges from each dynamic stage to the downstream target", () => {
      const planOutput = { tracks: ["auth-service", "user-api"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      // Edges from each generated stage to review (fan_in)
      const edgesToReview = expanded.edges.filter(e => e.to === "review");
      const dynamicEdgesToReview = edgesToReview.filter(e =>
        e.from === "dyn:impl-template:auth-service" || e.from === "dyn:impl-template:user-api"
      );
      expect(dynamicEdgesToReview).toHaveLength(2);
    });

    it("removes template edges from expanded pipeline", () => {
      const planOutput = { tracks: ["auth-service", "user-api"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      // Original template edge should be removed
      const templateEdges = expanded.edges.filter(e => (e as any).template === true);
      expect(templateEdges).toHaveLength(0);
    });

    it("preserves non-template edges and stages", () => {
      const planOutput = { tracks: ["auth-service"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      // review and merge stages still exist
      expect(expanded.stages.find(s => s.id === "review")).toBeDefined();
      expect(expanded.stages.find(s => s.id === "merge")).toBeDefined();

      // edge from review to merge still exists
      expect(expanded.edges.find(e => e.from === "review" && e.to === "merge")).toBeDefined();
    });

    it("preserves the plan (fan_out) stage in expanded pipeline", () => {
      const planOutput = { tracks: ["svc-a"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      expect(expanded.stages.find(s => s.id === "plan")).toBeDefined();
    });
  });

  describe("routing after expansion", () => {
    it("dynamic stages are ready after fan_out completes (expanded pipeline)", () => {
      // Simulate: plan completed, pipeline has been expanded
      const planOutput = { tracks: ["auth-service", "user-api"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      // State after expansion: plan completed, dynamic stages pending
      const stages: PipelineStage[] = [
        makeStage("plan", "completed", planOutput),
        makeStage("dyn:impl-template:auth-service", "pending"),
        makeStage("dyn:impl-template:user-api", "pending"),
        makeStage("review", "pending"),
        makeStage("merge", "pending"),
      ];

      const ready = router.getReadyStages(expanded, stages);
      const readyIds = ready.map(s => s.id);
      expect(readyIds).toContain("dyn:impl-template:auth-service");
      expect(readyIds).toContain("dyn:impl-template:user-api");
      expect(readyIds).not.toContain("review");
      expect(readyIds).not.toContain("merge");
    });

    it("fan_in waits for ALL dynamic stages to complete", () => {
      const planOutput = { tracks: ["auth-service", "user-api"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      // Only one dynamic stage completed
      const partialStages: PipelineStage[] = [
        makeStage("plan", "completed", planOutput),
        makeStage("dyn:impl-template:auth-service", "completed", { decision: "done" }),
        makeStage("dyn:impl-template:user-api", "running"),
        makeStage("review", "pending"),
        makeStage("merge", "pending"),
      ];

      const ready = router.getReadyStages(expanded, partialStages);
      expect(ready.map(s => s.id)).not.toContain("review");
    });

    it("fan_in activates when ALL dynamic stages complete", () => {
      const planOutput = { tracks: ["auth-service", "user-api"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      // All dynamic stages completed
      const allDoneStages: PipelineStage[] = [
        makeStage("plan", "completed", planOutput),
        makeStage("dyn:impl-template:auth-service", "completed", { decision: "done" }),
        makeStage("dyn:impl-template:user-api", "completed", { decision: "done" }),
        makeStage("review", "pending"),
        makeStage("merge", "pending"),
      ];

      const ready = router.getReadyStages(expanded, allDoneStages);
      expect(ready.map(s => s.id)).toContain("review");
    });
  });

  describe("edge cases", () => {
    it("handles single track (generates one stage)", () => {
      const planOutput = { tracks: ["only-service"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      const dynStages = expanded.stages.filter(s => s.id.startsWith("dyn:"));
      expect(dynStages).toHaveLength(1);
      expect(dynStages[0].id).toBe("dyn:impl-template:only-service");
    });

    it("handles many tracks (generates stages for each)", () => {
      const tracks = Array.from({ length: 10 }, (_, i) => `service-${i}`);
      const planOutput = { tracks, ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      const dynStages = expanded.stages.filter(s => s.id.startsWith("dyn:"));
      expect(dynStages).toHaveLength(10);
    });

    it("sanitizes track names in stage IDs (replaces special chars)", () => {
      const planOutput = { tracks: ["auth/service", "user api", "frontend.widget"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      // Stage IDs should use sanitized track names (no slashes, spaces, or dots)
      const dynStages = expanded.stages.filter(s => s.id.startsWith("dyn:"));
      expect(dynStages).toHaveLength(3);
      // Each ID should be safe (no slashes, spaces)
      for (const stage of dynStages) {
        expect(stage.id).not.toMatch(/[\/\s]/);
      }
    });

    it("each generated edge has a unique ID", () => {
      const planOutput = { tracks: ["svc-a", "svc-b", "svc-c"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      const ids = expanded.edges.map(e => e.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe("multiple template edges (multi-step templates)", () => {
    // Pipeline: plan --[template]--> impl-template --> review-template ---> merge (fan_in)
    // Each track generates both an impl AND a review stage in sequence
    const multiStepPipeline: PipelineDefinition = {
      name: "multi-step-dynamic",
      description: "Pipeline with chained template stages",
      trigger: { label: "pipeline:multi" },
      stages: [
        { id: "plan", type: "fan_out", agent_role: "pipe-decomposer", actionId: "plan-tasks" },
        { id: "impl-template", type: "stage", agent_role: "pipe-backend", actionId: "write-implementation", template: true } as any,
        { id: "review-template", type: "stage", agent_role: "pipe-reviewer", actionId: "review-code-quality", template: true } as any,
        { id: "merge", type: "fan_in" },
      ],
      edges: [
        { id: "e-t1", from: "plan", to: "impl-template", template: true } as EdgeDefinition,
        { id: "e-chain", from: "impl-template", to: "review-template" },
        { id: "e-t2", from: "review-template", to: "merge" },
      ],
      positions: {},
    };

    it("expands chained template stages per track", () => {
      const planOutput = { tracks: ["auth", "users"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(multiStepPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(multiStepPipeline, expansion!);

      // Should generate: impl:auth, review:auth, impl:users, review:users
      const dynStages = expanded.stages.filter(s => s.id.startsWith("dyn:"));
      expect(dynStages).toHaveLength(4);

      // Verify chaining: impl → review per track
      const authImplToReview = expanded.edges.find(
        e => e.from === "dyn:impl-template:auth" && e.to === "dyn:review-template:auth"
      );
      expect(authImplToReview).toBeDefined();

      const usersImplToReview = expanded.edges.find(
        e => e.from === "dyn:impl-template:users" && e.to === "dyn:review-template:users"
      );
      expect(usersImplToReview).toBeDefined();
    });

    it("connects last template stage in chain to fan_in per track", () => {
      const planOutput = { tracks: ["auth", "users"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(multiStepPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(multiStepPipeline, expansion!);

      // review-template → merge becomes dyn:review-template:auth → merge, dyn:review-template:users → merge
      const edgesToMerge = expanded.edges.filter(e => e.to === "merge");
      expect(edgesToMerge.length).toBeGreaterThanOrEqual(2);
      expect(edgesToMerge.find(e => e.from === "dyn:review-template:auth")).toBeDefined();
      expect(edgesToMerge.find(e => e.from === "dyn:review-template:users")).toBeDefined();
    });
  });

  describe("track metadata passed to generated stages", () => {
    it("stores track name in generated stage metadata for context injection", () => {
      const planOutput = { tracks: ["auth-service", "user-api"], ordering: "parallel" };
      const expansion = router.detectDynamicExpansion(dynamicPipeline, "plan", planOutput);
      const expanded = router.expandPipeline(dynamicPipeline, expansion!);

      const authStage = expanded.stages.find(s => s.id === "dyn:impl-template:auth-service") as any;
      expect(authStage.trackName).toBe("auth-service");

      const userStage = expanded.stages.find(s => s.id === "dyn:impl-template:user-api") as any;
      expect(userStage.trackName).toBe("user-api");
    });
  });
});
