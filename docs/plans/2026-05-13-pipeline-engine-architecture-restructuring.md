# Pipeline Engine Plugin — Architecture Restructuring Plan

## Context

The pipeline-engine plugin evolved organically through feature additions (fan_out/fan_in, loops, block stages, 7 specialized reviewers). The result is a 923-line `worker.ts` god file mixing orchestration, event handling, API routing, and config management. The action registry (588 lines) hardcodes 22 actions with embedded prompt strings. Dead YAML files, an unsafe in-process lock, and dual UI state add maintenance burden. This plan restructures for long-term readability: a new reader should be able to open any file and immediately understand its single responsibility.

## Target Structure

```
src/
├── index.ts                     # Re-export manifest (1 line, unchanged)
├── manifest.ts                  # Plugin manifest (unchanged)
├── types.ts                     # All domain types (unchanged)
├── protocol.ts                  # NEW: shared constants
├── engine/                      # Execution engine
│   ├── index.ts                 # Barrel
│   ├── pipeline-loader.ts       # Load/seed pipelines from state store
│   ├── pipeline-executor.ts     # advancePipeline tick loop + materializePipeline
│   ├── stage-completion.ts      # Process agent output from comments
│   ├── failure-handler.ts       # Error edge routing + escalation
│   ├── loop-resolver.ts         # Loop body BFS + reset logic
│   ├── context-builder.ts       # Build sub-issue description from upstream outputs
│   ├── router.ts                # (moved) Stage readiness + skip detection
│   ├── state-machine.ts         # (moved) DB read/write for runs/stages
│   ├── dispatcher.ts            # (moved) Sub-issue creation + agent wakeup
│   ├── dag-parser.ts            # (moved) Parse + validate DAG
│   └── edge-utils.ts            # (moved) Edge filtering helpers
├── actions/                     # Externalized action definitions
│   ├── index.ts                 # Registry loader + getActionById
│   ├── schema-utils.ts          # (moved) Decision enum extraction
│   └── definitions/             # One JSON file per action (22 files)
├── triggers/                    # Event → pipeline mapping
│   ├── index.ts                 # Wire event handlers
│   ├── trigger-matcher.ts       # (moved) Label matching
│   └── issue-unblock.ts         # Resume paused pipelines
├── api/                         # Thin adapter layer
│   ├── data-handlers.ts         # list-pipelines, get-pipeline, list-runs, etc.
│   ├── action-handlers.ts       # save-pipeline, delete-pipeline, trigger-run, cancel-run
│   └── routes.ts                # onApiRequest handler
├── shared/                      # Cross-cutting utilities
│   └── output-parser.ts         # (moved) Sentinel extraction + JSON parse
├── worker.ts                    # TINY (~60 lines): definePlugin, wire everything
├── ui/                          # (Phase 7 improvements)
└── tests/                       # Mirrors src/ structure
```

---

## Phase 1 — Extract `protocol.ts` (Shared Constants)

**Risk**: Trivial | **Value**: Eliminates fragile couplings

Create `src/protocol.ts` with:
- `OUTPUT_SENTINEL = "<!-- pipeline-output -->"` — used by output-parser.ts and dispatcher.ts
- `BLOCKING_DECISIONS = new Set(["ci-blocked", "escalated", "needs-human"])`
- `PIPELINE_REGISTRY_KEY = { scopeKind: "instance", namespace: "pipeline", stateKey: "registry" }`
- `MAX_ADVANCE_ITERATIONS = 50`
- `BUNDLED_PIPELINES = ["autonomous-dev"]`
- Stream channel name constants (e.g., `STREAM_PIPELINE_STATUS`) — only worker-side constants go here. If the UI also needs these values, duplicate them in `src/ui/constants.ts` with a comment pointing to `protocol.ts` as the source of truth. Do NOT import from `src/protocol.ts` into UI code — they are separate build targets.

