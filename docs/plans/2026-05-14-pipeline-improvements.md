# Pipeline Engine — Improvements Plan

Based on the INT-411 end-to-end run (45 min, 19 stages, scenario validation failed 0/11 despite all reviewers passing).

## Problem Statement

The pipeline successfully orchestrates 19 stages including fan-out/fan-in for 7 parallel reviewers, loop-back gating, and blocking decisions. However, the final output failed validation because:
1. Implementation created components but didn't wire them into the app
2. All 7 reviewers approved the code quality without catching the integration gap
3. No "does it actually run" gate exists before the expensive review phase
4. The scenario validator (the only gate that catches this) runs last and takes 25 minutes

## Phases

### Phase 1: Pipeline Lifecycle Visibility

**Goal:** Observers can track pipeline progress without checking sub-issues.

**Changes:**

1. **Update parent issue status on materialization** (`pipeline-executor.ts`)
   - Set parent issue status to `"in_progress"` when `materializePipeline` creates the run
   - Set to `"done"` when pipeline completes successfully
   - Set to `"blocked"` only on block/escalation (already done)

2. **Post progress comment on parent issue** (`pipeline-executor.ts`)
   - On each stage completion, post/update a single "Pipeline Progress" comment on the parent
   - Format: checklist with stage names, checkmarks for done, spinner for running
   - Use comment editing (find by sentinel) rather than creating new comments each time

**Files:** `pipeline-executor.ts`, `stage-completion.ts`

---

### Phase 2: Stage Timeouts

**Goal:** Prevent stages from running indefinitely.

**Approach:** Paperclip already has execution timeout configuration at the platform level. Use that instead of reimplementing timeout logic in the pipeline engine.

**Changes:**

1. **Configure appropriate timeouts per agent role** in Paperclip company/project settings
   - Reviewers: 300s
   - Implementation agents: 600s
   - Scenario-validator: 900s

2. **Ensure pipeline engine handles timeout failures gracefully**
   - When Paperclip kills a timed-out agent, verify the pipeline receives a failure event
   - Confirm `handleStageFailure` routes correctly (retry or escalate)

**Files:** Paperclip configuration (no pipeline-engine code changes needed)

---

### Phase 3: Build Gate Before PR

**Goal:** Catch integration failures before opening a PR and running expensive reviews.

**Changes:**

1. **Add `build-verify` stage to the autonomous-dev pipeline** (YAML/JSON)
   - Position: after `de-slop-frontend`, before `open-pr`
   - Action: run `pnpm install && pnpm build && pnpm test` in the workspace
   - Decision routing: `pass` → open-pr, `fail` → loop back to `write-frontend-impl`
   - Max iterations: 2 (then escalate)

2. **Create `build-verify` action definition** (`actions/definitions/build-verify.json`)
   - Instructions: run the project's build and test commands, report pass/fail with error output
   - Output schema: `{ decision: "pass"|"fail", errors?: string }`

**Files:** `pipelines/autonomous-dev.json`, `actions/definitions/build-verify.json`, `actions/index.ts`

---

### Phase 4: Integration Smoke Test Before Reviews

**Goal:** Ensure the app actually renders before spending tokens on 7 parallel reviewers.

**Changes:**

1. **Add `smoke-test` stage** to the pipeline
   - Position: after `open-pr`, before the fan-out to reviewers
   - Action: start dev server, navigate to key routes, verify non-404 and expected elements
   - Decision: `pass` → fan-out to reviewers, `fail` → loop back to `write-frontend-impl`
   - Max iterations: 2

2. **Create `smoke-test` action definition** (`actions/definitions/smoke-test.json`)
   - Instructions: start the dev server, check 3 critical routes render expected content
   - Output schema: `{ decision: "pass"|"fail", routes_checked: number, failures: string[] }`

3. **Move scenario-validator earlier** (or make it the smoke-test)
   - The current scenario-validator is too heavy for a gate (25 min, all 11 scenarios)
   - Smoke-test is a lightweight subset (3 routes, 60s timeout)

**Files:** `pipelines/autonomous-dev.json`, `actions/definitions/smoke-test.json`, `actions/index.ts`

---

### Phase 5: Dedup Agent Completions

**Goal:** Prevent multiple pipeline_output comments from confusing the state machine.

**Changes:**

