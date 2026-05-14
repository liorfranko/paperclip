import { describe, it, expect } from "vitest";
import { Router } from "../../engine/router.js";
import type { PipelineDefinition } from "../../types.js";

const fixedFanoutPipeline: PipelineDefinition = {
  name: "fixed-fanout",
  description: "",
  trigger: { label: "pipeline:fixed" },
  stages: [
    { id: "open-pr", type: "fan_in" },
    { id: "dispatch", type: "fan_out", actionId: "dispatch-code-reviews", agent_role: "dispatcher" },
    { id: "review-quality", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
    { id: "review-errors", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
    { id: "review-tests", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
    { id: "review-comments", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
    { id: "review-types", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
    { id: "review-arch", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
    { id: "review-blind", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
  ],
  edges: [
    { id: "e1", from: "open-pr", to: "dispatch" },
    { id: "e2", from: "dispatch", to: "review-quality", activationKey: "code-quality" },
    { id: "e3", from: "dispatch", to: "review-errors", activationKey: "error-handling" },
    { id: "e4", from: "dispatch", to: "review-tests", activationKey: "test-coverage" },
    { id: "e5", from: "dispatch", to: "review-comments", activationKey: "comment-quality" },
    { id: "e6", from: "dispatch", to: "review-types", activationKey: "type-design" },
    { id: "e7", from: "dispatch", to: "review-arch", activationKey: "architecture" },
    { id: "e8", from: "dispatch", to: "review-blind", activationKey: "blind-validation" },
  ],
  positions: {},
};

describe("fixed fan-out (deterministic)", () => {
  const router = new Router();

  it("requiresAgentDispatch returns false for fixed fan-out", () => {
    const stage = fixedFanoutPipeline.stages.find((s) => s.id === "dispatch")!;
    expect(router.requiresAgentDispatch(stage)).toBe(false);
  });

  it("getFixedFanoutOutput returns all tracks for fixed action", () => {
    const stage = fixedFanoutPipeline.stages.find((s) => s.id === "dispatch")!;
    const output = router.getFixedFanoutOutput(stage);
    expect(output).toEqual({ tracks: ["code-quality", "error-handling", "test-coverage", "comment-quality", "type-design", "architecture", "blind-validation"], ordering: "parallel" });
  });

  it("getFixedFanoutOutput returns null for non-fixed stage", () => {
    const stage = fixedFanoutPipeline.stages.find((s) => s.id === "review-quality")!;
    const output = router.getFixedFanoutOutput(stage);
    expect(output).toBeNull();
  });

  it("getFixedFanoutOutput returns null for fan_out with unknown actionId", () => {
    const stage = { id: "unknown", type: "fan_out" as const, actionId: "nonexistent" };
    const output = router.getFixedFanoutOutput(stage);
    expect(output).toBeNull();
  });

  it("getFixedFanoutOutput returns null for fan_out with non-fixed action", () => {
    const stage = { id: "dynamic", type: "fan_out" as const, actionId: "plan-tasks", agent_role: "planner" };
    const output = router.getFixedFanoutOutput(stage);
    expect(output).toBeNull();
  });
});