**Modify**:
- `src/output-parser.ts` — import `OUTPUT_SENTINEL` from protocol
- `src/dispatcher.ts` — import `OUTPUT_SENTINEL` from protocol (for `buildOutputInstructions`)
- `src/worker.ts` — remove inline constants, import from protocol

**Verify**: `pnpm test` passes, `grep -r "pipeline-output" src/` shows only `protocol.ts`

---

## Phase 2 — Delete Dead YAML Pipelines

**Risk**: Trivial | **Value**: Reduces confusion

**Delete**:
- `pipelines/bug.yaml`
- `pipelines/feature.yaml`
- `pipelines/fast-track.yaml`
- `pipelines/implementation.yaml` (if exists)
- `pipelines/test-writing.yaml` (if exists)

**Keep**: `pipelines/autonomous-dev.json`

**Verify**: `pnpm build && pnpm test`

---

## Phase 3A — Move Existing Modules into `engine/` (File Moves)

**Risk**: Low (pure renames + import rewrites) | **Value**: Establishes target directory structure

Move existing standalone modules into the engine directory. No logic changes — only file paths and import statements change.

- `src/router.ts` → `src/engine/router.ts`
- `src/state-machine.ts` → `src/engine/state-machine.ts`
- `src/dispatcher.ts` → `src/engine/dispatcher.ts`
- `src/dag-parser.ts` → `src/engine/dag-parser.ts`
- `src/edge-utils.ts` → `src/engine/edge-utils.ts`
- `src/output-parser.ts` → `src/shared/output-parser.ts`

Create `src/engine/index.ts` barrel that re-exports all engine modules.

**Import convention**: Consumers import from the barrel (`./engine/index.js`) for cross-boundary access. Files within `engine/` use relative sibling imports (`./router.js`). This keeps the public surface explicit while avoiding deep path chains.

**Verify**: `pnpm build && pnpm test` — all imports resolve, no logic changes

---

## Phase 3B — Extract New Modules from `worker.ts`

**Risk**: Medium (largest logic extraction) | **Value**: Very High (main readability goal)

### Dependency Injection Pattern

Replace module-level `let` variables with an `EngineContext` object passed to all engine functions:

```typescript
export interface EngineContext {
  ctx: PluginContext;
  stateMachine: StateMachine;
  router: Router;
  dispatcher: Dispatcher;
}
```

This enables testing without module globals and makes dependencies explicit.

### 3B-1 — `src/engine/pipeline-loader.ts`
Move: `getPipelineRegistry`, `loadPipelines`, `seedBundledPipelines`, `safeParsePipelineJson`
Source lines: 30-113, 609-617

### 3B-2 — `src/engine/context-builder.ts`
Move: `buildStageContext`
Source lines: 116-156

### 3B-3 — `src/engine/loop-resolver.ts`
Move: `getLoopBodyStageIds`, `canReach`
Source lines: 252-309

### 3B-4 — `src/engine/failure-handler.ts`
Move: `handleStageFailure`
Source lines: 652-731

### 3B-5 — `src/engine/stage-completion.ts`
Move: `handleCommentEvent`, `isBlockingDecision`, `handleCheckpointCompletion`
Source lines: 508-650

### 3B-6 — `src/engine/pipeline-executor.ts`
Move: `advancePipeline`, `materializePipeline`
Source lines: 208-504
This is the heart of the engine — the dispatch tick loop.

Note: `pipeline-executor.ts` will likely be ~250-300 lines given the source range. This is acceptable — the 200-line soft cap applies to utility modules; the executor is the core algorithm and splitting it further would fragment a cohesive state machine. If it grows beyond 350 lines in future, revisit.

**Verify**: `pnpm build && pnpm test` — all 15+ test files pass with updated imports

---

## Phase 3C — Extract Triggers and API Layer

**Risk**: Low-Medium | **Value**: High (completes the worker.ts slim-down)

