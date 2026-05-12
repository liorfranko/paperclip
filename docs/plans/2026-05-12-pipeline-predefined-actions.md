# Pipeline Predefined Actions Implementation Plan

> **For agentic workers:** REQUIRED: Use forge:subagent-driven-development (if subagents available) or forge:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-node inline instructions/output schema with a global action registry, add fixed fan-out and retry overflow routing.

**Architecture:** A new `action-registry.ts` module defines all actions. Node types reference actions by `actionId` instead of storing instructions/schema inline. The router gains two behaviors: skip LLM for fixed fan-out, and fire error edges on loop overflow.

**Tech Stack:** TypeScript, Vitest, React (UI components)

**Verification Criteria:**
- [ ] Action registry exports typed actions with schema validation
- [ ] Stage/FanOut nodes use `actionId` instead of inline `instructions`/`output_schema`
- [ ] Fan-In nodes have no `fan_in_strategy` — always `all_complete`
- [ ] Fixed fan-out skips LLM and activates all tracks
- [ ] Loop edge overflow fires error edge instead of halting
- [ ] Inspector UI shows action dropdown filtered by node type
- [ ] All existing tests updated and passing
- [ ] Exhaustive decision coverage validation uses action registry

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/action-registry.ts` (CREATE) | Action type definitions, action list, lookup helpers |
| `src/types.ts` (MODIFY) | Remove inline fields, add `actionId`, remove `FanInStrategy` |
| `src/router.ts` (MODIFY) | Remove `first_complete`, add loop overflow → error edge |
| `src/worker.ts` (MODIFY) | Look up action by ID for dispatch, skip LLM for fixed fan-out |
| `src/dispatcher.ts` (MODIFY) | Accept action instructions/schema instead of reading from stage |
| `src/schema-utils.ts` (MODIFY) | Add helper to get tracks values from action |
| `src/output-parser.ts` (MODIFY) | Load schema from action object instead of filesystem |
| `src/ui/components/StageInspector.tsx` (MODIFY) | Replace schema/instructions fields with action dropdown |
| `src/ui/components/StageNode.tsx` (MODIFY) | Derive handles from action registry lookup |
| `src/tests/action-registry.test.ts` (CREATE) | Registry validation tests |
| `src/tests/fixed-fanout.test.ts` (CREATE) | Fixed fan-out behavior tests |
| `src/tests/loop-overflow.test.ts` (CREATE) | Retry overflow routing tests |
| `src/tests/conditional-fanout.test.ts` (MODIFY) | Update to use actionId |
| `src/tests/router-edge-based.test.ts` (MODIFY) | Remove first_complete tests |
| `src/tests/integration.test.ts` (MODIFY) | Update pipeline definitions |
| `src/tests/loop-edges.test.ts` (MODIFY) | Add overflow scenarios |

---

## Chunk 1: Action Registry & Types

### Task 1: Create Action type definitions and registry

**Files:**
- Create: `src/action-registry.ts`
- Test: `src/tests/action-registry.test.ts`

- [ ] **Step 1: Write the failing test for action registry**

```typescript
// src/tests/action-registry.test.ts
import { describe, it, expect } from "vitest";
import { getActionsForType, getActionById, ACTIONS, type Action } from "../action-registry.js";

