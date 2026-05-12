import { describe, it, expect } from "vitest";
import { Router } from "../router.js";
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

const overflowPipeline: PipelineDefinition = {
  name: "overflow-test",
  description: "",
  trigger: { label: "pipeline:overflow" },
  stages: [
    { id: "review", type: "stage", agent_role: "reviewer", actionId: "evaluate-critical-findings" },
    { id: "fix", type: "stage", agent_role: "engineer", actionId: "triage-new-issues" },
    { id: "escalate", type: "stage", agent_role: "human", actionId: "triage-new-issues" },
  ],
  edges: [
    { id: "e-loop", from: "review", to: "fix", type: "loop", max_iterations: 2 },
    { id: "e-forward", from: "fix", to: "review" },
    { id: "e-error", from: "review", to: "escalate", type: "error" },
  ],
  positions: {},
};

describe("loop overflow routing", () => {
  const router = new Router();

  it("fires error edge when loop max_iterations exceeded", () => {
    const stageRow = makeStage("review", "completed", { decision: "yes-backend" });
    const loopEdgeCounts = { "e-loop": 2 };
    const action = router.evaluateLoopOverflow(overflowPipeline, "review", stageRow, loopEdgeCounts);
    expect(action).toEqual({ action: "goto", targetStageId: "escalate" });
  });

  it("returns null when loop is not overflowed", () => {
    const stageRow = makeStage("review", "completed", { decision: "yes-backend" });
    const loopEdgeCounts = { "e-loop": 1 };
    const action = router.evaluateLoopOverflow(overflowPipeline, "review", stageRow, loopEdgeCounts);
    expect(action).toBeNull();
  });

  it("returns null when no loop edges exist from stage", () => {
    const stageRow = makeStage("fix", "completed", {});
    const action = router.evaluateLoopOverflow(overflowPipeline, "fix", stageRow, {});
    expect(action).toBeNull();
  });
});
