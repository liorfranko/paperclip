#!/usr/bin/env python3
"""
E2E Test CLI: Pipeline Engine — Mock Agent

Exercises the full pipeline lifecycle via HTTP APIs without any real LLM calls.
A "mock agent" simulates stage completion by posting structured comments with
the pipeline-output sentinel, using realistic outputs matching each action's schema.

Usage:
  python3 tests/e2e-mock-agent.py                          # Run all scenarios
  python3 tests/e2e-mock-agent.py --scenario happy         # Run specific scenario
  python3 tests/e2e-mock-agent.py --no-cleanup             # Leave artifacts in UI
  python3 tests/e2e-mock-agent.py --cleanup-only           # Clean up previous run
  python3 tests/e2e-mock-agent.py --list                   # List available scenarios
"""

import argparse
import json
import sys
import time
import urllib.request
import urllib.error
from dataclasses import dataclass, field

BASE = "http://localhost:3100/api"
COMPANY_ID = "f3f8f577-efb7-4b18-9c8a-e70656a09d38"
PLUGIN_ID = "bf3901a7-72e3-42ee-a10a-670997636614"
OUTPUT_SENTINEL = "<!-- pipeline-output -->"
PIPELINE_NAME = "autonomous-dev"

# ═══════════════════════════════════════════════════════════════════════════════
# Realistic mock outputs for each action
# ═══════════════════════════════════════════════════════════════════════════════

MOCK_OUTPUTS = {
    "triage-feature": {
        "decision": "feature",
    },
    "triage-bug": {
        "decision": "bug",
    },
    "triage-fast-track": {
        "decision": "fast-track",
    },
    "validate-scenario-yes": {
        "decision": "yes",
    },
    "validate-scenario-no": {
        "decision": "no",
    },
    "create-spec": {
        "decision": "done",
    },
    "validate-spec-yes": {
        "decision": "yes",
    },
    "validate-spec-no": {
        "decision": "no",
    },
    "plan-tasks-both": {
        "tracks": ["backend", "frontend"],
        "ordering": "parallel",
    },
    "plan-tasks-backend-only": {
        "tracks": ["backend"],
        "ordering": "parallel",
    },
    "plan-tasks-frontend-only": {
        "tracks": ["frontend"],
        "ordering": "parallel",
    },
    "write-tests": {
        "decision": "done",
    },
    "write-implementation": {
        "decision": "done",
    },
    "de-slop-verify": {
        "decision": "done",
    },
    "open-pr": {
        "decision": "done",
    },
    "check-ci-pass": {
        "tracks": ["pass"],
        "ordering": "parallel",
    },
    "check-ci-fail-backend": {
        "tracks": ["backend"],
        "ordering": "parallel",
    },
    "check-ci-fail-both": {
        "tracks": ["backend", "frontend"],
        "ordering": "parallel",
    },
    "fix-ci": {
        "decision": "done",
    },
    "dispatch-reviews-full": {
        "tracks": [
            "code-quality",
            "error-handling",
            "test-coverage",
            "comment-quality",
            "type-design",
            "architecture",
            "blind-validation",
        ],
        "ordering": "parallel",
    },
    "dispatch-reviews-minimal": {
        "tracks": ["code-quality", "test-coverage"],
        "ordering": "parallel",
    },
    "review-approved": {
        "decision": "approved",
        "findings": [],
        "summary": "Code quality looks good. No critical issues found.",
    },
    "review-code-quality-approved": {
        "decision": "approved",
        "findings": [
            {
                "severity": "minor",
                "file": "src/services/feature.service.ts",
                "line": 42,
                "description": "Consider extracting magic number 30 into a named constant",
                "suggestion": "const MAX_RETRY_ATTEMPTS = 30;",
            }
        ],
        "summary": "Minor style suggestion, no blocking issues.",
    },
    "review-error-handling-approved": {
        "decision": "approved",
        "findings": [],
        "summary": "Error handling is comprehensive. All async operations have proper try/catch with typed errors.",
    },
    "review-test-coverage-approved": {
        "decision": "approved",
        "findings": [
            {
                "severity": "minor",
                "file": "src/services/feature.service.test.ts",
                "line": 88,
                "description": "Edge case for empty array input not tested",
                "suggestion": "Add test: it('handles empty items array gracefully')",
            }
        ],
        "summary": "Good coverage overall. One minor gap noted but non-blocking.",
    },
    "review-comments-approved": {
        "decision": "approved",
        "findings": [],
        "summary": "Comments are minimal and appropriate. No stale or misleading documentation.",
    },
    "review-type-design-approved": {
        "decision": "approved",
        "findings": [],
        "summary": "Type design is sound. Good use of discriminated unions and branded types.",
    },
    "review-architecture-approved": {
        "decision": "approved",
        "findings": [],
        "summary": "Architecture follows existing patterns. No new abstractions introduced unnecessarily.",
    },
    "review-blind-validation-approved": {
        "decision": "approved",
        "findings": [],
        "summary": "Blind validation passed. Feature behavior matches scenario expectations.",
    },
    "review-needs-revision": {
        "decision": "needs_revision",
        "findings": [
            {
                "severity": "critical",
                "file": "src/services/payment.service.ts",
                "line": 127,
                "description": "SQL injection vulnerability: user input interpolated directly into query string",
                "suggestion": "Use parameterized query: db.query('SELECT * FROM orders WHERE id = $1', [orderId])",
            },
            {
                "severity": "major",
                "file": "src/controllers/order.controller.ts",
                "line": 45,
                "description": "Missing authentication check — endpoint accessible without valid session",
                "suggestion": "Add authMiddleware to route definition",
            },
        ],
        "summary": "Critical security issues found. Must fix before merge.",
    },
    "evaluate-findings-pass": {
        "decision": "pass",
        "total_findings": 3,
        "blocking_count": 0,
        "revision_brief": "",
    },
    "evaluate-findings-fail": {
        "decision": "fail-impl",
        "total_findings": 5,
        "blocking_count": 2,
        "revision_brief": "Fix SQL injection in payment.service.ts:127 (use parameterized queries) and add auth middleware to order.controller.ts:45.",
    },
    "simplify-code": {
        "decision": "done",
    },
    "simplify-code-no-changes": {
        "decision": "no-changes",
    },
    "validate-scenario-result-valid": {
        "decision": "valid",
    },
    "validate-scenario-result-not-valid-frontend": {
        "decision": "not-valid-frontend",
    },
    "validate-scenario-result-not-valid-backend": {
        "decision": "not-valid-backend",
    },
    "validate-scenario-result-not-valid": {
        "decision": "not-valid",
    },
}