### 3C-1 — `src/triggers/index.ts`
Move: `handleIssueEvent`, `resolveLabelNames` (lines 178-206)
Move: `src/trigger-matcher.ts` → `src/triggers/trigger-matcher.ts`
Create: `src/triggers/issue-unblock.ts` with `handleIssueUnblock` (lines 158-176)

### 3C-2 — `src/api/data-handlers.ts` + `src/api/action-handlers.ts` + `src/api/routes.ts`
Move: data registrations (lines 749-796), action registrations (lines 799-856), onApiRequest (lines 907-920)
Each exported as a function accepting `PluginContext` + engine dependencies.

### 3C-3 — Slim `src/worker.ts` to ~60 lines
```typescript
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { createEngine } from "./engine/index.js";
import { registerTriggers } from "./triggers/index.js";
import { registerDataHandlers } from "./api/data-handlers.js";
import { registerActionHandlers } from "./api/action-handlers.js";
import { handleApiRequest } from "./api/routes.js";

const plugin = definePlugin({
  async setup(ctx) {
    const engine = await createEngine(ctx);
    registerTriggers(ctx, engine);
    registerDataHandlers(ctx, engine);
    registerActionHandlers(ctx, engine);
  },
  async onConfigChanged(cfg) { /* reload engine */ },
  async onApiRequest(input) { return handleApiRequest(input); },
});

runWorker(plugin, import.meta.url);
```

**Verify**: `pnpm build && pnpm test` — worker.ts ≤80 lines, all tests pass

---

## Phase 4 — Externalize Action Registry to JSON

**Risk**: Low | **Value**: High (maintainability, extensibility)

### 4a — Create `src/actions/definitions/` with 22 JSON files

Each file:
```json
{
  "id": "triage-new-issues",
  "name": "Triage New Issues",
  "version": 1,
  "type": "single-decision",
  "instructions": "...",
  "outputSchema": { ... }
}
```

### 4b — Create shared schema fragment
`src/actions/schema-fragments/findings.json` — the `findings` array schema shared by 7 reviewer actions. Each reviewer JSON uses a `$findings` key that the loader inlines at load time via simple object spread (not JSON Schema `$ref` — keep it dead simple):

```typescript
// In loader: if definition.outputSchema.$findings, replace with spread of findings.json content
if (def.outputSchema?.$findings) {
  const { $findings, ...rest } = def.outputSchema;
  def.outputSchema = { ...rest, ...findingsSchema };
}
```

### 4c — Create `src/actions/index.ts`

**Loading mechanism**: Use TypeScript `import` with `assert { type: "json" }` (or `with { type: "json" }` depending on TS target) for static imports of the definitions directory. Alternatively, if the plugin is bundled, use `fs.readFileSync` + `JSON.parse` at startup from a known path relative to `import.meta.url`:

```typescript
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";

const DEFS_DIR = join(dirname(fileURLToPath(import.meta.url)), "definitions");

function loadDefinitions(): Action[] {
  return readdirSync(DEFS_DIR)
    .filter(f => f.endsWith(".json"))
    .map(f => JSON.parse(readFileSync(join(DEFS_DIR, f), "utf-8")));
}
```

Ensure `tsconfig.json` includes `"resolveJsonModule": true` and that the build step copies `definitions/*.json` to the output directory (add to `package.json` build script or use tsconfig `outDir` + a cp step).

Exposes:
- `getActionById(id: string): Action | undefined`
- `getAllActions(): readonly Action[]`
- `getActionsForType(type: "single-decision" | "multi-select"): Action[]`

### 4d — Move `src/schema-utils.ts` → `src/actions/schema-utils.ts`

### 4e — Delete `src/action-registry.ts` (588 lines)

**Verify**: `pnpm test` — `action-registry.test.ts` updated, all actions load correctly. Confirm `definitions/*.json` files exist in build output.

---

## Phase 5 — Fix Advisory Lock (PostgreSQL-backed)

**Risk**: Medium | **Value**: High (data integrity)

**File**: `src/engine/state-machine.ts`

