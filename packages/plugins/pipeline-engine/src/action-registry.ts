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
    id: "create-spec",
    name: "Create Spec",
    type: "single-decision",
    instructions:
      "Create a design spec for this feature issue using the **brainstorming** skill.\n\n" +
      "Follow the brainstorming skill process exactly:\n" +
      "1. Read the issue description and triage comments\n" +
      "2. Read `governance/MISSION.md` and `governance/ENGINEERING.md` for alignment and standards\n" +
      "3. Check existing specs in `docs/specs/` for prior art and conventions\n" +
      "4. Assess scope — if multiple independent subsystems, decompose into sub-issues first\n" +
      "5. Analyze requirements: purpose, constraints, success criteria, dependencies\n" +
      "6. Explore 2-3 technical approaches with pros/cons\n" +
      "7. Write the design spec to `docs/specs/` following the brainstorming skill template\n" +
      "8. Self-review against mission alignment, spec quality, and engineering standards\n" +
      "9. Commit and push the spec\n\n" +
      "The spec MUST include: Goal, Background, Approach (with alternatives considered), " +
      "Requirements (Backend API, Frontend, Performance), API Contract, and Definition of Done.\n\n" +
      "Output 'done' when the spec is committed and pushed.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["done"] },
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
      "Each reviewer outputs a structured `findings` array with severity enum: critical, major, minor.\n\n" +
      "A finding is **blocking** (must fix before merge) if:\n" +
      "- severity is 'critical'\n" +
      "- Multiple reviewers agree on the same issue (convergence signal)\n" +
      "- Any reviewer decision is 'needs_revision'\n\n" +
      "Non-blocking findings (minor, stylistic, suggestions) do NOT block.\n\n" +
      "DEDUPLICATION: If multiple reviewers flag the same file+line, that's one finding, not many. Count unique issues.\n\n" +
      "Output:\n" +
      "- 'pass' — no blocking issues, safe to proceed to simplification\n" +
      "- 'fail-impl' — blocking findings require re-implementation (loop back to coding stage)\n\n" +
      "When outputting 'fail-impl', include a `revision_brief` field with a concise summary of what needs fixing (this gets passed back to the implementation agent).",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["pass", "fail-impl"] },
        total_findings: { type: "integer" },
        blocking_count: { type: "integer" },
        revision_brief: { type: "string" },
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
        tracks: { type: "array", items: { enum: [
          "code-quality", "error-handling", "test-coverage",
          "comment-quality", "type-design", "architecture", "blind-validation"
        ] } },
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
    id: "review-code-quality",
    name: "Review: Code Quality",
    type: "single-decision",
    instructions:
      "You are the Code Quality Reviewer. Review the PR diff for real bugs, real security risks, and real guideline violations.\n\n" +
      "Focus:\n" +
      "- Logic correctness — actual bugs that would break behavior\n" +
      "- Security vulnerabilities — injection, auth bypass, data exposure\n" +
      "- Guideline violations — patterns that conflict with project standards\n\n" +
      "Do NOT report:\n" +
      "- Style preferences or theoretical concerns\n" +
      "- Findings you aren't confident about (false positives erode trust)\n" +
      "- Anything another reviewer dimension covers (error handling, types, architecture)\n\n" +
      "Report each finding as structured JSON in the output `findings` array.\n" +
      "A clean review is a good outcome, not a failure to find issues.\n\n" +
      "Output `approved` if no critical/major issues. `needs_revision` if critical findings exist.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["approved", "needs_revision"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { enum: ["critical", "major", "minor"] },
              file: { type: "string" },
              line: { type: "integer" },
              description: { type: "string" },
              suggestion: { type: "string" },
            },
          },
        },
        summary: { type: "string" },
      },
    },
  },
  {
    id: "review-error-handling",
    name: "Review: Error Handling (Silent Failure Hunter)",
    type: "single-decision",
    instructions:
      "You are the Silent Failure Hunter. You believe silent failures are the worst kind of bug — they hide problems until they become crises.\n\n" +
      "Focus:\n" +
      "- Swallowed errors (empty catch blocks, ignored Promise rejections)\n" +
      "- Missing error propagation (errors that should bubble up but don't)\n" +
      "- Incomplete error handling (try/catch that hides the real failure mode)\n" +
      "- Error messages that don't help debugging\n" +
      "- Missing error boundaries in UI code\n\n" +
      "For EVERY finding, you MUST include the user impact — an error handling issue without a clear user impact statement is not a useful finding.\n\n" +
      "Acceptable patterns you should NOT flag:\n" +
      "- Optional UI enhancements gracefully degrading\n" +
      "- Best-effort logging that doesn't affect core flow\n\n" +
      "Output `approved` if no critical/major issues. `needs_revision` if critical findings exist.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["approved", "needs_revision"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { enum: ["critical", "major", "minor"] },
              file: { type: "string" },
              line: { type: "integer" },
              description: { type: "string" },
              user_impact: { type: "string" },
              suggestion: { type: "string" },
            },
          },
        },
        summary: { type: "string" },
      },
    },
  },
  {
    id: "review-test-coverage",
    name: "Review: Test Coverage (PR Test Analyzer)",
    type: "single-decision",
    instructions:
      "You are the PR Test Analyzer. You care about behavioral coverage, not line coverage metrics.\n\n" +
      "Focus:\n" +
      "- Does this PR have tests that verify the NEW behavior it introduces?\n" +
      "- Are edge cases and error conditions tested?\n" +
      "- Were any pre-existing test files modified? (CRITICAL — Clean Room violation)\n" +
      "- Do the tests verify behavior or just implementation details?\n" +
      "- Are there tests that would catch real regressions (data loss, security, user-facing errors)?\n\n" +
      "CRITICAL: If the implementing agent modified pre-written test files, that is ALWAYS a critical finding. The integrity of pre-written tests is sacred.\n\n" +
      "Do NOT demand:\n" +
      "- 100% coverage\n" +
      "- Pedantic edge case tests that add maintenance burden without catching real failures\n\n" +
      "Output `approved` if tests adequately cover new behavior. `needs_revision` if critical gaps exist.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["approved", "needs_revision"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { enum: ["critical", "major", "minor"] },
              file: { type: "string" },
              line: { type: "integer" },
              description: { type: "string" },
              suggestion: { type: "string" },
            },
          },
        },
        summary: { type: "string" },
      },
    },
  },
  {
    id: "review-comments",
    name: "Review: Comment Quality",
    type: "single-decision",
    instructions:
      "You are the Comment Analyzer. Inaccurate comments are worse than no comments — they actively mislead future developers.\n\n" +
      "Focus:\n" +
      "- Comments that explain 'what' (the code already says this — remove them)\n" +
      "- Comments that are factually wrong or stale\n" +
      "- Missing 'why' comments where non-obvious constraints or workarounds exist\n" +
      "- TODO/FIXME/HACK comments that indicate unfinished work being merged\n\n" +
      "Good comments explain WHY, not WHAT. The best code needs few comments.\n\n" +
      "If there are no comments to analyze, say so and approve. Not every PR needs comment feedback.\n\n" +
      "Output `approved` if comments are accurate and appropriate. `needs_revision` only for critical misleading comments.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["approved", "needs_revision"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { enum: ["critical", "major", "minor"] },
              file: { type: "string" },
              line: { type: "integer" },
              description: { type: "string" },
              suggestion: { type: "string" },
            },
          },
        },
        summary: { type: "string" },
      },
    },
  },
  {
    id: "review-type-design",
    name: "Review: Type Design",
    type: "single-decision",
    instructions:
      "You are the Type Design Analyzer. You believe in making illegal states unrepresentable.\n\n" +
      "Focus:\n" +
      "- Type holes: `any`, `unknown` without narrowing, unsafe casts\n" +
      "- Missing discriminated unions where state variants exist\n" +
      "- Overly permissive types (string where a literal union would be safer)\n" +
      "- Incomplete or incorrect generic constraints\n" +
      "- `# type: ignore` / `@ts-ignore` without explanation\n\n" +
      "Be practical:\n" +
      "- Consider the maintenance burden of stronger invariants\n" +
      "- Perfect type safety at the cost of unreadable code is not a win\n" +
      "- If no new types are introduced, approve and move on\n\n" +
      "Output `approved` if type design is sound. `needs_revision` if type holes allow invalid states.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["approved", "needs_revision"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { enum: ["critical", "major", "minor"] },
              file: { type: "string" },
              line: { type: "integer" },
              description: { type: "string" },
              suggestion: { type: "string" },
            },
          },
        },
        summary: { type: "string" },
      },
    },
  },
  {
    id: "review-architecture",
    name: "Review: Architecture",
    type: "single-decision",
    instructions:
      "You are the Architecture Reviewer. You protect the structural health of the codebase against entropy.\n\n" +
      "Focus:\n" +
      "- Module depth — modules should get deeper (more logic behind same interface), not shallower\n" +
      "- Module boundaries — imports must go through public interfaces, not reach into internals\n" +
      "- Code placement — new code goes in existing modules first; new modules require justification\n" +
      "- Naming alignment — identifiers should match project glossary, no synonym drift\n" +
      "- Entropy prevention — no `utils` files, no premature splitting, no shallow proliferation\n\n" +
      "Reference `docs/ARCHITECTURE.md` (or equivalent) for code placement decisions.\n\n" +
      "Block sparingly, warn often. Only report CRITICAL for clear anti-patterns (new utils file, internal imports from outside module, file proliferation).\n\n" +
      "Output `approved` if structure is maintained. `needs_revision` for structural violations.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["approved", "needs_revision"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { enum: ["critical", "major", "minor"] },
              file: { type: "string" },
              line: { type: "integer" },
              description: { type: "string" },
              suggestion: { type: "string" },
            },
          },
        },
        summary: { type: "string" },
      },
    },
  },
  {
    id: "review-blind-validation",
    name: "Review: Blind Validation",
    type: "single-decision",
    instructions:
      "You are the Blind Validator. You review the PR diff WITHOUT reading the spec or issue description. Your lack of context is your superpower.\n\n" +
      "Philosophy:\n" +
      "- You have NO knowledge of what was requested. That's the point.\n" +
      "- Code that needs a spec to understand is code that will confuse the next developer.\n" +
      "- A finding you're unsure about is a question, not a bug. Report it honestly.\n" +
      "- Evidence over claims. If you can't prove it's wrong, don't call it wrong.\n\n" +
      "Focus:\n" +
      "- Logic correctness (does this code do what it appears to intend?)\n" +
      "- Security issues visible from code alone\n" +
      "- Edge cases and boundary conditions\n" +
      "- Wiring issues (wrong function called, wrong parameter order, off-by-one)\n" +
      "- Self-documentation (can you understand the code without context?)\n\n" +
      "IGNORE the issue description / spec sections in context. Only look at the diff.\n" +
      "Only report findings with confidence >= 80%.\n\n" +
      "Output `approved` if code is self-explanatory and correct. `needs_revision` for logic bugs.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["approved", "needs_revision"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { enum: ["critical", "major", "minor"] },
              file: { type: "string" },
              line: { type: "integer" },
              description: { type: "string" },
              confidence: { type: "number" },
              suggestion: { type: "string" },
            },
          },
        },
        summary: { type: "string" },
      },
    },
  },
  {
    id: "simplify-code",
    name: "Simplify Code",
    type: "single-decision",
    instructions:
      "You are the Code Simplifier. Clarity is the highest virtue. You run as the final polish pass AFTER all reviews pass.\n\n" +
      "Simplify:\n" +
      "- Reduce unnecessary nesting (early returns, guard clauses)\n" +
      "- Eliminate redundant code and abstractions\n" +
      "- Improve variable and function names for clarity\n" +
      "- Remove obvious/redundant comments that describe what the code already says\n" +
      "- Three readable lines are better than one clever line\n\n" +
      "Rules:\n" +
      "- NEVER change behavior or functionality\n" +
      "- NEVER touch test files\n" +
      "- NEVER refactor code outside the PR diff\n" +
      "- Choose clarity over brevity (no nested ternaries)\n\n" +
      "After changes, run the full test suite + lint + typecheck. If anything breaks, revert ALL changes and report as-is.\n\n" +
      "Output 'done' when simplification is committed, or 'no-changes' if the code is already clean.",
    outputSchema: {
      type: "object",
      properties: {
        decision: { enum: ["done", "no-changes"] },
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