# ═══════════════════════════════════════════════════════════════════════════════
# HTTP helpers
# ═══════════════════════════════════════════════════════════════════════════════


def api_get(path):
    url = f"{BASE}{path}"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        raise RuntimeError(f"GET {path} → {e.code}: {body}")


def api_post(path, data=None):
    url = f"{BASE}{path}"
    body = json.dumps(data).encode() if data else b""
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        resp_body = e.read().decode() if e.fp else ""
        raise RuntimeError(f"POST {path} → {e.code}: {resp_body}")


def api_delete(path):
    url = f"{BASE}{path}"
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else {}
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════════════════════
# Console output
# ═══════════════════════════════════════════════════════════════════════════════


class C:
    RED = "\033[0;31m"
    GREEN = "\033[0;32m"
    YELLOW = "\033[1;33m"
    CYAN = "\033[0;36m"
    DIM = "\033[2m"
    BOLD = "\033[1m"
    NC = "\033[0m"


def log(msg):
    print(f"{C.CYAN}[E2E]{C.NC} {msg}")


def passed(msg):
    print(f"{C.GREEN}  ✓ {msg}{C.NC}")


def fail(msg):
    print(f"{C.RED}  ✗ {msg}{C.NC}")
    raise ScenarioFailed(msg)


def warn(msg):
    print(f"{C.YELLOW}  ⚠ {msg}{C.NC}")


def step(num, msg):
    print(f"\n{C.BOLD}  Step {num}: {msg}{C.NC}")


class ScenarioFailed(Exception):
    pass


# ═══════════════════════════════════════════════════════════════════════════════
# Test infrastructure
# ═══════════════════════════════════════════════════════════════════════════════


def poll_until(description, check_fn, max_attempts=30, interval=2):
    log(f"  Polling: {description} (max {max_attempts}x{interval}s)...")
    for i in range(1, max_attempts + 1):
        try:
            result = check_fn()
            if result:
                return result
        except Exception:
            pass
        time.sleep(interval)
    fail(f"Timed out polling: {description}")


def get_child_issues(parent_id):
    return api_get(f"/companies/{COMPANY_ID}/issues?parentId={parent_id}&limit=50")


def find_stage_issue(parent_id, stage_name):
    issues = get_child_issues(parent_id)
    for issue in issues:
        if f"[pipeline] {stage_name}" in issue.get("title", ""):
            return issue
    return None


def find_all_stage_issues(parent_id, stage_name):
    issues = get_child_issues(parent_id)
    matching = [i for i in issues if f"[pipeline] {stage_name}" in i.get("title", "")]
    matching.sort(key=lambda x: x.get("createdAt", ""))
    return matching


def find_latest_stage_issue(parent_id, stage_name, known_ids=None):
    """Find the most recently created stage issue, excluding known IDs."""
    issues = find_all_stage_issues(parent_id, stage_name)
    if known_ids:
        issues = [i for i in issues if i["id"] not in known_ids]
    return issues[-1] if issues else None


def post_mock_output(issue_id, output_key_or_dict):
    if isinstance(output_key_or_dict, str):
        output = MOCK_OUTPUTS[output_key_or_dict]
    else:
        output = output_key_or_dict

    comment_body = f"""{OUTPUT_SENTINEL}
```json
{json.dumps(output, indent=2)}
```"""

    result = api_post(f"/issues/{issue_id}/comments", {"body": comment_body})
    comment_id = result.get("id")
    if not comment_id:
        fail(f"Failed to post mock output on issue {issue_id}")
    return comment_id


def wait_for_stage(parent_id, stage_name, max_attempts=30, interval=2):
    stage = poll_until(
        f"stage '{stage_name}' dispatched",
        lambda: find_stage_issue(parent_id, stage_name),
        max_attempts=max_attempts,
        interval=interval,
    )
    return stage["id"]


def complete_stage(parent_id, stage_name, output_key, max_attempts=30, interval=2):
    stage_id = wait_for_stage(parent_id, stage_name, max_attempts, interval)
    post_mock_output(stage_id, output_key)
    passed(f"{stage_name} → {output_key}")
    return stage_id


# ═══════════════════════════════════════════════════════════════════════════════
# Agent pause/resume
# ═══════════════════════════════════════════════════════════════════════════════

paused_agent_ids: list = []


def pause_all_agents():
    global paused_agent_ids
    log("Pausing all agents to prevent interference...")
    agents = api_get(f"/companies/{COMPANY_ID}/agents")
    for agent in agents:
        if agent.get("status") != "paused":
            try:
                api_post(f"/agents/{agent['id']}/pause", {})
                paused_agent_ids.append(agent["id"])
                log(f"  Paused: {agent['name']} ({agent['id'][:8]}...)")
            except Exception as e:
                warn(f"  Could not pause {agent['name']}: {e}")
    passed(f"Paused {len(paused_agent_ids)} agent(s)")


def resume_all_agents():
    global paused_agent_ids
    if not paused_agent_ids:
        return
    log("Resuming agents...")
    for agent_id in paused_agent_ids:
        try:
            api_post(f"/agents/{agent_id}/resume", {})
        except Exception:
            pass
    log(f"  Resumed {len(paused_agent_ids)} agent(s)")
    paused_agent_ids = []


# ═══════════════════════════════════════════════════════════════════════════════
# Scenario state tracking
# ═══════════════════════════════════════════════════════════════════════════════


@dataclass
class ScenarioState:
    name: str
    parent_issue_id: str | None = None
    issue_ids: list = field(default_factory=list)
    run_id: str | None = None
    should_cleanup: bool = True

    def track_issue(self, issue_id):
        self.issue_ids.append(issue_id)

    def cleanup(self):
        if not self.should_cleanup:
            log(
                f"  Skipping cleanup (--no-cleanup). Parent issue: {self.parent_issue_id}"
            )
            return

        # Cancel any active run
        if self.run_id:
            try:
                api_post(
                    f"/plugins/{PLUGIN_ID}/actions/cancel-run",
                    {"params": {"runId": self.run_id}},
                )
            except Exception:
                pass

        # Delete issues (children first)
        for iid in reversed(self.issue_ids):
            try:
                api_delete(f"/issues/{iid}")
            except Exception:
                pass

        if self.issue_ids:
            log(f"  Cleaned up {len(self.issue_ids)} issue(s)")


