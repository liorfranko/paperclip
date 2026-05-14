import { describe, it, expect, vi } from "vitest";
import { parsePipeline, validateDAG } from "../../engine/dag-parser.js";
import { Dispatcher } from "../../engine/dispatcher.js";
import { extractOutput } from "../../shared/output-parser.js";
import { Router } from "../../engine/router.js";
import { TriggerMatcher } from "../../triggers/trigger-matcher.js";
import type { PipelineStage } from "../../types.js";

const FEATURE_JSON = JSON.stringify({
  name: "feature",
  description: "Full feature development",
  trigger: { label: "pipeline:feature" },
  stages: [
    { id: "spec-review", type: "stage", agent_role: "spec-reviewer", actionId: "validate-spec" },
    { id: "implement", type: "stage", agent_role: "code-writer", actionId: "triage-new-issues" },
    { id: "validate", type: "stage", agent_role: "validator", actionId: "triage-new-issues" },
  ],
  edges: [
    { id: "e1", from: "spec-review", to: "implement", sourceHandle: "approved" },
    { id: "e2", from: "implement", to: "validate" },
    { id: "e3", from: "validate", to: "implement", type: "error" },
  ],
  positions: {},
});

function createMockIssues() {
  let issueCounter = 0;
  return {
    create: vi.fn().mockImplementation(async () => ({ id: `issue-${++issueCounter}` })),
    requestWakeup: vi.fn().mockResolvedValue({ queued: true }),
    documents: { upsert: vi.fn().mockResolvedValue(undefined) },
  };
}

describe("integration: end-to-end pipeline flow", () => {
  it("triggers pipeline, dispatches stages, processes output, and advances", async () => {
    const pipeline = parsePipeline(FEATURE_JSON);
    const validation = validateDAG(pipeline);
    expect(validation.valid).toBe(true);

    const matcher = new TriggerMatcher([pipeline]);
    const matched = matcher.match(["pipeline:feature", "priority:high"]);
    expect(matched).not.toBeNull();
    expect(matched!.name).toBe("feature");

    const router = new Router();
    const initialStages: PipelineStage[] = [
      { id: "row-1", pipelineRunId: "run-1", stageId: "spec-review", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "row-2", pipelineRunId: "run-1", stageId: "implement", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "row-3", pipelineRunId: "run-1", stageId: "validate", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
    ];

    // Root stage (spec-review) is ready immediately
    const ready = await router.getReadyStages(pipeline, initialStages);
    expect(ready).toHaveLength(1);
    expect(ready[0].id).toBe("spec-review");

    const issues = createMockIssues();
    const dispatcher = new Dispatcher(
      issues as any,
      { "spec-reviewer": "agent-1", "code-writer": "agent-2", "validator": "agent-3" },
      "paperclipai.pipeline-engine",
    );
    const dispatchResult = await dispatcher.dispatch({
      pipelineRunId: "run-1",
      stage: ready[0],
      companyId: "company-1",
      parentIssueId: "parent-1",
    });
    expect(dispatchResult.issueId).toBe("issue-1");

    // Simulate spec-review output extraction
    const commentBody = `Done reviewing.\n\n<!-- pipeline-output -->\n\`\`\`json\n{"decision": "approved", "completeness_score": 0.95}\n\`\`\``;
    const extraction = extractOutput(commentBody);
    expect(extraction.found).toBe(true);
    expect(extraction.data).not.toBeNull();
    expect(extraction.data!.decision).toBe("approved");

    // After spec-review completes with decision: "approved", implement should be ready
    const afterSpecReview: PipelineStage[] = [
      { ...initialStages[0], status: "completed", output: { decision: "approved", completeness_score: 0.95 } },
      { ...initialStages[1] },
      { ...initialStages[2] },
    ];
    const nextReady = await router.getReadyStages(pipeline, afterSpecReview);
    expect(nextReady).toHaveLength(1);
    expect(nextReady[0].id).toBe("implement");

    // When spec-review decision is "rejected", implement should be skipped
    const afterRejected: PipelineStage[] = [
      { ...initialStages[0], status: "completed", output: { decision: "rejected", completeness_score: 0.4 } },
      { ...initialStages[1] },
      { ...initialStages[2] },
    ];
    const skipped = await router.getSkippedStages(pipeline, afterRejected);
    expect(skipped.map((s) => s.id)).toContain("implement");

    // Failure routing via error edges — goto when error edge exists
    const failedValidateStage: PipelineStage = { ...initialStages[2], status: "failed", output: { errors: ["test_a failed"] }, retryCount: 0 };
    const failureAction = router.evaluateFailure(pipeline, "validate");
    expect(failureAction.action).toBe("goto");
    if (failureAction.action === "goto") {
      expect(failureAction.targetStageId).toBe("implement");
    }

    // Escalate when no error edge exists
    const specFailure = router.evaluateFailure(pipeline, "spec-review");
    expect(specFailure.action).toBe("escalate");
  });

  it("spec-review conditional edge: stage ready when approved, skipped when rejected", async () => {
    const pipeline = parsePipeline(FEATURE_JSON);
    const router = new Router();

    const stagesApproved: PipelineStage[] = [
      { id: "r1", pipelineRunId: "run-2", stageId: "spec-review", subIssueId: null, status: "completed", retryCount: 0, output: { decision: "approved", completeness_score: 0.9 }, error: null, startedAt: null, completedAt: null },
      { id: "r2", pipelineRunId: "run-2", stageId: "implement", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
      { id: "r3", pipelineRunId: "run-2", stageId: "validate", subIssueId: null, status: "pending", retryCount: 0, output: null, error: null, startedAt: null, completedAt: null },
    ];
    const readyApproved = await router.getReadyStages(pipeline, stagesApproved);
    expect(readyApproved.map((s) => s.id)).toContain("implement");

    const stagesRejected: PipelineStage[] = [
      { ...stagesApproved[0], output: { decision: "rejected", completeness_score: 0.3 } },
      { ...stagesApproved[1] },
      { ...stagesApproved[2] },
    ];
    const readyRejected = await router.getReadyStages(pipeline, stagesRejected);
    expect(readyRejected.map((s) => s.id)).not.toContain("implement");

    const skipped = await router.getSkippedStages(pipeline, stagesRejected);
    expect(skipped.map((s) => s.id)).toContain("implement");
  });
});