describe("action-registry", () => {
  it("all actions have unique ids", () => {
    const ids = ACTIONS.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("all non-fixed actions have non-empty instructions", () => {
    for (const action of ACTIONS) {
      if (action.fixed) continue;
      expect(action.instructions.length).toBeGreaterThan(0);
    }
  });

  it("single-decision actions have decision enum in schema", () => {
    const singleActions = getActionsForType("single-decision");
    for (const action of singleActions) {
      const decision = action.outputSchema.properties?.decision;
      expect(decision?.enum).toBeDefined();
      expect(decision!.enum!.length).toBeGreaterThan(0);
    }
  });

  it("multi-select actions have tracks and ordering in schema", () => {
    const multiActions = getActionsForType("multi-select");
    for (const action of multiActions) {
      const tracks = action.outputSchema.properties?.tracks;
      expect(tracks?.type).toBe("array");
      expect(tracks?.items?.enum).toBeDefined();
      const ordering = action.outputSchema.properties?.ordering;
      if (!action.fixed) {
        expect(ordering?.enum).toContain("parallel");
        expect(ordering?.enum).toContain("sequential");
      }
    }
  });

  it("getActionById returns action or undefined", () => {
    const first = ACTIONS[0];
    expect(getActionById(first.id)).toEqual(first);
    expect(getActionById("nonexistent")).toBeUndefined();
  });

  it("getActionsForType filters by type", () => {
    const single = getActionsForType("single-decision");
    expect(single.every((a) => a.type === "single-decision")).toBe(true);
    const multi = getActionsForType("multi-select");
    expect(multi.every((a) => a.type === "multi-select")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter pipeline-engine test -- src/tests/action-registry.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement action registry**

```typescript
// src/action-registry.ts
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

export const ACTIONS: Action[] = [
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
      required: ["tracks", "ordering"],
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter pipeline-engine test -- src/tests/action-registry.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/action-registry.ts src/tests/action-registry.test.ts
git commit -m "feat(pipeline-engine): add action registry with predefined actions"
```

---

### Task 2: Update type definitions

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Update Stage interface — replace instructions/output_schema with actionId**

Replace the `Stage` interface:

```typescript
export interface Stage extends BaseStage {
  type: "stage";
  agent_role: string;
  actionId: string;
}
```

- [ ] **Step 2: Update FanOutStage interface — replace instructions with actionId**

Replace the `FanOutStage` interface:

```typescript
export interface FanOutStage extends BaseStage {
  type: "fan_out";
  agent_role?: string;
  actionId: string;
}
```

- [ ] **Step 3: Simplify FanInStage — remove fan_in_strategy**

Replace:

```typescript
export interface FanInStage extends BaseStage {
  type: "fan_in";
}
```

- [ ] **Step 4: Remove FanInStrategy type**

Delete the line:
```typescript
export type FanInStrategy = "all_complete" | "first_complete" | "n_of_m";
```

- [ ] **Step 5: Commit**

```bash
git add src/types.ts
git commit -m "refactor(pipeline-engine): update types for action registry"
```

---

## Chunk 2: Router Changes

### Task 3: Remove first_complete from router, add loop overflow routing

**Files:**
- Modify: `src/router.ts`
- Test: `src/tests/loop-overflow.test.ts` (CREATE)

- [ ] **Step 1: Write failing test for loop overflow → error edge**

```typescript
// src/tests/loop-overflow.test.ts
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
    { id: "e-loop", from: "review", to: "fix", type: "loop", sourceHandle: "yes-backend", max_iterations: 2 },
    { id: "e-forward", from: "fix", to: "review" },
    { id: "e-error", from: "review", to: "escalate", type: "error" },
  ],
  positions: {},
};

describe("loop overflow routing", () => {
  const router = new Router();

  it("fires error edge when loop max_iterations exceeded", () => {
    const stageRow = makeStage("review", "completed", { decision: "yes-backend" });
    const loopEdgeCounts = { "e-loop": 2 }; // at max

    const action = router.evaluateLoopOverflow(overflowPipeline, "review", stageRow, loopEdgeCounts);
    expect(action).toEqual({ action: "goto", targetStageId: "escalate" });
  });

  it("returns null when loop is not overflowed", () => {
    const stageRow = makeStage("review", "completed", { decision: "yes-backend" });
    const loopEdgeCounts = { "e-loop": 1 }; // below max

    const action = router.evaluateLoopOverflow(overflowPipeline, "review", stageRow, loopEdgeCounts);
    expect(action).toBeNull();
  });

  it("returns null when no loop edges exist from stage", () => {
    const stageRow = makeStage("fix", "completed", {});
    const action = router.evaluateLoopOverflow(overflowPipeline, "fix", stageRow, {});
    expect(action).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter pipeline-engine test -- src/tests/loop-overflow.test.ts`
Expected: FAIL — `evaluateLoopOverflow` not defined

- [ ] **Step 3: Implement evaluateLoopOverflow in router**

Add to `Router` class in `src/router.ts`:

```typescript
evaluateLoopOverflow(
  pipeline: PipelineDefinition,
  stageId: string,
  stageRow: PipelineStage,
  loopEdgeCounts: Record<string, number>,
): FailureAction | null {
  const edges = pipeline.edges ?? [];
  const loopEdgesFromStage = edges.filter(
    (e) => e.from === stageId && e.type === "loop",
  );

  if (loopEdgesFromStage.length === 0) return null;

  // Check if any loop edge has reached its max
  const overflowed = loopEdgesFromStage.some((e) => {
    const count = loopEdgeCounts[e.id] ?? 0;
    return count >= (e.max_iterations ?? 0);
  });

  if (!overflowed) return null;

  // Fire the error edge from this stage
  const errorEdges = getErrorEdges(edges).filter((e) => e.from === stageId);
  if (errorEdges.length === 0) {
    return { action: "escalate" };
  }

  return { action: "goto", targetStageId: errorEdges[0].to };
}
```

- [ ] **Step 4: Remove first_complete logic from getReadyStages**

In `getReadyStages`, remove the `useFirstComplete` variable and its branch. Replace with always using `all_complete` logic:

Change:
```typescript
const fanInStrategy = stageDef.type === "fan_in" ? stageDef.fan_in_strategy : undefined;
const useFirstComplete = fanInStrategy === "first_complete";
```

To:
```typescript
// Fan-in always uses all_complete — no strategy selection
```

And remove the `if (useFirstComplete)` block, keeping only the `all_complete` logic.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter pipeline-engine test -- src/tests/loop-overflow.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/router.ts src/tests/loop-overflow.test.ts
git commit -m "feat(pipeline-engine): add loop overflow routing, remove first_complete"
```

---

### Task 4: Add fixed fan-out support to router

**Files:**
- Modify: `src/router.ts`
- Create: `src/tests/fixed-fanout.test.ts`

- [ ] **Step 1: Write failing test for fixed fan-out**

```typescript
// src/tests/fixed-fanout.test.ts
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
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter pipeline-engine test -- src/tests/fixed-fanout.test.ts`
Expected: FAIL — `getFixedFanoutOutput` not defined

- [ ] **Step 3: Implement fixed fan-out in router**

Add import at top of `src/router.ts`:
```typescript
import { getActionById } from "./action-registry.js";
```

Add method to `Router` class:
```typescript
getFixedFanoutOutput(stageDef: StageDefinition): Record<string, unknown> | null {
  if (stageDef.type !== "fan_out") return null;
  const action = getActionById(stageDef.actionId);
  if (!action || !action.fixed) return null;

  const tracks = action.outputSchema.properties?.tracks?.items?.enum ?? [];
  return { tracks, ordering: "parallel" };
}
```

Update `requiresAgentDispatch`:
```typescript
requiresAgentDispatch(stageDef: StageDefinition): boolean {
  if (stageDef.type === "fan_out") {
    const action = getActionById(stageDef.actionId);
    if (action?.fixed) return false;
  }
  return stageDef.type === "stage" || stageDef.type === "fan_out";
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter pipeline-engine test -- src/tests/fixed-fanout.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/router.ts src/tests/fixed-fanout.test.ts
git commit -m "feat(pipeline-engine): add fixed fan-out support for deterministic dispatch"
```

---

## Chunk 3: Worker & Dispatcher Changes

### Task 5: Update worker to use action registry

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/dispatcher.ts`

- [ ] **Step 1: Update worker to handle fixed fan-out stages**

In `advancePipeline`, after the `if (!router.requiresAgentDispatch(stageDef))` block, add handling for fixed fan-out: instead of dispatching to an agent, auto-complete the stage with the fixed output.

Add before the existing `if (!router.requiresAgentDispatch(stageDef))` block:

```typescript
// Fixed fan-out: auto-complete with deterministic output (no agent dispatch)
const fixedOutput = router.getFixedFanoutOutput(stageDef);
if (fixedOutput) {
  const claimed = await stateMachine.claimStageForDispatch(stageRow.id);
  if (!claimed) continue;
  await stateMachine.setStageOutput(stageRow.id, fixedOutput);
  await stateMachine.updateStageStatus(stageRow.id, "completed");
  ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "completed" });
  continue;
}
```

- [ ] **Step 2: Update dispatcher to use action for schema/instructions**

In `src/dispatcher.ts`, change `dispatch()` to look up action:

Add import:
```typescript
import { getActionById } from "./action-registry.js";
```

Replace the schema lookup in `dispatch()`:
```typescript
const actionId = "actionId" in stage ? stage.actionId : undefined;
const action = actionId ? getActionById(actionId) : undefined;
const outputInstructions = this.buildOutputInstructions(action?.outputSchema);
```

Update `buildOutputInstructions` signature to accept `JsonSchema | undefined` instead of `string | undefined`:
```typescript
private buildOutputInstructions(outputSchema: object | undefined): string {
  const format = `\n\n---\n### Output Format\nWhen you have completed this task, post a comment containing your structured result in this exact format:\n\n\`\`\`\n<!-- pipeline-output -->\n\\\`\\\`\\\`json\n{ ... your JSON result ... }\n\\\`\\\`\\\`\n\`\`\``;

  if (!outputSchema) return format;

  const schemaJson = JSON.stringify(outputSchema, null, 2);
  return `${format}\n\n### Required Schema\n\n\`\`\`json\n${schemaJson}\n\`\`\``;
}
```

- [ ] **Step 3: Update context building to include action instructions**

In `buildStageContext` in `src/worker.ts`, add action instructions to the context:

```typescript
import { getActionById } from "./action-registry.js";
```

After building upstream outputs section, add:
```typescript
const actionId = "actionId" in stageDef ? stageDef.actionId : undefined;
const action = actionId ? getActionById(actionId) : undefined;
if (action?.instructions) {
  sections.push(`## Task Instructions\n\n${action.instructions}`);
}
```

- [ ] **Step 4: Update output validation to use action schema**

In `handleCommentEvent`, replace the schema lookup:

Change:
```typescript
const outputSchema = "output_schema" in stageDef ? stageDef.output_schema : undefined;
if (outputSchema) {
  let schema: object;
  try {
    schema = loadSchema(outputSchema);
  } catch (err) {
    // ...
  }
  const validation = validateOutput(output, schema);
```

To:
```typescript
const actionId = "actionId" in stageDef ? stageDef.actionId : undefined;
const action = actionId ? getActionById(actionId) : undefined;
if (action?.outputSchema) {
  const validation = validateOutput(output, action.outputSchema);
```

Remove the `try/catch` around `loadSchema` — we're using the schema object directly from the action.

- [ ] **Step 5: Add loop overflow check in advancePipeline**

The overflow check must happen in `advancePipeline`, AFTER `incrementLoopEdgeCount` (so the count reflects the current iteration). When a loop edge fires and the count reaches `max_iterations`, check for overflow.

In `advancePipeline`, after the existing loop edge increment block (`await stateMachine.incrementLoopEdgeCount(runId, loopEdge.id)`), add:

```typescript
// After incrementing, check if this was the last allowed iteration
const newCount = await stateMachine.getLoopEdgeCounts(runId);
for (const stageDef of readyStages) {
  const overflowAction = router.evaluateLoopOverflow(pipeline, stageDef.id, stageDef as any, newCount);
  if (overflowAction) {
    if (overflowAction.action === "escalate") {
      await stateMachine.updateRunStatus(runId, "escalated");
      ctx.streams.emit("run-progress", { runId, stageId: stageDef.id, status: "escalated" });
      return;
    }
    // Route directly to error edge target — don't use handleStageFailure (no retry logic needed)
    const targetRow = currentRows.find((s) => s.stageId === overflowAction.targetStageId);
    if (targetRow) {
      await stateMachine.updateStageStatus(targetRow.id, "pending");
      ctx.streams.emit("run-progress", { runId, stageId: overflowAction.targetStageId, status: "pending" });
    }
    // Don't dispatch the loop target — skip it and let advancePipeline pick up the error target
    return;
  }
}
```

Note: This fires the error edge directly (marking the target as pending for the next advance iteration), rather than going through `handleStageFailure` which would increment retry counts and reset downstream stages unnecessarily.

- [ ] **Step 6: Run full test suite**

Run: `pnpm --filter pipeline-engine test`
Expected: Some tests will fail due to type changes (old `instructions`/`output_schema` references)

- [ ] **Step 7: Commit**

```bash
git add src/worker.ts src/dispatcher.ts
git commit -m "feat(pipeline-engine): wire action registry into worker and dispatcher"
```

---

## Chunk 4: Update Existing Tests

### Task 6: Update test files for new type structure

**Files:**
- Modify: `src/tests/conditional-fanout.test.ts`
- Modify: `src/tests/router-edge-based.test.ts`
- Modify: `src/tests/integration.test.ts`
- Modify: `src/tests/loop-edges.test.ts`
- Modify: `src/tests/dispatcher.test.ts`

- [ ] **Step 1: Update conditional-fanout.test.ts**

Replace stage definitions that use `output_schema`/`instructions` with `actionId`:

```typescript
stages: [
  { id: "plan", type: "stage", agent_role: "planner", actionId: "plan-tasks" },
  { id: "backend", type: "stage", agent_role: "backend-dev", actionId: "triage-new-issues" },
  { id: "frontend", type: "stage", agent_role: "frontend-dev", actionId: "triage-new-issues" },
  { id: "infra", type: "stage", agent_role: "infra-eng", actionId: "triage-new-issues" },
  { id: "merge", type: "fan_in" },
],
```

Note: `fan_in_strategy: "all_complete"` removed from fan_in stages.

- [ ] **Step 2: Update router-edge-based.test.ts**

- Remove all tests for `first_complete` strategy
- Update all `fan_in` stage definitions to remove `fan_in_strategy`
- Update all `stage`/`fan_out` definitions to use `actionId` instead of `instructions`/`output_schema`

- [ ] **Step 3: Update integration.test.ts**

Update pipeline definitions used in integration tests to use `actionId`. Replace any `output_schema: "schema-name"` with `actionId: "triage-new-issues"` (or appropriate action).

- [ ] **Step 4: Update loop-edges.test.ts**

Update stage definitions. Add a test case for overflow scenario that verifies the router's `evaluateLoopOverflow` is called correctly.

- [ ] **Step 5: Update dispatcher.test.ts**

Update the dispatch test to verify that the dispatcher reads from the action registry. The stage passed to `dispatch()` now has `actionId` instead of `output_schema`.

- [ ] **Step 6: Run full test suite**

Run: `pnpm --filter pipeline-engine test`
Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/tests/
git commit -m "test(pipeline-engine): update all tests for action registry and simplified types"
```

---

## Chunk 5: UI Changes

### Task 7: Update StageInspector to use action dropdown

**Files:**
- Modify: `src/ui/components/StageInspector.tsx`

- [ ] **Step 1: Import action registry**

```typescript
import { getActionsForType, getActionById, type Action } from "../../action-registry.js";
```

- [ ] **Step 2: Replace output_schema and instructions fields with action dropdown**

For Stage/FanOut node forms, replace:
- The `output_schema` dropdown
- The `instructions` textarea

With a single "Action" dropdown that filters by node type:
- Stage nodes: show `getActionsForType("single-decision")`
- Fan Out nodes: show `getActionsForType("multi-select")`

When an action is selected, set `actionId` on the stage definition.

- [ ] **Step 3: Add read-only action preview**

Below the action dropdown, show:
- Action instructions (read-only, max 4 lines)
- Output schema enum values (rendered as chips/badges)

- [ ] **Step 4: Remove fan_in_strategy selector from Fan In form**

Replace the strategy dropdown with a static label: "Waits for all active branches to complete"

- [ ] **Step 5: Type-check UI compiles**

Run: `pnpm --filter pipeline-engine tsc --noEmit`
Expected: PASS (no type errors)

- [ ] **Step 6: Commit**

```bash
git add src/ui/components/StageInspector.tsx
git commit -m "feat(pipeline-engine): replace schema/instructions fields with action dropdown in inspector"
```

---

### Task 8: Update StageNode to derive handles from action

**Files:**
- Modify: `src/ui/components/StageNode.tsx`

- [ ] **Step 1: Update handle generation to use action registry**

Instead of receiving `decisionValues` as a prop derived from a separate schema lookup, derive them from the `actionId`:

```typescript
import { getActionById } from "../../action-registry.js";
import { getDecisionEnumValues, getArrayFieldValues } from "../../schema-utils.js";

// Inside the component:
const action = stageDef.actionId ? getActionById(stageDef.actionId) : undefined;
const decisionValues = action
  ? stageDef.type === "stage"
    ? getDecisionEnumValues(action.outputSchema)
    : getArrayFieldValues(action.outputSchema, "tracks")
  : [];
```

- [ ] **Step 2: Commit**

```bash
git add src/ui/components/StageNode.tsx
git commit -m "feat(pipeline-engine): derive node handles from action registry"
```

---

## Chunk 6: Validation & Cleanup

### Task 9: Update save validation to use action registry

**Files:**
- Modify: `src/dag-parser.ts`
- Modify: `src/worker.ts` (save-pipeline action handler)

- [ ] **Step 1: Update DAG validation to check actionId and exhaustive coverage**

In `src/dag-parser.ts`, in the `validateDAG` function, add two new checks:

```typescript
import { getActionById } from "./action-registry.js";
import { getDecisionEnumValues, getArrayFieldValues } from "./schema-utils.js";

// Inside validateDAG, after existing checks:

// Check: every Stage/FanOut has an actionId
for (const stage of pipeline.stages) {
  if ((stage.type === "stage" || stage.type === "fan_out") && !("actionId" in stage && stage.actionId)) {
    errors.push(`Stage "${stage.id}" has no action selected`);
  }
}

// Check: exhaustive decision coverage from action schema
for (const stage of pipeline.stages) {
  if (stage.type !== "stage" && stage.type !== "fan_out") continue;
  const action = getActionById(stage.actionId);
  if (!action) {
    errors.push(`Stage "${stage.id}" references unknown action "${stage.actionId}"`);
    continue;
  }

  const outgoingEdges = pipeline.edges.filter((e) => e.from === stage.id && e.type !== "error" && e.type !== "loop");

  if (stage.type === "stage") {
    const enumValues = getDecisionEnumValues(action.outputSchema);
    if (enumValues.length > 0) {
      const coveredValues = outgoingEdges.map((e) => e.sourceHandle).filter(Boolean);
      for (const val of enumValues) {
        if (!coveredValues.includes(val)) {
          errors.push(`Stage "${stage.id}": decision value "${val}" has no outgoing edge`);
        }
      }
    }
  } else if (stage.type === "fan_out" && !action.fixed) {
    const trackValues = getArrayFieldValues(action.outputSchema, "tracks");
    const coveredKeys = outgoingEdges.map((e) => e.activationKey).filter(Boolean);
    for (const val of trackValues) {
      if (!coveredKeys.includes(val)) {
        errors.push(`Stage "${stage.id}": track value "${val}" has no outgoing edge`);
      }
    }
  }
}
```

- [ ] **Step 2: Remove list-schemas data handler from worker**

In `src/worker.ts`, remove the `list-schemas` and related data handlers that load schemas from the filesystem — they're no longer needed since schemas live in the action registry.

- [ ] **Step 3: Run full test suite**

Run: `pnpm --filter pipeline-engine test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add src/worker.ts
git commit -m "feat(pipeline-engine): validate actionId and exhaustive coverage from action registry"
```

---

### Task 10: Remove dead code

**Files:**
- Modify: `src/output-parser.ts` — remove `loadSchema` function if no longer used
- Modify: `src/schema-utils.ts` — verify helpers still work with inline schema objects
- Delete schemas directory if it existed (it doesn't currently)

- [ ] **Step 1: Check if loadSchema is still referenced anywhere**

Run: `grep -r "loadSchema" src/ --include="*.ts" | grep -v test | grep -v ".d.ts"`

If only used in tests or nowhere, remove it from `output-parser.ts`.

- [ ] **Step 2: Remove FanInStrategy references**

Run: `grep -r "FanInStrategy\|fan_in_strategy\|first_complete" src/ --include="*.ts"`

Remove any remaining references.

- [ ] **Step 3: Run full test suite one final time**

Run: `pnpm --filter pipeline-engine test`
Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(pipeline-engine): remove dead code (loadSchema, FanInStrategy)"
```

---

## Execution Notes

**Order matters:** Tasks 1-2 must complete before Task 3-4 (types change first). Tasks 3-4 must complete before Task 5 (router changes inform worker). Task 6 depends on Tasks 2-5. Tasks 7-8 (UI) are independent of Task 6 but depend on Tasks 1-2. Tasks 9-10 are final cleanup.

**Dependency graph:**
```
Task 1 (registry) ─┐
                    ├─→ Task 3 (router overflow) ─┐
Task 2 (types) ────┤                              ├─→ Task 5 (worker) ─→ Task 6 (tests) ─→ Task 9 (validation) ─→ Task 10 (cleanup)
                    ├─→ Task 4 (fixed fanout) ─────┘
                    └─→ Task 7 (inspector UI) ─→ Task 8 (node UI)
```

**Testing commands:**
- Single test file: `pnpm --filter pipeline-engine test -- src/tests/<file>.ts`
- All tests: `pnpm --filter pipeline-engine test`
- Type checking: `pnpm --filter pipeline-engine tsc --noEmit`