def create_and_trigger(state: ScenarioState, title: str, pipeline_name=PIPELINE_NAME):
    issue_result = api_post(
        f"/companies/{COMPANY_ID}/issues",
        {
            "title": title,
            "description": f"E2E test scenario: {state.name}\nAutomated mock-agent test run.",
            "status": "todo",
            "priority": "low",
        },
    )
    parent_id = issue_result["id"]
    state.parent_issue_id = parent_id
    state.track_issue(parent_id)

    trigger_result = api_post(
        f"/plugins/{PLUGIN_ID}/actions/trigger-run",
        {
            "params": {
                "companyId": COMPANY_ID,
                "issueId": parent_id,
                "pipelineName": pipeline_name,
            }
        },
    )
    if not trigger_result.get("data", {}).get("success"):
        fail(f"trigger-run failed: {trigger_result}")

    return parent_id


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO: Full feature happy path (autonomous-dev)
# ═══════════════════════════════════════════════════════════════════════════════


def scenario_full_feature_happy_path(state: ScenarioState):
    """Complete feature flow: triage→scenario→spec→plan→impl→PR→CI→reviews→simplify→validate"""

    step(1, "Create issue and trigger pipeline")
    parent_id = create_and_trigger(
        state, "[E2E] Full feature: Add user notification preferences API"
    )
    log(f"  Parent issue: {parent_id}")

    step(2, "Triage → feature")
    complete_stage(parent_id, "triage", "triage-feature")

    step(3, "Validate scenario → yes")
    complete_stage(parent_id, "valid-scenario", "validate-scenario-yes")

    step(4, "Create spec → done")
    complete_stage(parent_id, "create-spec", "create-spec")

    step(5, "Validate spec → yes")
    complete_stage(parent_id, "valid-spec", "validate-spec-yes")

    step(6, "Plan tasks → backend + frontend")
    complete_stage(parent_id, "plan-tasks", "plan-tasks-both")

    step(7, "Backend track: tests → impl → de-slop")
    complete_stage(parent_id, "write-backend-tests", "write-tests")
    complete_stage(parent_id, "write-backend-impl", "write-implementation")
    complete_stage(parent_id, "de-slop-backend", "de-slop-verify")

    step(8, "Frontend track: tests → impl → de-slop")
    complete_stage(parent_id, "write-frontend-tests", "write-tests")
    complete_stage(parent_id, "write-frontend-impl", "write-implementation")
    complete_stage(parent_id, "de-slop-frontend", "de-slop-verify")

    step(9, "Open PR → done")
    complete_stage(parent_id, "open-pr", "open-pr")

    step(10, "Check CI → pass")
    complete_stage(parent_id, "check-ci", "check-ci-pass")

    step(11, "Dispatch reviews (full)")
    complete_stage(parent_id, "dispatch-reviews", "dispatch-reviews-full")

    step(12, "Complete all 7 reviews → approved")
    review_stages = [
        "review-code-quality",
        "review-error-handling",
        "review-test-coverage",
        "review-comments",
        "review-type-design",
        "review-architecture",
        "review-blind-validation",
    ]
    for review_name in review_stages:
        complete_stage(parent_id, review_name, "review-approved")

    step(13, "Evaluate findings → pass")
    complete_stage(parent_id, "evaluate-findings", "evaluate-findings-pass")

    step(14, "Simplify code → done")
    complete_stage(parent_id, "simplify-code", "simplify-code")

    step(15, "Scenario validator → valid")
    complete_stage(parent_id, "scenario-validator", "validate-scenario-result-valid")

    step(16, "Verify pipeline completed")
    final_status = poll_until(
        "parent issue marked done",
        lambda: api_get(f"/issues/{parent_id}").get("status") == "done" or None,
        max_attempts=20,
        interval=2,
    )
    passed("Pipeline completed — parent issue marked done")


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO: Feature with CI failure and retry
# ═══════════════════════════════════════════════════════════════════════════════


def scenario_ci_failure_retry(state: ScenarioState):
    """Feature flow where CI fails, gets fixed, then passes on retry"""

    step(1, "Create issue and trigger")
    parent_id = create_and_trigger(
        state, "[E2E] CI retry: Fix broken build after implementation"
    )

    step(2, "Triage → feature → scenario → spec → plan (backend only)")
    complete_stage(parent_id, "triage", "triage-feature")
    complete_stage(parent_id, "valid-scenario", "validate-scenario-yes")
    complete_stage(parent_id, "create-spec", "create-spec")
    complete_stage(parent_id, "valid-spec", "validate-spec-yes")
    complete_stage(parent_id, "plan-tasks", "plan-tasks-backend-only")

    step(3, "Backend track: tests → impl → de-slop")
    complete_stage(parent_id, "write-backend-tests", "write-tests")
    complete_stage(parent_id, "write-backend-impl", "write-implementation")
    complete_stage(parent_id, "de-slop-backend", "de-slop-verify")

    step(4, "Open PR → done")
    complete_stage(parent_id, "open-pr", "open-pr")

    step(5, "Check CI → FAIL backend (first attempt)")
    first_ci_id = complete_stage(parent_id, "check-ci", "check-ci-fail-backend")

    step(6, "Fix CI backend → done")
    complete_stage(parent_id, "fix-ci-backend", "fix-ci")

    step(7, "Check CI → pass (second attempt, after loop)")
    # ci-fix-sync fan_in auto-completes, then outgoing loop resets check-ci
    second_ci = poll_until(
        "second check-ci dispatch",
        lambda: find_latest_stage_issue(parent_id, "check-ci", known_ids={first_ci_id}),
        max_attempts=25,
        interval=2,
    )
    post_mock_output(second_ci["id"], "check-ci-pass")
    passed("check-ci (attempt 2) → pass")

    step(8, "Reviews → all approved → evaluate → simplify → validate")
    complete_stage(parent_id, "dispatch-reviews", "dispatch-reviews-minimal")
    complete_stage(parent_id, "review-code-quality", "review-approved")
    complete_stage(parent_id, "review-test-coverage", "review-approved")
    complete_stage(parent_id, "evaluate-findings", "evaluate-findings-pass")
    complete_stage(parent_id, "simplify-code", "simplify-code")
    complete_stage(parent_id, "scenario-validator", "validate-scenario-result-valid")

    step(9, "Verify pipeline completed")
    poll_until(
        "parent done",
        lambda: api_get(f"/issues/{parent_id}").get("status") == "done" or None,
        max_attempts=20,
        interval=2,
    )
    passed("Pipeline completed after CI retry loop")


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO: Review findings loop back to implementation
# ═══════════════════════════════════════════════════════════════════════════════


