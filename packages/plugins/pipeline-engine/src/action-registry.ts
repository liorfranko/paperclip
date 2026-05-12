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
