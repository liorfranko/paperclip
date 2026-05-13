import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface StageDefinition {
  id: string;
  type: string;
  agent_role?: string;
  actionId?: string;
  reason?: string;
}

interface EdgeDefinition {
  id: string;
  from: string;
  to: string;
  type?: string;
  sourceHandle?: string;
  activationKey?: string;
  max_iterations?: number;
  label?: string;
}

interface PipelineDefinition {
  name: string;
  stages: StageDefinition[];
  edges: EdgeDefinition[];
  positions: Record<string, { x: number; y: number }>;
}

const pipeline: PipelineDefinition = JSON.parse(
  readFileSync(join(__dirname, "../pipelines/autonomous-dev.json"), "utf-8"),
);

describe("autonomous-dev pipeline - review system", () => {
  const stageIds = new Set(pipeline.stages.map((s) => s.id));

  it("has exactly 7 reviewer stages", () => {
    const reviewers = pipeline.stages.filter(
      (s) => s.id.startsWith("review-") && s.type === "stage",
    );
    expect(reviewers).toHaveLength(7);
  });

  it("all reviewer stages reference a valid actionId", () => {
    const reviewers = pipeline.stages.filter(
      (s) => s.id.startsWith("review-") && s.type === "stage",
    );
    for (const r of reviewers) {
      expect(r.actionId, `${r.id} missing actionId`).toBeTruthy();
      expect(r.actionId!.startsWith("review-"), `${r.id} actionId should start with review-`).toBe(true);
    }
  });

  it("all reviewer stages have unique actionIds", () => {
    const reviewers = pipeline.stages.filter(
      (s) => s.id.startsWith("review-") && s.type === "stage",
    );
    const actionIds = reviewers.map((r) => r.actionId);
    expect(new Set(actionIds).size).toBe(7);
  });

  it("dispatch-reviews fans out to all 7 reviewers", () => {
    const fanOutEdges = pipeline.edges.filter(
      (e) => e.from === "dispatch-reviews",
    );
    expect(fanOutEdges).toHaveLength(7);
    const targets = new Set(fanOutEdges.map((e) => e.to));
    expect(targets).toContain("review-code-quality");
    expect(targets).toContain("review-error-handling");
    expect(targets).toContain("review-test-coverage");
    expect(targets).toContain("review-comments");
    expect(targets).toContain("review-type-design");
    expect(targets).toContain("review-architecture");
    expect(targets).toContain("review-blind-validation");
  });

  it("all 7 reviewers converge at review-sync fan_in", () => {
    const syncEdges = pipeline.edges.filter((e) => e.to === "review-sync");
    expect(syncEdges).toHaveLength(7);
    const sources = new Set(syncEdges.map((e) => e.from));
    expect(sources).toContain("review-code-quality");
    expect(sources).toContain("review-error-handling");
    expect(sources).toContain("review-test-coverage");
    expect(sources).toContain("review-comments");
    expect(sources).toContain("review-type-design");
    expect(sources).toContain("review-architecture");
    expect(sources).toContain("review-blind-validation");
  });

  it("review-sync leads to evaluate-findings", () => {
    const edge = pipeline.edges.find(
      (e) => e.from === "review-sync" && e.to === "evaluate-findings",
    );
    expect(edge).toBeDefined();
  });

  it("evaluate-findings has pass path to simplify-code", () => {
    const edge = pipeline.edges.find(
      (e) =>
        e.from === "evaluate-findings" &&
        e.to === "simplify-code" &&
        e.sourceHandle === "pass",
    );
    expect(edge).toBeDefined();
  });

  it("evaluate-findings has loop-back to write-backend-impl on fail", () => {
    const edge = pipeline.edges.find(
      (e) =>
        e.from === "evaluate-findings" &&
        e.to === "write-backend-impl" &&
        e.sourceHandle === "fail-impl",
    );
    expect(edge).toBeDefined();
    expect(edge!.type).toBe("loop");
    expect(edge!.max_iterations).toBe(3);
  });

  it("simplify-code stage exists with correct actionId", () => {
    const stage = pipeline.stages.find((s) => s.id === "simplify-code");
    expect(stage).toBeDefined();
    expect(stage!.actionId).toBe("simplify-code");
  });

  it("simplify-code leads to scenario-validator", () => {
    const edge = pipeline.edges.find(
      (e) => e.from === "simplify-code" && e.to === "scenario-validator",
    );
    expect(edge).toBeDefined();
  });

  it("all edges reference valid stages", () => {
    for (const edge of pipeline.edges) {
      expect(stageIds.has(edge.from), `edge ${edge.id}: from=${edge.from} not in stages`).toBe(true);
      expect(stageIds.has(edge.to), `edge ${edge.id}: to=${edge.to} not in stages`).toBe(true);
    }
  });

  it("all stages have positions", () => {
    for (const stage of pipeline.stages) {
      expect(pipeline.positions[stage.id], `${stage.id} missing position`).toBeDefined();
    }
  });

  it("no orphan positions (position without stage)", () => {
    for (const posId of Object.keys(pipeline.positions)) {
      expect(stageIds.has(posId), `position ${posId} has no stage`).toBe(true);
    }
  });
});

describe("autonomous-dev pipeline - activation keys match dispatch-code-reviews schema", () => {
  it("fan_out activation keys match the dispatch-code-reviews tracks enum", () => {
    const expectedKeys = [
      "code-quality",
      "error-handling",
      "test-coverage",
      "comment-quality",
      "type-design",
      "architecture",
      "blind-validation",
    ];
    const fanOutEdges = pipeline.edges.filter(
      (e) => e.from === "dispatch-reviews" && e.activationKey,
    );
    const actualKeys = fanOutEdges.map((e) => e.activationKey).sort();
    expect(actualKeys).toEqual(expectedKeys.sort());
  });
});
