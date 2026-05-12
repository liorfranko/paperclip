import type { JsonSchema } from "./schema-utils.js";

export type ActionType = "single-decision" | "multi-select";

export interface Action {
  id: string;
  name: string;
  type: ActionType;
  instructions: string;
  outputSchema: JsonSchema;
  fixed?: boolean;
}

export const ACTIONS: readonly Action[] = [
  {
    id: "triage-new-issues",
    name: "Triage New Issues",
    type: "single-decision",
    instructions: "Check the issue and classify it as a new feature, bug, or fast-track based on defined criteria. Evaluate the issue title, description, and any labels. Choose exactly one classification.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["feature", "bug", "fast-track"] },
      },
    },
  },
  {
    id: "validate-scenario",
    name: "Validate Scenario",
    type: "single-decision",
    instructions: "Verify that a valid holdout scenario exists for this issue. Check the scenarios directory for a matching YAML file. If found and well-formed, output 'yes'. If missing or invalid, output 'no'.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["yes", "no"] },
      },
    },
  },
  {
    id: "validate-spec",
    name: "Validate Spec",
    type: "single-decision",
    instructions: "Review the design spec for completeness and feasibility. Check that it covers architecture, data flow, error handling, and testing. If the spec is ready for implementation, output 'yes'. If it needs work, output 'no'.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["yes", "no"] },
      },
    },
  },
  {
    id: "plan-tasks",
    name: "Plan Tasks",
    type: "multi-select",
    instructions: "Based on the spec, determine which services need implementation. Select all applicable tracks. Choose ordering: 'parallel' if tasks are independent, 'sequential' if frontend depends on backend.",
    outputSchema: {
      type: "object",
      properties: {
        tracks: { type: "array", items: { enum: ["backend", "frontend"] } },
        ordering: { enum: ["parallel", "sequential"] },
      },
    },
  },
  {
    id: "evaluate-critical-findings",
    name: "Evaluate Critical Findings",
    type: "single-decision",
    instructions: "Review all code review findings. Determine if any findings are critical (security vulnerabilities, data loss risks, correctness bugs). If critical findings exist, decide which track needs fixing. If no critical findings, proceed.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["no-findings", "yes-backend", "yes-frontend", "max-retries"] },
      },
    },
  },
  {
    id: "validate-scenario-result",
    name: "Validate Scenario Result",
    type: "single-decision",
    instructions: "Run the holdout scenario validation. Check that the implementation passes with a score >= 0.8. Output 'valid' if passing, 'not-valid' if below threshold.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["valid", "not-valid"] },
      },
    },
  },
  {
    id: "dispatch-code-reviews",
    name: "Dispatch Code Reviews",
    type: "multi-select",
    fixed: true,
    instructions: "",
    outputSchema: {
      type: "object",
      properties: {
        tracks: { type: "array", items: { enum: ["clean-code", "typed-code", "simplify"] } },
      },
    },
  },
  {
    id: "write-tests",
    name: "Write Tests",
    type: "single-decision",
    instructions: "Write comprehensive tests for the implementation task. Follow TDD principles — write failing tests that cover the expected behavior, edge cases, and error paths. Output 'done' when tests are written.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["done"] },
      },
    },
  },
  {
    id: "write-implementation",
    name: "Write Implementation",
    type: "single-decision",
    instructions: "Implement the feature or fix according to the spec and make all tests pass. Follow existing code conventions and patterns. Output 'done' when implementation is complete and tests pass.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["done"] },
      },
    },
  },
  {
    id: "de-slop-verify",
    name: "De-slop Verify",
    type: "single-decision",
    instructions: "Review the implementation for AI slop — unnecessary comments, over-engineering, dead code, verbose abstractions, and deviations from project conventions. Clean up and verify quality. Output 'done' when verified.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["done"] },
      },
    },
  },
  {
    id: "open-pr",
    name: "Open PR",
    type: "single-decision",
    instructions: "Create a pull request with the implementation. Write a clear title and description summarizing the changes, test plan, and any relevant context. Output 'done' when PR is opened.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["done"] },
      },
    },
  },
  {
    id: "code-review",
    name: "Code Review",
    type: "single-decision",
    instructions: "Review the pull request code changes for the assigned dimension (clean code, type safety, or simplification). Report findings with severity levels. Output 'done' when review is complete.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["done"] },
      },
    },
  },
  {
    id: "merge-pr",
    name: "Merge PR",
    type: "single-decision",
    instructions: "Merge the pull request after all reviews and validations have passed. Ensure CI is green and no blocking comments remain. Output 'done' when merged.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["done"] },
      },
    },
  },
  {
    id: "escalate-to-human",
    name: "Escalate to Human",
    type: "single-decision",
    instructions: "Escalate this issue to a human operator. Provide a summary of why escalation is needed, what was attempted, and what decision is required.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["escalated"] },
      },
    },
  },
];

export function getActionsForType(type: ActionType): Action[] {
  return ACTIONS.filter((a) => a.type === type);
}

export function getActionById(id: string): Action | undefined {
  return ACTIONS.find((a) => a.id === id);
}

export function getActionByIdOrThrow(id: string): Action {
  const action = ACTIONS.find((a) => a.id === id);
  if (!action) {
    throw new Error(`ACTION_NOT_FOUND: action "${id}" does not exist in the predefined registry`);
  }
  return action;
}
