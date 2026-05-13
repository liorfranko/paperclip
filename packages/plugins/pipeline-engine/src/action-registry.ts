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
    instructions:
      "Classify this issue into exactly one track:\n" +
      "- **feature**: new user-facing capability requiring spec, tests, implementation, review, and validation\n" +
      "- **bug**: broken existing behavior with a clear reproduction path\n" +
      "- **fast-track**: trivial change (typo, config tweak, dependency bump) that needs no spec or review\n\n" +
      "Read the issue title, description, and labels. If unclear, default to 'feature' — it's safer to over-process than to skip gates.",
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
    instructions:
      "Verify that a holdout scenario exists for this feature issue.\n\n" +
      "1. Look in `.paperclip/scenarios/` for a YAML file matching the scenario name referenced in the issue description (or list available files and match by relevance).\n" +
      "2. Validate structure: the file must contain `steps` (ordered list of user actions) and `satisfaction_criteria` (measurable pass/fail conditions).\n" +
      "3. Output 'yes' if a valid scenario exists, 'no' if missing or malformed.\n\n" +
      "Do NOT create or modify scenario files — they are managed by humans.",
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
    instructions:
      "Review the design spec referenced in the issue for implementation-readiness.\n\n" +
      "A spec is ready ('yes') when it covers:\n" +
      "- **Architecture**: which modules/files are affected and how they interact\n" +
      "- **Data flow**: inputs, transformations, outputs, and persistence\n" +
      "- **Error handling**: failure modes and recovery strategies\n" +
      "- **Testing strategy**: what to test and at which layer\n" +
      "- **Definition of Done**: checkable acceptance criteria\n\n" +
      "Output 'no' if any of these are missing or too vague to implement without guessing.",
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
    instructions:
      "Determine which services need implementation based on the spec.\n\n" +
      "- Select 'backend' if the spec requires API endpoints, database changes, or server-side logic\n" +
      "- Select 'frontend' if the spec requires UI components, pages, or client-side behavior\n" +
      "- Select both if both layers are affected\n\n" +
      "Choose ordering:\n" +
      "- 'parallel' — tasks are independent (e.g., backend API + unrelated frontend page)\n" +
      "- 'sequential' — frontend depends on backend (e.g., UI consumes a new API endpoint)\n\n" +
      "Keep tasks small enough for a single agent run (< 600 LOC change per track).",
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
    instructions:
      "Read all code review findings from upstream review stages.\n\n" +
      "A finding is **critical** (blocking) if it involves:\n" +
      "- Security vulnerabilities (injection, auth bypass, data exposure)\n" +
      "- Data loss or corruption risks\n" +
      "- Correctness bugs that would break user-facing behavior\n\n" +
      "Non-critical findings (style, naming, minor refactoring) do NOT block.\n\n" +
      "Output:\n" +
      "- 'no-findings' — no critical issues, safe to proceed\n" +
      "- 'yes-backend' — critical findings in backend code need fixing\n" +
      "- 'yes-frontend' — critical findings in frontend code need fixing",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["no-findings", "yes-backend", "yes-frontend"] },
      },
    },
  },
  {
    id: "validate-scenario-result",
    name: "Validate Scenario Result",
    type: "single-decision",
    instructions:
      "Run the holdout scenario against the implementation.\n\n" +
      "1. Start the full application stack\n" +
      "2. Execute each scenario step against the running app\n" +
      "3. Evaluate satisfaction_criteria — each criterion scores 0 or 1\n" +
      "4. Calculate overall score = passed_criteria / total_criteria\n\n" +
      "Output 'valid' if score >= 0.8, 'not-valid' if below.\n\n" +
      "You MUST actually run the app and interact with it. Self-scoring by reading code is prohibited. " +
      "Take screenshots as evidence for each step.",
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
    instructions:
      "Write tests BEFORE implementation (TDD).\n\n" +
      "1. Read the spec and Definition of Done to understand expected behavior\n" +
      "2. Write tests that cover: happy path, edge cases, error conditions\n" +
      "3. Run the tests — they MUST fail (red phase). If they pass, you're testing existing behavior, not the new feature\n" +
      "4. Commit the failing tests\n\n" +
      "Use the project's test framework and conventions. Tests should be specific enough to catch regressions but not so brittle that refactoring breaks them.",
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
    instructions:
      "Implement the feature or fix to make all tests pass (green phase).\n\n" +
      "1. Read the spec and the failing tests to understand the contract\n" +
      "2. Write the minimal code that makes tests pass — no speculative features\n" +
      "3. Follow existing code conventions, patterns, and module boundaries\n" +
      "4. Run the full test suite + lint + typecheck to confirm nothing is broken\n\n" +
      "Do NOT modify existing tests to make them pass. If a test is wrong, that's a spec issue — escalate, don't fix.",
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
    instructions:
      "Clean up AI slop from the implementation without changing behavior.\n\n" +
      "Remove:\n" +
      "- Unnecessary comments (especially obvious ones like '// loop through items')\n" +
      "- Dead code, unused imports, unreachable branches\n" +
      "- Over-engineered abstractions (premature generalization, unnecessary wrappers)\n" +
      "- Verbose variable names that add no clarity\n" +
      "- Debug artifacts (console.log, print statements, TODO comments)\n\n" +
      "After cleanup, run the full test suite to confirm nothing broke. Do NOT refactor across module boundaries.",
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
    instructions:
      "Create a pull request for the implementation.\n\n" +
      "1. Ensure branch is rebased on latest main with no conflicts\n" +
      "2. Write a concise PR title (< 70 chars, imperative mood)\n" +
      "3. PR body must include: summary of changes, test plan, and reference to the parent issue\n" +
      "4. If this is a feature track, link the design spec path\n\n" +
      "Do NOT merge — just open the PR and output 'done'.",
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
    instructions:
      "Review the PR diff for your assigned dimension.\n\n" +
      "Dimensions:\n" +
      "- **clean-code**: naming, structure, readability, no shallow wrappers or 'utils' files\n" +
      "- **typed-code**: type safety, no unsafe casts, no `any` without justification, no `# type: ignore` without explanation\n" +
      "- **simplify**: unnecessary complexity, dead code, over-abstraction, premature generalization\n\n" +
      "Report findings as: `{severity, file, line, message}`\n" +
      "Severities: critical (blocks merge), high (should fix), medium (consider), low (nitpick)\n\n" +
      "Only report findings you're confident about. Do NOT nitpick style that matches repo conventions.",
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
    instructions:
      "Before merging, run `gh pr checks` and verify EVERY check has status 'pass'. " +
      "If ANY check is pending or failing, you MUST NOT merge. " +
      "Output 'ci-blocked' and stop — a human will handle it. " +
      "Only output 'done' after confirming all CI checks are green AND merging successfully.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["done", "ci-blocked"] },
      },
    },
  },
  {
    id: "escalate-to-human",
    name: "Escalate to Human",
    type: "single-decision",
    instructions:
      "Escalate this issue to a human operator.\n\n" +
      "Post a comment summarizing:\n" +
      "- What was attempted and what failed\n" +
      "- Why automated resolution isn't possible (e.g., ambiguous spec, infra issue, auth problem)\n" +
      "- What specific decision or action is needed from a human\n\n" +
      "Then output 'escalated'.",
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

