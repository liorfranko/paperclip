import { describe, it, expect } from "vitest";
import { Router } from "../router.js";
import { validateDAG } from "../dag-parser.js";
import { StateMachine } from "../state-machine.js";
import type { PipelineDefinition, PipelineStage, StageStatus } from "../types.js";

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

const loopPipeline: PipelineDefinition = {
  name: "loop-test",
  description: "",
  trigger: { label: "pipeline:loop" },
  stages: [
    { id: "write-tests", type: "stage", agent_role: "test-writer", actionId: "triage-new-issues" },
    { id: "review", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
    { id: "escalate", type: "stage", agent_role: "lead", actionId: "triage-new-issues" },
  ],
  edges: [
    { id: "e1", from: "write-tests", to: "review" },
    { id: "e-loop", from: "review", to: "write-tests", type: "loop", max_iterations: 3 },
    { id: "e2", from: "review", to: "escalate", sourceHandle: "pass" },
  ],
  positions: {},
};

describe("loop edges", () => {
  const router = new Router();

  describe("DAG validation", () => {
    it("allows loop edges without triggering cycle detection", () => {
      const result = validateDAG(loopPipeline);
      expect(result.valid).toBe(true);
    });

    it("rejects loop edges with max_iterations <= 0", () => {
      const badPipeline: PipelineDefinition = {
        ...loopPipeline,
        edges: [
          ...loopPipeline.edges.filter((e) => e.id !== "e-loop"),
          { id: "e-loop", from: "review", to: "write-tests", type: "loop", max_iterations: 0 },
        ],
      };
      const result = validateDAG(badPipeline);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain("max_iterations");
    });

    it("rejects loop edges with no max_iterations", () => {
      const badPipeline: PipelineDefinition = {
        ...loopPipeline,
        edges: [
          ...loopPipeline.edges.filter((e) => e.id !== "e-loop"),
          { id: "e-loop", from: "review", to: "write-tests", type: "loop" },
        ],
      };
      const result = validateDAG(badPipeline);
      expect(result.valid).toBe(false);
    });
  });

  describe("router with loop edges", () => {
    it("loop edge makes target ready when source completed and iterations remain", async () => {
      const stages = [
        makeStage("write-tests", "pending"),
        makeStage("review", "completed", { decision: "fail" }),
        makeStage("escalate", "pending"),
      ];
      const ready = await router.getReadyStages(loopPipeline, stages, { "e-loop": 0 });
      expect(ready.map((s) => s.id)).toContain("write-tests");
    });

    it("loop edge does NOT make target ready when max_iterations exhausted", async () => {
      const stages = [
        makeStage("write-tests", "pending"),
        makeStage("review", "completed", { decision: "fail" }),
        makeStage("escalate", "pending"),
      ];
      const ready = await router.getReadyStages(loopPipeline, stages, { "e-loop": 3 });
      expect(ready.map((s) => s.id)).not.toContain("write-tests");
    });

    it("getLoopEdgesForReadyStage identifies firing loop edges", () => {
      const stages = [
        makeStage("write-tests", "pending"),
        makeStage("review", "completed", { decision: "fail" }),
      ];
      const loopEdges = router.getLoopEdgesForReadyStage(
        "write-tests", loopPipeline, stages, { "e-loop": 1 },
      );
      expect(loopEdges).toHaveLength(1);
      expect(loopEdges[0].id).toBe("e-loop");
    });

    it("getLoopEdgesForReadyStage returns empty when exhausted", () => {
      const stages = [
        makeStage("write-tests", "pending"),
        makeStage("review", "completed", { decision: "fail" }),
      ];
      const loopEdges = router.getLoopEdgesForReadyStage(
        "write-tests", loopPipeline, stages, { "e-loop": 3 },
      );
      expect(loopEdges).toHaveLength(0);
    });
  });

  describe("state machine loop edge counts", () => {
    function createMockDb() {
      const store = new Map<string, Record<string, number>>();
      return {
        namespace: "test",
        query: async (_sql: string, params?: unknown[]) => {
          const runId = params?.[0] as string;
          return [{ loop_edge_counts: store.get(runId) ?? null }];
        },
        execute: async (_sql: string, params?: unknown[]) => {
          if (typeof params?.[0] === "string" && (params[0] as string).startsWith("{")) {
            const counts = JSON.parse(params[0] as string);
            const runId = params[1] as string;
            store.set(runId, counts);
          }
          return { rowCount: 1 };
        },
      };
    }

    it("tracks loop edge counts per run", async () => {
      const sm = new StateMachine(createMockDb() as any);
      expect(await sm.getLoopEdgeCounts("run-1")).toEqual({});
      await sm.incrementLoopEdgeCount("run-1", "e-loop");
      expect(await sm.getLoopEdgeCounts("run-1")).toEqual({ "e-loop": 1 });
      await sm.incrementLoopEdgeCount("run-1", "e-loop");
      expect(await sm.getLoopEdgeCounts("run-1")).toEqual({ "e-loop": 2 });
    });

    it("keeps counts isolated between runs", async () => {
      const sm = new StateMachine(createMockDb() as any);
      await sm.incrementLoopEdgeCount("run-a", "e1");
      await sm.incrementLoopEdgeCount("run-b", "e1");
      await sm.incrementLoopEdgeCount("run-b", "e1");
      expect(await sm.getLoopEdgeCounts("run-a")).toEqual({ "e1": 1 });
      expect(await sm.getLoopEdgeCounts("run-b")).toEqual({ "e1": 2 });
    });
  });
});
