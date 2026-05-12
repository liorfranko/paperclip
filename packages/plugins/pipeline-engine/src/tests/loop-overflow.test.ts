import { describe, it, expect } from "vitest";
import { Router } from "../router.js";
import type { PipelineDefinition } from "../types.js";

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
    const loopEdgeCounts = { "e-loop": 2 };
    const action = router.evaluateLoopOverflow(overflowPipeline, "review", loopEdgeCounts);
    expect(action).toEqual({ action: "goto", targetStageId: "escalate" });
  });

  it("returns null when loop is not overflowed", () => {
    const loopEdgeCounts = { "e-loop": 1 };
    const action = router.evaluateLoopOverflow(overflowPipeline, "review", loopEdgeCounts);
    expect(action).toBeNull();
  });

  it("returns null when no loop edges exist from stage", () => {
    const action = router.evaluateLoopOverflow(overflowPipeline, "fix", {});
    expect(action).toBeNull();
  });

  it("returns escalate when loop overflows but no error edge exists", () => {
    const noErrorPipeline: PipelineDefinition = {
      name: "no-error-overflow",
      description: "",
      trigger: { label: "pipeline:noerror" },
      stages: [
        { id: "check", type: "stage", agent_role: "reviewer", actionId: "evaluate-critical-findings" },
        { id: "retry", type: "stage", agent_role: "engineer", actionId: "triage-new-issues" },
      ],
      edges: [
        { id: "e-loop", from: "check", to: "retry", type: "loop", max_iterations: 1 },
        { id: "e-forward", from: "retry", to: "check" },
      ],
      positions: {},
    };
    const action = router.evaluateLoopOverflow(noErrorPipeline, "check", { "e-loop": 1 });
    expect(action).toEqual({ action: "escalate" });
  });
});