**Replace**:
```typescript
// Remove: private activeLocks = new Map<string, number>();
// Remove: private static LOCK_TTL_MS = 60_000;

async tryAdvisoryLock(runId: string): Promise<boolean> {
  if (!this.supportsAdvisoryLocks) {
    return this.tryInProcessLock(runId); // fallback for PGlite/dev
  }
  const lockKey = this.runIdToLockKey(runId);
  const [row] = await this.db.query<{ locked: boolean }>(
    `SELECT pg_try_advisory_lock($1) as locked`, [lockKey]
  );
  return row?.locked ?? false;
}

async releaseAdvisoryLock(runId: string): Promise<void> {
  if (!this.supportsAdvisoryLocks) {
    this.releaseInProcessLock(runId);
    return;
  }
  const lockKey = this.runIdToLockKey(runId);
  await this.db.query(`SELECT pg_advisory_unlock($1)`, [lockKey]);
}

private runIdToLockKey(runId: string): string {
  // First 15 hex digits of UUID → bigint for pg advisory lock
  return BigInt("0x" + runId.replace(/-/g, "").slice(0, 15)).toString();
}
```

**PGlite compatibility**: PGlite does not support `pg_try_advisory_lock`. Detect at startup:

```typescript
private supportsAdvisoryLocks = false;

async init(): Promise<void> {
  try {
    await this.db.query(`SELECT pg_try_advisory_lock(0)`);
    await this.db.query(`SELECT pg_advisory_unlock(0)`);
    this.supportsAdvisoryLocks = true;
  } catch {
    // PGlite or unsupported — fall back to in-process lock (safe for single-instance dev)
    this.supportsAdvisoryLocks = false;
  }
}
```

The in-process lock fallback retains the existing TTL-based `Map<string, number>` approach — it's fine for single-instance dev where only one worker process runs.

**Verify**: `state-machine.test.ts` updated to mock pg_try_advisory_lock, `pnpm test` passes. Add a test confirming fallback path works when advisory lock throws.

---

## Phase 6 — Explicit `sub-pipeline` Error Handling

**Risk**: Low | **Value**: Medium (prevents silent stalls)

**Current behavior**: Router silently skips sub-pipeline stages. `handleCheckpointCompletion` pauses with a log warning.

**New behavior**:
1. In `pipeline-executor.ts` dispatch loop: when a stage type is `sub-pipeline`, set status to `"blocked"` (not silently skip) and post a comment on parent issue explaining the feature is not yet available.
2. In DAG validator (`dag-parser.ts`): add a warning (not error) when a pipeline contains sub-pipeline stages.
3. In UI `ValidationErrors.tsx`: display the warning when saving a pipeline with sub-pipeline stages.

**Verify**: New test confirming sub-pipeline produces explicit block/warning, `pnpm test` passes

---

## Phase 7 — UI State Simplification

**Risk**: High (visual regression risk) | **Value**: Medium (eliminates sync bugs)

### 7a — Create `src/ui/hooks/usePipelineState.ts`

Single source of truth hook:
```typescript
export function usePipelineState(initial: PipelineDefinition) {
  const [stages, setStages] = useState(initial.stages);
  const [edges, setEdges] = useState(initial.edges);
  const [positions, setPositions] = useState(initial.positions);

  const rfNodes = useMemo(() => stagesToNodes(stages, positions, selectedId), [...]);
  const rfEdges = useMemo(() => edgesToRfEdges(edges, stages), [...]);

  return {
    stages, edges, positions,
    rfNodes, rfEdges,
    addStage, removeStage, updateStage,
    addEdge, removeEdge,
    moveNode, // updates positions
    toDefinition, // serialize back to PipelineDefinition
  };
}
```

### 7b — Rewrite `PipelineCanvas.tsx` (~200 lines)
- Use controlled ReactFlow mode (`nodes={rfNodes} edges={rfEdges}`)
- Handle `onNodesChange` / `onEdgesChange` via hook mutation methods
- Remove `useNodesState` / `useEdgesState` / sync `useEffect`s