1. **Reject duplicate completions in `handleCommentEvent`** (`stage-completion.ts`)
   - After finding a valid `pipeline_output` extraction, check if `stageRow.status === "completed"`
   - If already completed, log debug and return early (don't re-process)

2. **Idempotent stage output** (`state-machine.ts`)
   - `setStageOutput` should be a no-op if the stage is already completed
   - Add a status check before the UPDATE

**Files:** `stage-completion.ts`, `state-machine.ts`

---

### Phase 6: Richer Context for Implementation Stages

**Goal:** Implementation agents receive the full task plan, not just summaries.

**Changes:**

1. **Include full upstream output in context** (`context-builder.ts`)
   - Currently includes parent issue description + upstream stage outputs
   - For `write-frontend-impl`: also include the full `plan-tasks` output (not truncated)
   - For `write-frontend-tests`: include the spec and plan outputs

2. **Add `context_includes` field to stage definition** (`types.ts`)
   - Array of stage IDs whose full output should be included in context
   - Example: `write-frontend-impl.context_includes: ["plan-tasks", "create-spec"]`

3. **Update context-builder to respect `context_includes`** (`context-builder.ts`)
   - When building context, include full output from specified stages even if not direct upstream

**Files:** `types.ts`, `context-builder.ts`, `pipelines/autonomous-dev.json`

---

### Phase 7: Parallel Write Stages

**Goal:** Reduce wall-clock time by running tests and implementation in parallel.

**Changes:**

1. **Restructure pipeline DAG** (`pipelines/autonomous-dev.json`)
   - Current: plan-tasks → write-tests → write-impl → de-slop
   - New: plan-tasks → fan-out → [write-tests, write-impl] → fan-in → de-slop
   - Both stages get the full plan + spec as context

2. **Add fan-out/fan-in stages around the write pair**
   - `write-fan-out`: fixed fan-out with tracks `["tests", "impl"]`
   - `write-fan-in`: sync point after both complete

**Files:** `pipelines/autonomous-dev.json`

**Risk:** Implementation might need test outputs to guide structure. Start with parallel, revert to sequential if quality drops.

---

### Phase 8: Scenario Validator Optimization

**Goal:** Reduce scenario-validator from 25 min to < 5 min.

**Changes:**

1. **Critical-path sampling** — validate only 3-4 key routes instead of all 11
   - Select routes that cover: home, one navigation item, one deep page
   - Full 11-scenario validation only on the final loop iteration

2. **Fail fast** — abort validation on first critical failure
   - If home page returns 404 or has no shell, don't check the other 10 routes

3. **Add `validation_mode` field to stage definition**
   - `"quick"`: 3 routes, 60s timeout (used as smoke-test gate)
   - `"full"`: all scenarios, 600s timeout (used on final validation)

4. **Restructure pipeline to use quick validation earlier**
   - Smoke-test (Phase 4) uses `validation_mode: "quick"`
   - Final scenario-validator uses `validation_mode: "full"` only after reviews pass

**Files:** `actions/definitions/scenario-validator.json`, `pipelines/autonomous-dev.json`, `types.ts`

---

### Phase 9: Cache Spec Validation

**Goal:** Don't re-validate spec if it hasn't changed.

**Changes:**

1. **Content hash in stage output** (`actions/definitions/valid-spec.json`)
   - When valid-spec approves, include a SHA of the spec file content in output
   - `{ decision: "yes", spec_hash: "abc123" }`

2. **Skip logic in router** (`router.ts`)
   - On loop-back iteration, if spec_hash matches previous iteration's hash, auto-complete valid-spec
   - Only re-validate if the spec was actually modified

3. **Add `skip_if_unchanged` field to stage definition**
   - References a file path or upstream output hash
   - Router checks before dispatching

**Files:** `router.ts`, `types.ts`, `actions/definitions/valid-spec.json`, `pipelines/autonomous-dev.json`

**Risk:** Complexity. Defer until loop-back frequency is measured over 10+ runs.

---

## Execution Order

| Priority | Phase | Effort | Impact |
|----------|-------|--------|--------|
| 1 | Phase 5: Dedup completions | Small (1h) | Prevents confusion, data integrity |
| 2 | Phase 1: Lifecycle visibility | Small (2h) | Developer experience |
| 3 | Phase 3: Build gate | Medium (3h) | Catches integration failures early |
| 4 | Phase 4: Smoke test | Medium (3h) | Prevents wasting 7 reviewer runs on broken code |
| 5 | Phase 2: Stage timeouts | Small (config) | Prevents indefinite hangs — uses Paperclip's built-in timeout |
| 6 | Phase 6: Richer context | Small (2h) | Improves implementation quality |
| 7 | Phase 8: Validator optimization | Medium (4h) | Reduces pipeline time by 20 min |
| 8 | Phase 7: Parallel writes | Small (1h) | Saves ~100s wall-clock |
| 9 | Phase 9: Cache spec validation | Large (6h) | Marginal gain, high complexity |

## Success Criteria

After implementing phases 1-6:
- Pipeline produces a working (buildable, routable) app before opening PR
- Observers can track progress from the parent issue
- No stage runs longer than its timeout
- No duplicate completions processed
- Scenario validation passes on first attempt (because build-gate and smoke-test caught integration issues earlier)

## Metrics to Track

- **Pipeline completion rate** — % of runs that reach "completed" without escalation
- **First-pass scenario validation rate** — % of runs where scenario-validator passes without loop-back
- **Total pipeline wall-clock time** — target: < 30 min (from current 45 min)
- **Token spend per run** — measure before/after smoke-test gate (expect 40% reduction on failures caught early)
