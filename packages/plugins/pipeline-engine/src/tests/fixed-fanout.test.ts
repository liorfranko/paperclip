import { describe, it, expect } from "vitest";
import { Router } from "../router.js";
import type { PipelineDefinition } from "../types.js";

const fixedFanoutPipeline: PipelineDefinition = {
  name: "fixed-fanout",
  description: "",
  trigger: { label: "pipeline:fixed" },
  stages: [
    { id: "open-pr", type: "fan_in" },
    { id: "dispatch", type: "fan_out", actionId: "dispatch-code-reviews", agent_role: "dispatcher" },
    { id: "review-clean", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
    { id: "review-typed", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
    { id: "review-simplify", type: "stage", agent_role: "reviewer", actionId: "triage-new-issues" },
  ],
  edges: [
    { id: "e1", from: "open-pr", to: "dispatch" },
    { id: "e2", from: "dispatch", to: "review-clean", activationKey: "clean-code" },
    { id: "e3", from: "dispatch", to: "review-typed", activationKey: "typed-code" },
    { id: "e4", from: "dispatch", to: "review-simplify", activationKey: "simplify" },
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
    expect(output).toEqual({ tracks: ["clean-code", "typed-code", "simplify"], ordering: "parallel" });
  });

  it("getFixedFanoutOutput returns null for non-fixed stage", () => {
    const stage = fixedFanoutPipeline.stages.find((s) => s.id === "review-clean")!;
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