### 7c — Extract `PipelineToolbar.tsx`
Save, validate, auto-layout buttons extracted from canvas.

### 7d — Automated tests for the state hook and canvas

Required tests (not optional — this is a high-risk phase):

1. **Unit tests for `usePipelineState`** (`src/tests/ui/usePipelineState.test.ts`):
   - `addStage` → stages array grows, rfNodes updates
   - `removeStage` → stages + connected edges removed
   - `addEdge` / `removeEdge` → rfEdges reflects change
   - `moveNode` → positions update, rfNodes recalculate
   - `toDefinition` → round-trips back to original shape (serialize/deserialize identity)

2. **Component snapshot tests** (`src/tests/ui/PipelineCanvas.test.tsx`):
   - Renders correct number of nodes/edges for a given pipeline
   - Empty pipeline renders without crash

3. **Playwright smoke test** (if e2e infra exists):
   - Create pipeline → add 2 stages → connect → save → reload → verify stages persist

**Verify**: Unit tests pass, snapshot tests pass. Manual visual check: create pipeline, add/remove stages, connect edges, auto-layout, save, reload.

---

## Phase 8 — Test Structure Migration

**Risk**: Trivial | **Value**: Organization

Move test files to mirror `src/` structure:
```
src/tests/engine/       ← dag-parser, state-machine, dispatcher, router, edge-utils, loops, integration
src/tests/actions/      ← action-registry, schema-utils
src/tests/triggers/     ← trigger-matcher
src/tests/ui/           ← usePipelineState, PipelineCanvas (from Phase 7d)
src/tests/integration/  ← idp-compatibility, review-pipeline
```

Also fix `review-pipeline.test.ts` to import types from `types.ts` instead of re-declaring locally.

**Pre-flight check**: Before moving files, verify the vitest config's `include` glob will pick up the new paths. If vitest.config.ts has an explicit pattern like `src/**/*.test.ts`, the move is safe. If it specifies exact directories (e.g., `src/tests/*.test.ts` without `**`), update the glob to `src/tests/**/*.test.ts` first.

**Verify**: `pnpm test` passes, no test file left in old location, `pnpm test --list` confirms all test files are discovered

---

## Execution Order

| # | Phase | Estimated Effort | Can Parallelize With |
|---|-------|-----------------|---------------------|
| 1 | Protocol constants | 30 min | Phase 2 |
| 2 | Delete dead YAML | 10 min | Phase 1 |
| 3A | Move existing modules into engine/ | 45 min | — |
| 3B | Extract new modules from worker.ts | 2-3 hours | — |
| 3C | Extract triggers and API layer | 1 hour | — |
| 4 | Externalize actions | 1-2 hours | — |
| 5 | Fix advisory lock | 1 hour | Phase 4, 6 |
| 6 | Sub-pipeline handling | 30 min | Phase 5 |
| 7 | UI state simplification | 3-4 hours | — |
| 8 | Test restructure | 30 min | — |

Phases 1+2 are quick wins to start. Phase 3A is low-risk prep (file moves only). Phase 3B is the critical path — each sub-step should be a separate commit with passing build+test. Phase 3C completes the worker.ts slim-down. Phases 4-6 can proceed in parallel after 3C. Phase 7 is independent of 4-6. Phase 8 is last.

---

## Verification (End-to-End)

After all phases:
1. `pnpm build` — clean build, no type errors
2. `pnpm test` — all tests pass (including new Phase 7d unit tests)
3. `worker.ts` is ≤80 lines
4. No utility file in `src/engine/` exceeds 200 lines; `pipeline-executor.ts` is ≤350 lines
5. Each file has a single, obvious responsibility
6. `grep -rn "let pluginCtx\|let stateMachine\|let dispatcher\|let router" src/` returns nothing (no module globals)
7. New developer can read `worker.ts` → understand plugin shape in 30 seconds → drill into any subsystem
8. `pnpm test --list` discovers all test files (no orphans from Phase 8 move)