def scenario_review_revision_loop(state: ScenarioState):
    """Reviews find critical issues → loop back to write-backend-impl → re-review → pass"""

    step(1, "Create issue and trigger")
    parent_id = create_and_trigger(
        state, "[E2E] Review loop: Critical findings trigger revision"
    )

    step(2, "Fast-path to reviews (triage→scenario→spec→plan→impl→PR→CI)")
    complete_stage(parent_id, "triage", "triage-feature")
    complete_stage(parent_id, "valid-scenario", "validate-scenario-yes")
    complete_stage(parent_id, "create-spec", "create-spec")
    complete_stage(parent_id, "valid-spec", "validate-spec-yes")
    complete_stage(parent_id, "plan-tasks", "plan-tasks-backend-only")
    complete_stage(parent_id, "write-backend-tests", "write-tests")
    complete_stage(parent_id, "write-backend-impl", "write-implementation")
    complete_stage(parent_id, "de-slop-backend", "de-slop-verify")
    complete_stage(parent_id, "open-pr", "open-pr")
    complete_stage(parent_id, "check-ci", "check-ci-pass")

    step(3, "Dispatch reviews (minimal) → code-quality finds critical issue")
    complete_stage(parent_id, "dispatch-reviews", "dispatch-reviews-minimal")
    complete_stage(parent_id, "review-code-quality", "review-needs-revision")
    complete_stage(parent_id, "review-test-coverage", "review-approved")

    step(4, "Evaluate findings → fail-impl (loops back to write-backend-impl)")
    complete_stage(parent_id, "evaluate-findings", "evaluate-findings-fail")

    step(5, "Write backend impl (revision pass) → de-slop → PR → CI → reviews again")
    # The loop goes back to write-backend-impl
    time.sleep(3)
    impl_issues = find_all_stage_issues(parent_id, "write-backend-impl")
    if len(impl_issues) < 2:
        revision_impl = poll_until(
            "write-backend-impl revision dispatch",
            lambda: find_all_stage_issues(parent_id, "write-backend-impl")[1]
            if len(find_all_stage_issues(parent_id, "write-backend-impl")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        revision_impl_id = revision_impl["id"]
    else:
        revision_impl_id = impl_issues[1]["id"]

    post_mock_output(revision_impl_id, "write-implementation")
    passed("write-backend-impl (revision) → done")

    # After revision: de-slop → sync → PR → CI → reviews → evaluate
    step(6, "Complete post-revision flow → pipeline done")
    deslop_issues = find_all_stage_issues(parent_id, "de-slop-backend")
    if len(deslop_issues) < 2:
        deslop2 = poll_until(
            "de-slop-backend revision",
            lambda: find_all_stage_issues(parent_id, "de-slop-backend")[1]
            if len(find_all_stage_issues(parent_id, "de-slop-backend")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        deslop2_id = deslop2["id"]
    else:
        deslop2_id = deslop_issues[1]["id"]
    post_mock_output(deslop2_id, "de-slop-verify")
    passed("de-slop-backend (revision) → done")

    # open-pr (revision)
    pr_issues = find_all_stage_issues(parent_id, "open-pr")
    if len(pr_issues) < 2:
        pr2 = poll_until(
            "open-pr revision",
            lambda: find_all_stage_issues(parent_id, "open-pr")[1]
            if len(find_all_stage_issues(parent_id, "open-pr")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        pr2_id = pr2["id"]
    else:
        pr2_id = pr_issues[1]["id"]
    post_mock_output(pr2_id, "open-pr")
    passed("open-pr (revision) → done")

    # check-ci (revision)
    ci_issues = find_all_stage_issues(parent_id, "check-ci")
    if len(ci_issues) < 2:
        ci2 = poll_until(
            "check-ci revision",
            lambda: find_all_stage_issues(parent_id, "check-ci")[1]
            if len(find_all_stage_issues(parent_id, "check-ci")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        ci2_id = ci2["id"]
    else:
        ci2_id = ci_issues[1]["id"]
    post_mock_output(ci2_id, "check-ci-pass")
    passed("check-ci (revision) → pass")

    # dispatch-reviews (revision)
    dr_issues = find_all_stage_issues(parent_id, "dispatch-reviews")
    if len(dr_issues) < 2:
        dr2 = poll_until(
            "dispatch-reviews revision",
            lambda: find_all_stage_issues(parent_id, "dispatch-reviews")[1]
            if len(find_all_stage_issues(parent_id, "dispatch-reviews")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        dr2_id = dr2["id"]
    else:
        dr2_id = dr_issues[1]["id"]
    post_mock_output(dr2_id, "dispatch-reviews-minimal")
    passed("dispatch-reviews (revision) → minimal")

    # reviews (revision) — all pass this time
    rq_issues = find_all_stage_issues(parent_id, "review-code-quality")
    if len(rq_issues) < 2:
        rq2 = poll_until(
            "review-code-quality revision",
            lambda: find_all_stage_issues(parent_id, "review-code-quality")[1]
            if len(find_all_stage_issues(parent_id, "review-code-quality")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        rq2_id = rq2["id"]
    else:
        rq2_id = rq_issues[1]["id"]
    post_mock_output(rq2_id, "review-approved")
    passed("review-code-quality (revision) → approved")

    rtc_issues = find_all_stage_issues(parent_id, "review-test-coverage")
    if len(rtc_issues) < 2:
        rtc2 = poll_until(
            "review-test-coverage revision",
            lambda: find_all_stage_issues(parent_id, "review-test-coverage")[1]
            if len(find_all_stage_issues(parent_id, "review-test-coverage")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        rtc2_id = rtc2["id"]
    else:
        rtc2_id = rtc_issues[1]["id"]
    post_mock_output(rtc2_id, "review-approved")
    passed("review-test-coverage (revision) → approved")

    # evaluate-findings (revision)
    ef_issues = find_all_stage_issues(parent_id, "evaluate-findings")
    if len(ef_issues) < 2:
        ef2 = poll_until(
            "evaluate-findings revision",
            lambda: find_all_stage_issues(parent_id, "evaluate-findings")[1]
            if len(find_all_stage_issues(parent_id, "evaluate-findings")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        ef2_id = ef2["id"]
    else:
        ef2_id = ef_issues[1]["id"]
    post_mock_output(ef2_id, "evaluate-findings-pass")
    passed("evaluate-findings (revision) → pass")

    # simplify (revision)
    sc_issues = find_all_stage_issues(parent_id, "simplify-code")
    if len(sc_issues) < 2:
        sc2 = poll_until(
            "simplify-code revision",
            lambda: find_all_stage_issues(parent_id, "simplify-code")[1]
            if len(find_all_stage_issues(parent_id, "simplify-code")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        sc2_id = sc2["id"]
    else:
        sc2_id = sc_issues[1]["id"]
    post_mock_output(sc2_id, "simplify-code")
    passed("simplify-code (revision) → done")

    # scenario-validator (revision)
    sv_issues = find_all_stage_issues(parent_id, "scenario-validator")
    if len(sv_issues) < 2:
        sv2 = poll_until(
            "scenario-validator revision",
            lambda: find_all_stage_issues(parent_id, "scenario-validator")[1]
            if len(find_all_stage_issues(parent_id, "scenario-validator")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        sv2_id = sv2["id"]
    else:
        sv2_id = sv_issues[1]["id"]
    post_mock_output(sv2_id, "validate-scenario-result-valid")
    passed("scenario-validator (revision) → valid")

    poll_until(
        "parent done",
        lambda: api_get(f"/issues/{parent_id}").get("status") == "done" or None,
        max_attempts=20,
        interval=2,
    )
    passed("Pipeline completed after review revision loop")


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO: Scenario validator loops back to frontend impl
# ═══════════════════════════════════════════════════════════════════════════════


def scenario_validator_frontend_fix(state: ScenarioState):
    """Validator says not-valid-frontend → loops back to write-frontend-impl → passes on retry"""

    step(1, "Create issue and trigger")
    parent_id = create_and_trigger(
        state, "[E2E] Validator loop: Frontend fix after validation failure"
    )

    step(2, "Fast-path to validator (full pipeline minus reviews details)")
    complete_stage(parent_id, "triage", "triage-feature")
    complete_stage(parent_id, "valid-scenario", "validate-scenario-yes")
    complete_stage(parent_id, "create-spec", "create-spec")
    complete_stage(parent_id, "valid-spec", "validate-spec-yes")
    complete_stage(parent_id, "plan-tasks", "plan-tasks-both")

    # Both tracks
    complete_stage(parent_id, "write-backend-tests", "write-tests")
    complete_stage(parent_id, "write-backend-impl", "write-implementation")
    complete_stage(parent_id, "de-slop-backend", "de-slop-verify")
    complete_stage(parent_id, "write-frontend-tests", "write-tests")
    complete_stage(parent_id, "write-frontend-impl", "write-implementation")
    complete_stage(parent_id, "de-slop-frontend", "de-slop-verify")

    complete_stage(parent_id, "open-pr", "open-pr")
    complete_stage(parent_id, "check-ci", "check-ci-pass")
    complete_stage(parent_id, "dispatch-reviews", "dispatch-reviews-minimal")
    complete_stage(parent_id, "review-code-quality", "review-approved")
    complete_stage(parent_id, "review-test-coverage", "review-approved")
    complete_stage(parent_id, "evaluate-findings", "evaluate-findings-pass")
    complete_stage(parent_id, "simplify-code", "simplify-code")

    step(3, "Scenario validator → not-valid-frontend (triggers loop)")
    complete_stage(
        parent_id, "scenario-validator", "validate-scenario-result-not-valid-frontend"
    )

    step(4, "Write frontend impl (fix pass)")
    time.sleep(3)
    fe_impl_issues = find_all_stage_issues(parent_id, "write-frontend-impl")
    if len(fe_impl_issues) < 2:
        fe_fix = poll_until(
            "write-frontend-impl fix dispatch",
            lambda: find_all_stage_issues(parent_id, "write-frontend-impl")[1]
            if len(find_all_stage_issues(parent_id, "write-frontend-impl")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        fe_fix_id = fe_fix["id"]
    else:
        fe_fix_id = fe_impl_issues[1]["id"]
    post_mock_output(fe_fix_id, "write-implementation")
    passed("write-frontend-impl (fix) → done")

    step(5, "Complete post-fix flow → pipeline done")
    # de-slop-frontend (fix)
    deslop_issues = find_all_stage_issues(parent_id, "de-slop-frontend")
    if len(deslop_issues) < 2:
        deslop2 = poll_until(
            "de-slop-frontend fix",
            lambda: find_all_stage_issues(parent_id, "de-slop-frontend")[1]
            if len(find_all_stage_issues(parent_id, "de-slop-frontend")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        deslop2_id = deslop2["id"]
    else:
        deslop2_id = deslop_issues[1]["id"]
    post_mock_output(deslop2_id, "de-slop-verify")
    passed("de-slop-frontend (fix) → done")

    # open-pr (fix)
    pr_issues = find_all_stage_issues(parent_id, "open-pr")
    if len(pr_issues) < 2:
        pr2 = poll_until(
            "open-pr fix",
            lambda: find_all_stage_issues(parent_id, "open-pr")[1]
            if len(find_all_stage_issues(parent_id, "open-pr")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        pr2_id = pr2["id"]
    else:
        pr2_id = pr_issues[1]["id"]
    post_mock_output(pr2_id, "open-pr")
    passed("open-pr (fix) → done")

    # check-ci (fix)
    ci_issues = find_all_stage_issues(parent_id, "check-ci")
    if len(ci_issues) < 2:
        ci2 = poll_until(
            "check-ci fix",
            lambda: find_all_stage_issues(parent_id, "check-ci")[1]
            if len(find_all_stage_issues(parent_id, "check-ci")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        ci2_id = ci2["id"]
    else:
        ci2_id = ci_issues[1]["id"]
    post_mock_output(ci2_id, "check-ci-pass")
    passed("check-ci (fix) → pass")

    # dispatch-reviews (fix)
    dr_issues = find_all_stage_issues(parent_id, "dispatch-reviews")
    if len(dr_issues) < 2:
        dr2 = poll_until(
            "dispatch-reviews fix",
            lambda: find_all_stage_issues(parent_id, "dispatch-reviews")[1]
            if len(find_all_stage_issues(parent_id, "dispatch-reviews")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        dr2_id = dr2["id"]
    else:
        dr2_id = dr_issues[1]["id"]
    post_mock_output(dr2_id, "dispatch-reviews-minimal")
    passed("dispatch-reviews (fix) → minimal")

    # reviews (fix)
    rq_issues = find_all_stage_issues(parent_id, "review-code-quality")
    if len(rq_issues) < 2:
        rq2 = poll_until(
            "review-code-quality fix",
            lambda: find_all_stage_issues(parent_id, "review-code-quality")[1]
            if len(find_all_stage_issues(parent_id, "review-code-quality")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        rq2_id = rq2["id"]
    else:
        rq2_id = rq_issues[1]["id"]
    post_mock_output(rq2_id, "review-approved")

    rtc_issues = find_all_stage_issues(parent_id, "review-test-coverage")
    if len(rtc_issues) < 2:
        rtc2 = poll_until(
            "review-test-coverage fix",
            lambda: find_all_stage_issues(parent_id, "review-test-coverage")[1]
            if len(find_all_stage_issues(parent_id, "review-test-coverage")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        rtc2_id = rtc2["id"]
    else:
        rtc2_id = rtc_issues[1]["id"]
    post_mock_output(rtc2_id, "review-approved")

    # evaluate-findings (fix)
    ef_issues = find_all_stage_issues(parent_id, "evaluate-findings")
    if len(ef_issues) < 2:
        ef2 = poll_until(
            "evaluate-findings fix",
            lambda: find_all_stage_issues(parent_id, "evaluate-findings")[1]
            if len(find_all_stage_issues(parent_id, "evaluate-findings")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        ef2_id = ef2["id"]
    else:
        ef2_id = ef_issues[1]["id"]
    post_mock_output(ef2_id, "evaluate-findings-pass")

    # simplify (fix)
    sc_issues = find_all_stage_issues(parent_id, "simplify-code")
    if len(sc_issues) < 2:
        sc2 = poll_until(
            "simplify-code fix",
            lambda: find_all_stage_issues(parent_id, "simplify-code")[1]
            if len(find_all_stage_issues(parent_id, "simplify-code")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        sc2_id = sc2["id"]
    else:
        sc2_id = sc_issues[1]["id"]
    post_mock_output(sc2_id, "simplify-code")

    # scenario-validator (fix) — this time it passes
    sv_issues = find_all_stage_issues(parent_id, "scenario-validator")
    if len(sv_issues) < 2:
        sv2 = poll_until(
            "scenario-validator fix",
            lambda: find_all_stage_issues(parent_id, "scenario-validator")[1]
            if len(find_all_stage_issues(parent_id, "scenario-validator")) >= 2
            else None,
            max_attempts=25,
            interval=2,
        )
        sv2_id = sv2["id"]
    else:
        sv2_id = sv_issues[1]["id"]
    post_mock_output(sv2_id, "validate-scenario-result-valid")
    passed("scenario-validator (fix) → valid")

    poll_until(
        "parent done",
        lambda: api_get(f"/issues/{parent_id}").get("status") == "done" or None,
        max_attempts=20,
        interval=2,
    )
    passed("Pipeline completed after validator frontend fix loop")


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO: Conditional routing — scenario rejected → escalate
# ═══════════════════════════════════════════════════════════════════════════════


def scenario_escalate_no_scenario(state: ScenarioState):
    """Triage→feature, validate-scenario→no → escalate-scenario (block)"""

    step(1, "Create issue and trigger")
    parent_id = create_and_trigger(state, "[E2E] Escalate: No holdout scenario found")

    step(2, "Triage → feature")
    complete_stage(parent_id, "triage", "triage-feature")

    step(3, "Validate scenario → no (should route to escalate-scenario block)")
    complete_stage(parent_id, "valid-scenario", "validate-scenario-no")

    step(4, "Verify pipeline is blocked/escalated (escalate-scenario is a block node)")
    time.sleep(5)
    parent = api_get(f"/issues/{parent_id}")
    status = parent.get("status")
    # Block nodes should escalate or pause the pipeline
    if status == "done":
        fail("Pipeline should NOT be done — escalate-scenario should block it")
    passed(f"Pipeline correctly blocked — parent status: {status}")


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO: Spec validation fails → escalate
# ═══════════════════════════════════════════════════════════════════════════════


def scenario_escalate_bad_spec(state: ScenarioState):
    """Feature path where spec validation fails → escalate-spec block"""

    step(1, "Create issue and trigger")
    parent_id = create_and_trigger(state, "[E2E] Escalate: Spec validation fails")

    step(2, "Triage → feature → scenario yes → create spec")
    complete_stage(parent_id, "triage", "triage-feature")
    complete_stage(parent_id, "valid-scenario", "validate-scenario-yes")
    complete_stage(parent_id, "create-spec", "create-spec")

    step(3, "Validate spec → no (should route to escalate-spec block)")
    complete_stage(parent_id, "valid-spec", "validate-spec-no")

    step(4, "Verify pipeline is blocked")
    time.sleep(5)
    parent = api_get(f"/issues/{parent_id}")
    status = parent.get("status")
    if status == "done":
        fail("Pipeline should NOT be done — escalate-spec should block it")
    passed(f"Pipeline correctly blocked — parent status: {status}")


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO: Backend-only feature (no frontend track)
# ═══════════════════════════════════════════════════════════════════════════════


def scenario_backend_only(state: ScenarioState):
    """Plan outputs only backend track — frontend stages should be skipped"""

    step(1, "Create issue and trigger")
    parent_id = create_and_trigger(
        state, "[E2E] Backend-only: API endpoint with no UI changes"
    )

    step(2, "Triage → feature → scenario → spec → plan (backend only)")
    complete_stage(parent_id, "triage", "triage-feature")
    complete_stage(parent_id, "valid-scenario", "validate-scenario-yes")
    complete_stage(parent_id, "create-spec", "create-spec")
    complete_stage(parent_id, "valid-spec", "validate-spec-yes")
    complete_stage(parent_id, "plan-tasks", "plan-tasks-backend-only")

    step(3, "Backend track only: tests → impl → de-slop")
    complete_stage(parent_id, "write-backend-tests", "write-tests")
    complete_stage(parent_id, "write-backend-impl", "write-implementation")
    complete_stage(parent_id, "de-slop-backend", "de-slop-verify")

    step(4, "Open PR → CI → reviews → evaluate → simplify → validate")
    complete_stage(parent_id, "open-pr", "open-pr")
    complete_stage(parent_id, "check-ci", "check-ci-pass")
    complete_stage(parent_id, "dispatch-reviews", "dispatch-reviews-minimal")
    complete_stage(parent_id, "review-code-quality", "review-approved")
    complete_stage(parent_id, "review-test-coverage", "review-approved")
    complete_stage(parent_id, "evaluate-findings", "evaluate-findings-pass")
    complete_stage(parent_id, "simplify-code", "simplify-code")
    complete_stage(parent_id, "scenario-validator", "validate-scenario-result-valid")

    step(5, "Verify pipeline completed (frontend track skipped)")
    poll_until(
        "parent done",
        lambda: api_get(f"/issues/{parent_id}").get("status") == "done" or None,
        max_attempts=20,
        interval=2,
    )

    # Verify frontend stages were NOT dispatched
    fe_tests = find_stage_issue(parent_id, "write-frontend-tests")
    fe_impl = find_stage_issue(parent_id, "write-frontend-impl")
    if fe_tests or fe_impl:
        warn("Frontend stages exist but should have been skipped")
    else:
        passed("Frontend track correctly skipped")

    passed("Backend-only pipeline completed successfully")


# ═══════════════════════════════════════════════════════════════════════════════
# SCENARIO: Validator overflow → escalate-validation
# ═══════════════════════════════════════════════════════════════════════════════


def scenario_validator_overflow(state: ScenarioState):
    """Validator fails max_iterations times → escalate-validation block"""

    step(1, "Create issue and trigger")
    parent_id = create_and_trigger(
        state, "[E2E] Overflow: Validator exceeds max iterations"
    )

    step(2, "Fast-path to validator")
    complete_stage(parent_id, "triage", "triage-feature")
    complete_stage(parent_id, "valid-scenario", "validate-scenario-yes")
    complete_stage(parent_id, "create-spec", "create-spec")
    complete_stage(parent_id, "valid-spec", "validate-spec-yes")
    complete_stage(parent_id, "plan-tasks", "plan-tasks-backend-only")
    complete_stage(parent_id, "write-backend-tests", "write-tests")
    complete_stage(parent_id, "write-backend-impl", "write-implementation")
    complete_stage(parent_id, "de-slop-backend", "de-slop-verify")
    complete_stage(parent_id, "open-pr", "open-pr")
    complete_stage(parent_id, "check-ci", "check-ci-pass")
    complete_stage(parent_id, "dispatch-reviews", "dispatch-reviews-minimal")
    complete_stage(parent_id, "review-code-quality", "review-approved")
    complete_stage(parent_id, "review-test-coverage", "review-approved")
    complete_stage(parent_id, "evaluate-findings", "evaluate-findings-pass")
    complete_stage(parent_id, "simplify-code", "simplify-code")

    step(3, "Validator → not-valid-backend (attempt 1)")
    complete_stage(
        parent_id, "scenario-validator", "validate-scenario-result-not-valid-backend"
    )

    step(4, "Complete backend fix loop (attempt 1)")
    time.sleep(3)
    impl_issues = find_all_stage_issues(parent_id, "write-backend-impl")
    fix1 = poll_until(
        "write-backend-impl fix 1",
        lambda: find_all_stage_issues(parent_id, "write-backend-impl")[1]
        if len(find_all_stage_issues(parent_id, "write-backend-impl")) >= 2
        else None,
        max_attempts=25,
        interval=2,
    )
    post_mock_output(fix1["id"], "write-implementation")

    # de-slop → sync → PR → CI → reviews → evaluate → simplify
    deslop2 = poll_until(
        "de-slop-backend fix 1",
        lambda: find_all_stage_issues(parent_id, "de-slop-backend")[1]
        if len(find_all_stage_issues(parent_id, "de-slop-backend")) >= 2
        else None,
        max_attempts=25,
        interval=2,
    )
    post_mock_output(deslop2["id"], "de-slop-verify")

    pr2 = poll_until(
        "open-pr fix 1",
        lambda: find_all_stage_issues(parent_id, "open-pr")[1]
        if len(find_all_stage_issues(parent_id, "open-pr")) >= 2
        else None,
        max_attempts=25,
        interval=2,
    )
    post_mock_output(pr2["id"], "open-pr")

    ci2 = poll_until(
        "check-ci fix 1",
        lambda: find_all_stage_issues(parent_id, "check-ci")[1]
        if len(find_all_stage_issues(parent_id, "check-ci")) >= 2
        else None,
        max_attempts=25,
        interval=2,
    )
    post_mock_output(ci2["id"], "check-ci-pass")

    dr2 = poll_until(
        "dispatch-reviews fix 1",
        lambda: find_all_stage_issues(parent_id, "dispatch-reviews")[1]
        if len(find_all_stage_issues(parent_id, "dispatch-reviews")) >= 2
        else None,
        max_attempts=25,
        interval=2,
    )
    post_mock_output(dr2["id"], "dispatch-reviews-minimal")

    rq2 = poll_until(
        "review-code-quality fix 1",
        lambda: find_all_stage_issues(parent_id, "review-code-quality")[1]
        if len(find_all_stage_issues(parent_id, "review-code-quality")) >= 2
        else None,
        max_attempts=25,
        interval=2,
    )
    post_mock_output(rq2["id"], "review-approved")

    rtc2 = poll_until(
        "review-test-coverage fix 1",
        lambda: find_all_stage_issues(parent_id, "review-test-coverage")[1]
        if len(find_all_stage_issues(parent_id, "review-test-coverage")) >= 2
        else None,
        max_attempts=25,
        interval=2,
    )
    post_mock_output(rtc2["id"], "review-approved")

    ef2 = poll_until(
        "evaluate-findings fix 1",
        lambda: find_all_stage_issues(parent_id, "evaluate-findings")[1]
        if len(find_all_stage_issues(parent_id, "evaluate-findings")) >= 2
        else None,
        max_attempts=25,
        interval=2,
    )
    post_mock_output(ef2["id"], "evaluate-findings-pass")

    sc2 = poll_until(
        "simplify-code fix 1",
        lambda: find_all_stage_issues(parent_id, "simplify-code")[1]
        if len(find_all_stage_issues(parent_id, "simplify-code")) >= 2
        else None,
        max_attempts=25,
        interval=2,
    )
    post_mock_output(sc2["id"], "simplify-code")

    step(5, "Validator → not-valid-backend AGAIN (attempt 2 = max_iterations)")
    sv2 = poll_until(
        "scenario-validator attempt 2",
        lambda: find_all_stage_issues(parent_id, "scenario-validator")[1]
        if len(find_all_stage_issues(parent_id, "scenario-validator")) >= 2
        else None,
        max_attempts=25,
        interval=2,
    )
    post_mock_output(sv2["id"], "validate-scenario-result-not-valid-backend")

    step(6, "Verify pipeline escalated (max_iterations=2 exhausted)")
    time.sleep(5)
    parent = api_get(f"/issues/{parent_id}")
    status = parent.get("status")
    if status == "done":
        fail("Pipeline should NOT be done — should have escalated due to overflow")
    passed(f"Pipeline correctly escalated after validator overflow — status: {status}")


# ═══════════════════════════════════════════════════════════════════════════════
# CLI + Main
# ═══════════════════════════════════════════════════════════════════════════════

ALL_SCENARIOS = [
    (
        "full-feature-happy-path",
        "Full feature flow (all stages, happy path)",
        scenario_full_feature_happy_path,
    ),
    (
        "ci-failure-retry",
        "CI fails → fix → retry loop → pass",
        scenario_ci_failure_retry,
    ),
    (
        "review-revision-loop",
        "Reviews find critical issues → revision loop → pass",
        scenario_review_revision_loop,
    ),
    (
        "validator-frontend-fix",
        "Validator says not-valid-frontend → fix loop → pass",
        scenario_validator_frontend_fix,
    ),
    (
        "escalate-no-scenario",
        "No holdout scenario → escalate block",
        scenario_escalate_no_scenario,
    ),
    (
        "escalate-bad-spec",
        "Spec validation fails → escalate block",
        scenario_escalate_bad_spec,
    ),
    (
        "backend-only",
        "Backend-only plan → frontend skipped",
        scenario_backend_only,
    ),
    (
        "validator-overflow",
        "Validator exceeds max_iterations → escalate",
        scenario_validator_overflow,
    ),
]


def run_scenario(name, description, fn, no_cleanup=False):
    state = ScenarioState(name=name, should_cleanup=not no_cleanup)
    print()
    print(f"{C.BOLD}{C.CYAN}{'═' * 70}{C.NC}")
    print(f"{C.BOLD}{C.CYAN}  SCENARIO: {description}{C.NC}")
    print(f"{C.BOLD}{C.CYAN}{'═' * 70}{C.NC}")

    try:
        fn(state)
        print(f"\n{C.GREEN}  ✓ PASSED: {description}{C.NC}")
        return True
    except ScenarioFailed as e:
        print(f"\n{C.RED}  ✗ FAILED: {description}{C.NC}")
        print(f"{C.RED}    Reason: {e}{C.NC}")
        return False
    except Exception as e:
        print(f"\n{C.RED}  ✗ ERROR: {description}{C.NC}")
        print(f"{C.RED}    {type(e).__name__}: {e}{C.NC}")
        return False
    finally:
        state.cleanup()


def main():
    parser = argparse.ArgumentParser(
        description="E2E Pipeline Engine tests with mock agent outputs"
    )
    parser.add_argument(
        "--scenario",
        "-s",
        help="Run only scenarios matching this substring (e.g. 'happy', 'ci', 'validator')",
    )
    parser.add_argument(
        "--no-cleanup",
        action="store_true",
        help="Leave test artifacts in the UI for inspection",
    )
    parser.add_argument(
        "--cleanup-only",
        action="store_true",
        help="Clean up issues from a previous --no-cleanup run (by title prefix)",
    )
    parser.add_argument(
        "--list", "-l", action="store_true", help="List available scenarios and exit"
    )
    args = parser.parse_args()

    if args.list:
        print(f"\n{C.BOLD}Available scenarios:{C.NC}\n")
        for key, desc, _ in ALL_SCENARIOS:
            print(f"  {C.CYAN}{key:30s}{C.NC} {desc}")
        print(f"\n  Use --scenario <substring> to filter.\n")
        return

    if args.cleanup_only:
        log("Cleaning up E2E test issues...")
        issues = api_get(f"/companies/{COMPANY_ID}/issues?limit=100")
        e2e_issues = [i for i in issues if i.get("title", "").startswith("[E2E]")]
        for issue in e2e_issues:
            # Delete children first
            children = get_child_issues(issue["id"])
            for child in children:
                api_delete(f"/issues/{child['id']}")
            api_delete(f"/issues/{issue['id']}")
            log(f"  Deleted: {issue['title']}")
        log(f"  Cleaned up {len(e2e_issues)} E2E issue(s)")
        return

    # Prerequisites
    log("Checking prerequisites...")
    try:
        health = api_get("/health")
        log(f"  Server version: {health.get('version', 'unknown')}")
    except Exception as e:
        print(f"{C.RED}Server not reachable: {e}{C.NC}")
        sys.exit(1)

    plugins = api_get("/plugins")
    plugin = next((p for p in plugins if p["id"] == PLUGIN_ID), None)
    if not plugin or plugin["status"] != "ready":
        print(
            f"{C.RED}Pipeline engine plugin not ready (status={plugin['status'] if plugin else 'NOT FOUND'}){C.NC}"
        )
        sys.exit(1)
    passed("Prerequisites OK")

    # Pause agents
    pause_all_agents()

    # Run scenarios
    scenarios_to_run = ALL_SCENARIOS
    if args.scenario:
        scenarios_to_run = [
            (k, d, f)
            for k, d, f in ALL_SCENARIOS
            if args.scenario.lower() in k.lower() or args.scenario.lower() in d.lower()
        ]
        if not scenarios_to_run:
            print(f"{C.RED}No scenarios match '{args.scenario}'{C.NC}")
            resume_all_agents()
            sys.exit(1)

    results = []
    try:
        for key, desc, fn in scenarios_to_run:
            results.append(run_scenario(key, desc, fn, no_cleanup=args.no_cleanup))
    finally:
        resume_all_agents()

    # Summary
    print()
    print(f"{C.BOLD}{'═' * 70}{C.NC}")
    total = len(results)
    passed_count = sum(results)
    failed_count = total - passed_count
    if failed_count == 0:
        print(f"{C.GREEN}{C.BOLD}  ALL {total} SCENARIOS PASSED{C.NC}")
    else:
        print(f"{C.RED}{C.BOLD}  {failed_count}/{total} SCENARIOS FAILED{C.NC}")
        for i, (key, desc, _) in enumerate(scenarios_to_run):
            status = f"{C.GREEN}✓{C.NC}" if results[i] else f"{C.RED}✗{C.NC}"
            print(f"    {status} {desc}")
    print(f"{C.BOLD}{'═' * 70}{C.NC}")
    print()

    sys.exit(0 if failed_count == 0 else 1)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n{C.YELLOW}Interrupted. Resuming agents...{C.NC}")
        resume_all_agents()
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as e:
        print(f"{C.RED}Unexpected error: {e}{C.NC}")
        resume_all_agents()
        sys.exit(1)
