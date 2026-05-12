# Pipeline Engine Cleanup Plan

## Phase 1 — Quick Wins (safe deletes, no behavior change) ✅

### 1.1 Remove unused imports & exports

- [x] `worker.ts:14` — remove `buildExpressionContext` from import
- [x] `dag-parser.ts:106-139` — remove `validateCoverage()` export
- [x] `action-registry.ts:195-200` — remove `getActionByIdOrThrow()` (updated tests)
- [x] `edge-utils.ts:14` — remove `getOutgoingEdges()` export (removed tests too)
- [x] `template-engine.ts:39-41` — remove `getLastMissingVars()` and the shared `missingVars` state

### 1.2 Remove dead UI code

- [x] `PipelineCanvas.tsx:25-40` — delete `buildEdges()` function
- [x] `PipelineCanvas.tsx:59,63` — remove `companyId` prop from `PipelineCanvasProps` and destructuring
- [x] `PipelineCanvas.tsx:102` — remove `selected: stage.id === selectedStageId` from node data
- [x] `PipelineCanvas.tsx:171-174` — remove `handleNodeClick` handler and `onNodeClick` prop from ReactFlow
- [x] `StageInspector.tsx:19,24` — remove `stageIds` from `EdgeInspectorProps` and destructuring
- [x] `StageInspector.tsx:97,103` — remove `stageIds` and `upstreamStageIds` from `StageFormProps` and destructuring
- [x] Remove corresponding prop passing at call sites

### 1.3 Remove dead constants

- [x] `constants.ts:7-8` — remove `LIST_SCHEMAS` and `LIST_SCHEMA_CONTENTS`
- [x] `constants.ts:14` — remove `TRIGGER_RUN`

### 1.4 Remove dead types

- [x] `types.ts:86-93` — remove `SubPipelineRun` interface
- [x] `types.ts:114` — remove `output?` field from `ExpressionContext`
- [x] `types.ts:104-108` — remove `StageOutput` type

### 1.5 Remove dead code paths

- [x] `worker.ts:330-338` — remove the no-op `goto` block in loop overflow handling
- [x] `router.ts:117-121` — remove unreachable `else if` branch in `getReadyStages`

---

## Phase 2 — Remove Unused Parameters ✅

- [x] `router.ts:221-240` — remove `stageRow` and `targetStageRow` params from `evaluateFailure`; update caller
- [x] `router.ts:9,150` — remove `companyId` param from `getReadyStages` and `getSkippedStages`; update all callers
- [x] `router.ts:253` — remove `_stageRow` param from `evaluateLoopOverflow`; update callers
- [x] `state-machine.ts:228` — remove redundant `& { pipelineRunId: string }` intersection type

---

## Phase 3 — Consolidate Duplicated Logic ✅

### 3.1 Edge styling helper

- [x] Create `src/ui/edge-styles.ts` with `edgeStyleForType(type: string): { stroke, strokeDasharray? }`
- [x] Replace inline ternaries in `PipelineCanvas.tsx` (rfEdges memo, handleEdgeUpdate, handleConnect)
- [x] Apply same helper in `RunReplayCanvas.tsx` (fixes missing loop edge styling)

### 3.2 Stage type metadata

- [x] Create shared `src/ui/stage-type-meta.ts` with `STAGE_TYPES` array (type, color, badge, label, description)
- [x] Refactor `StageNode.tsx` to import from shared source (remove `TYPE_COLORS`, `TYPE_BADGES`)
- [x] Refactor `StagePalette.tsx` to import from shared source (remove local `STAGE_TYPES`)

### 3.3 Run status colors

- [x] Move `RUN_STATUS_COLORS` to a shared constant (`src/ui/run-status.ts`)
- [x] Refactor `RunHistory.tsx` and `RunReplayCanvas.tsx` to import from shared source
- [x] Replay canvas now uses shared colors (includes `paused` and `cancelled`)

### 3.4 Selection handler consolidation

- [ ] Remove `handleNodeSelect` (and `data.onSelect` in node data)
- [ ] Keep only `handleSelectionChange` as the single selection mechanism
- [ ] Update `StageNode.tsx` to remove `onClick` with `stopPropagation` — let ReactFlow handle selection natively

> **Deferred**: Removing `handleNodeSelect` + `StageNode.onClick` requires verifying that ReactFlow's native selection fires `onSelectionChange` correctly for single clicks. This is a behavioral change that needs manual browser testing.

### 3.5 Double data fetch

- [ ] In `PipelineList.tsx`, pass fetched pipeline list from `PipelinesPage` as a prop to `PipelineListView`
- [ ] Remove redundant `usePluginData` call inside `PipelineListView`

> **Deferred**: The `PipelineListView` component relies on `refresh()` from its own `usePluginData` hook for the delete action. Passing data as a prop would require lifting the refresh mechanism up, which touches component boundaries.

---

## Phase 4 — Simplification Refactors ✅

### 4.1 Use existing `buildAdjacencyFromEdges`

- [x] `worker.ts:224-230` — replaced manual adjacency building with `buildAdjacencyFromEdges(pipeline.edges ?? [])`

### 4.2 Fix O(n²) BFS

- [x] `state-machine.ts:147-162` — rewrote `getDownstreamStageIds` to use forward adjacency lookup (O(n+e))

### 4.3 Remove or implement `ordering`

- [ ] Decide: is `ordering` a planned feature or dead weight?

> **Deferred**: Requires product decision. The `ordering` field is produced by `getFixedFanoutOutput` and declared in `SubPipelineStage`. It's inert at runtime but may be a planned feature for sub-pipeline execution.

---

## Phase 5 — Structural (requires design decision)

### 5.1 Unify validation

- [ ] Decide ownership: should validation live in engine (shared) or stay split?

> **Deferred**: Requires architectural decision about client/server validation boundary.

---

## Verification ✅

- Build: `pnpm build` passes
- Tests: 135 tests pass (17 test files, 0 failures)
- Removed 4 tests that tested deleted exports (getActionByIdOrThrow, getOutgoingEdges)
