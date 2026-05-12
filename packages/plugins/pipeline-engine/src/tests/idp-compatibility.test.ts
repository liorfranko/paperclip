import { describe, it, expect } from "vitest";
import { parsePipeline, validateDAG } from "../dag-parser.js";
import { Router } from "../router.js";
import type { PipelineDefinition, PipelineStage, StageStatus } from "../types.js";

const FEATURE_JSON: PipelineDefinition = {
  name: "feature",
  description: "Full feature development pipeline",
  trigger: { label: "pipeline:feature" },
  stages: [
    { id: "spec-review", type: "stage", agent_role: "spec-reviewer", actionId: "validate-spec" },
    { id: "decompose", type: "stage", agent_role: "decomposer", actionId: "triage-new-issues" },
    { id: "write-tests", type: "fan_out", agent_role: "test-writer", actionId: "plan-tasks" },
    { id: "implement", type: "fan_out", agent_role: "implementer", actionId: "plan-tasks" },
    { id: "validate", type: "fan_in" },
    { id: "review", type: "fan_out", agent_role: "reviewer", actionId: "plan-tasks" },
    { id: "merge-gate", type: "fan_in" },
  ],
  edges: [
    { id: "e1", from: "spec-review", to: "decompose", sourceHandle: "approved" },
    { id: "e2", from: "decompose", to: "write-tests" },
    { id: "e3", from: "write-tests", to: "implement" },
    { id: "e4", from: "implement", to: "validate" },
    { id: "e5", from: "validate", to: "review" },
    { id: "e6", from: "validate", to: "implement", type: "error" },
    { id: "e7", from: "review", to: "merge-gate" },
  ],
  positions: {},
};

const BUG_JSON: PipelineDefinition = {
  name: "bug",
  description: "Bug fix pipeline",
  trigger: { label: "pipeline:bug" },
  stages: [
    { id: "write-tests", type: "stage", agent_role: "test-writer", actionId: "triage-new-issues" },
    { id: "implement", type: "stage", agent_role: "implementer", actionId: "triage-new-issues" },
    { id: "validate", type: "stage", agent_role: "validator", actionId: "triage-new-issues" },
    { id: "review", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
  ],
  edges: [
    { id: "e1", from: "write-tests", to: "implement" },
    { id: "e2", from: "implement", to: "validate" },
    { id: "e3", from: "validate", to: "review", sourceHandle: "pass" },
    { id: "e4", from: "validate", to: "implement", type: "error" },
  ],
  positions: {},
};

const FAST_TRACK_JSON: PipelineDefinition = {
  name: "fast-track",
  description: "Fast-track pipeline for trivial changes",
  trigger: { label: "pipeline:fast-track" },
  stages: [
    { id: "implement", type: "stage", agent_role: "implementer", actionId: "triage-new-issues" },
    { id: "validate", type: "stage", agent_role: "validator", actionId: "triage-new-issues" },
  ],
  edges: [
    { id: "e1", from: "implement", to: "validate" },
  ],
  positions: {},
};

function loadPipelineJson(name: string): string {
  const map: Record<string, PipelineDefinition> = { feature: FEATURE_JSON, bug: BUG_JSON, "fast-track": FAST_TRACK_JSON };
  return JSON.stringify(map[name]!);
}

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

describe("IDP pipeline compatibility", () => {
  describe("parsing and DAG validation", () => {
    it("parses feature pipeline", () => {
      const pipeline = parsePipeline(loadPipelineJson("feature"));
      expect(pipeline.name).toBe("feature");
      expect(pipeline.trigger.label).toBe("pipeline:feature");
      expect(pipeline.stages).toHaveLength(7);
    });

    it("validates feature pipeline DAG", () => {
      const pipeline = parsePipeline(loadPipelineJson("feature"));
      const result = validateDAG(pipeline);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("parses bug pipeline", () => {
      const pipeline = parsePipeline(loadPipelineJson("bug"));
      expect(pipeline.name).toBe("bug");
      expect(pipeline.stages).toHaveLength(4);
    });

    it("validates bug pipeline DAG", () => {
      const pipeline = parsePipeline(loadPipelineJson("bug"));
      expect(validateDAG(pipeline).valid).toBe(true);
    });

    it("parses fast-track pipeline", () => {
      const pipeline = parsePipeline(loadPipelineJson("fast-track"));
      expect(pipeline.name).toBe("fast-track");
      expect(pipeline.stages).toHaveLength(2);
    });

    it("validates fast-track pipeline DAG", () => {
      const pipeline = parsePipeline(loadPipelineJson("fast-track"));
      expect(validateDAG(pipeline).valid).toBe(true);
    });
  });

  describe("router handles fan_out stages", () => {
    it("marks fan_out as requiring agent dispatch", () => {
      const router = new Router();
      expect(router.requiresAgentDispatch({ id: "review", type: "fan_out", agent_role: "reviewer", actionId: "plan-tasks" })).toBe(true);
    });

    it("includes fan_out in ready stages when deps met", async () => {
      const pipeline = FEATURE_JSON;
      const router = new Router();

      const stages = pipeline.stages.map((s) => {
        if (s.id === "review") return makeStage(s.id, "pending");
        return makeStage(s.id, "completed", {});
      });

      const ready = await router.getReadyStages(pipeline, stages);
      expect(ready.map((s) => s.id)).toContain("review");
    });
  });

  describe("router blocks downstream when source not completed", () => {
    it("blocks downstream when source is still running", async () => {
      const pipeline = FEATURE_JSON;
      const router = new Router();

      const stages = [
        makeStage("spec-review", "completed", { decision: "approved" }),
        makeStage("decompose", "running"),
        makeStage("write-tests", "pending"),
      ];
      const ready = await router.getReadyStages(pipeline, stages);
      expect(ready.map((s) => s.id)).not.toContain("write-tests");
    });

    it("allows downstream after source completed", async () => {
      const pipeline = FEATURE_JSON;
      const router = new Router();

      const stages = [
        makeStage("spec-review", "completed", { decision: "approved" }),
        makeStage("decompose", "completed", { tasks: ["t1", "t2"] }),
        makeStage("write-tests", "pending"),
      ];
      const ready = await router.getReadyStages(pipeline, stages);
      expect(ready.map((s) => s.id)).toContain("write-tests");
    });
  });

  describe("router handles fast-track pipeline end-to-end", () => {
    it("advances through fast-track correctly", async () => {
      const pipeline = FAST_TRACK_JSON;
      const router = new Router();

      const initial = pipeline.stages.map((s) => makeStage(s.id, "pending"));
      const ready1 = await router.getReadyStages(pipeline, initial);
      expect(ready1.map((s) => s.id)).toEqual(["implement"]);

      const afterImpl = [
        makeStage("implement", "completed", { status: "done" }),
        makeStage("validate", "pending"),
      ];
      const ready2 = await router.getReadyStages(pipeline, afterImpl);
      expect(ready2.map((s) => s.id)).toEqual(["validate"]);
    });
  });
});
