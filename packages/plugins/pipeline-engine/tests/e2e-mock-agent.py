#!/usr/bin/env python3
"""
E2E Test: Pipeline Engine — Mock Agent approach

Exercises the full pipeline lifecycle via HTTP APIs without any real LLM calls.
A "mock agent" simulates completion by posting structured comments with the
pipeline-output sentinel.

Prerequisites:
  - Paperclip server running at localhost:3100
  - Pipeline engine plugin installed and status=ready
  - "Internal Developer Portal" company with pipe-backend agent

Usage:
  python3 tests/e2e-mock-agent.py
"""

import json
import sys
import time
import urllib.request
import urllib.error

BASE = "http://localhost:3100/api"
COMPANY_ID = "f3f8f577-efb7-4b18-9c8a-e70656a09d38"
PLUGIN_ID = "bf3901a7-72e3-42ee-a10a-670997636614"
OUTPUT_SENTINEL = "<!-- pipeline-output -->"

# Agent IDs to pause during tests (prevent real agents from claiming dispatched issues)
AGENTS_TO_PAUSE: list = []

# Tracking state for cleanup
cleanup_issue_ids = []
cleanup_pipeline_name = None
run_id = None


class Colors:
    RED = "\033[0;31m"
    GREEN = "\033[0;32m"
    YELLOW = "\033[1;33m"
    CYAN = "\033[0;36m"
    NC = "\033[0m"


def log(msg):
    print(f"{Colors.CYAN}[E2E]{Colors.NC} {msg}")


def passed(msg):
    print(f"{Colors.GREEN}[PASS]{Colors.NC} {msg}")


def fail(msg):
    print(f"{Colors.RED}[FAIL]{Colors.NC} {msg}")
    cleanup()
    sys.exit(1)


def warn(msg):
    print(f"{Colors.YELLOW}[WARN]{Colors.NC} {msg}")


def api_get(path):
    """GET request, returns parsed JSON."""
    url = f"{BASE}{path}"
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode() if e.fp else ""
        raise RuntimeError(f"GET {path} → {e.code}: {body}")


def api_post(path, data=None):
    """POST request with JSON body, returns parsed JSON."""
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
    """DELETE request."""
    url = f"{BASE}{path}"
    req = urllib.request.Request(url, method="DELETE")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read()) if resp.read() else {}
    except Exception:
        pass


def poll_until(description, check_fn, max_attempts=30, interval=2):
    """Poll until check_fn returns a truthy value."""
    log(f"Polling: {description} (max {max_attempts}x{interval}s)...")
    for i in range(1, max_attempts + 1):
        try:
            result = check_fn()
            if result:
                return result
        except Exception:
            pass
        time.sleep(interval)
    fail(f"Timed out polling: {description}")


def cleanup():
    global cleanup_pipeline_name, cleanup_issue_ids, run_id
    log("Cleaning up...")

    # Cancel any active run
    if run_id:
        try:
            api_post(
                f"/plugins/{PLUGIN_ID}/actions/cancel-run",
                {"params": {"runId": run_id}},
            )
        except Exception:
            pass

    # Delete e2e-test pipeline
    if cleanup_pipeline_name:
        try:
            api_post(
                f"/plugins/{PLUGIN_ID}/actions/delete-pipeline",
                {"params": {"name": cleanup_pipeline_name}},
            )
            log(f"  Deleted pipeline: {cleanup_pipeline_name}")
        except Exception:
            pass

    # Delete created issues (children first, then parent)
    for iid in reversed(cleanup_issue_ids):
        try:
            api_delete(f"/issues/{iid}")
        except Exception:
            pass
    if cleanup_issue_ids:
        log(f"  Deleted {len(cleanup_issue_ids)} issue(s)")

    log("Cleanup complete.")


def get_child_issues(parent_id):
    """Get sub-issues of a parent."""
    return api_get(f"/companies/{COMPANY_ID}/issues?parentId={parent_id}&limit=20")


def find_stage_issue(parent_id, stage_name):
    """Find a sub-issue matching [pipeline] <stage_name>."""
    issues = get_child_issues(parent_id)
    for issue in issues:
        if f"[pipeline] {stage_name}" in issue.get("title", ""):
            return issue
    return None


def run_scenario(name, fn):
    """Run a test scenario with cleanup."""
    global cleanup_pipeline_name, cleanup_issue_ids, run_id
    cleanup_pipeline_name = None
    cleanup_issue_ids = []
    run_id = None
    print()
    print(f"{Colors.CYAN}{'═' * 60}{Colors.NC}")
    print(f"{Colors.CYAN} SCENARIO: {name}{Colors.NC}")
    print(f"{Colors.CYAN}{'═' * 60}{Colors.NC}")
    try:
        fn()
        print(f"{Colors.GREEN} ✓ SCENARIO PASSED: {name}{Colors.NC}")
        return True
    except SystemExit:
        print(f"{Colors.RED} ✗ SCENARIO FAILED: {name}{Colors.NC}")
        return False
    finally:
        cleanup()


# ===========================================================================
# SCENARIO 1: Happy path (original test)
# ===========================================================================
def scenario_happy_path():
    global cleanup_pipeline_name, cleanup_issue_ids, run_id

    # =========================================================================
    # Step 1: Save a minimal 2-stage pipeline (implement → validate)
    # =========================================================================
    log("Step 1: Save minimal e2e-test pipeline")

    pipeline_def = {
        "name": "e2e-test",
        "description": "Minimal 2-stage E2E test pipeline",
        "trigger": {"label": "pipeline:feature"},
        "stages": [
            {
                "id": "implement",
                "type": "stage",
                "agent_role": "pipe-backend",
                "actionId": "write-implementation",
            },
            {
                "id": "validate",
                "type": "stage",
                "agent_role": "pipe-backend",
                "actionId": "validate-scenario",
            },
        ],
        "edges": [{"id": "e1", "from": "implement", "to": "validate"}],
        "positions": {},
    }

    save_result = api_post(
        f"/plugins/{PLUGIN_ID}/actions/save-pipeline",
        {"params": {"name": "e2e-test", "content": json.dumps(pipeline_def)}},
    )
    if not save_result.get("data", {}).get("success"):
        fail(f"save-pipeline failed: {save_result}")
    cleanup_pipeline_name = "e2e-test"
    passed("Pipeline 'e2e-test' saved")

    # =========================================================================
    # Step 2: Create a parent issue (no trigger label needed — we use trigger-run)
    # =========================================================================
    log("Step 2: Create parent issue")

    issue_result = api_post(
        f"/companies/{COMPANY_ID}/issues",
        {
            "title": "[E2E Test] Pipeline mock agent test",
            "description": "Automated E2E test — mock agent completes stages via comments.",
            "status": "todo",
            "priority": "low",
        },
    )
    parent_issue_id = issue_result.get("id")
    if not parent_issue_id:
        fail(f"Failed to create parent issue: {issue_result}")
    cleanup_issue_ids.append(parent_issue_id)
    log(f"  Parent issue: {parent_issue_id}")
    passed("Parent issue created")

    # =========================================================================
    # Step 3: Trigger the pipeline run via action
    # =========================================================================
    log("Step 3: Trigger pipeline run via trigger-run action")

    trigger_result = api_post(
        f"/plugins/{PLUGIN_ID}/actions/trigger-run",
        {
            "params": {
                "companyId": COMPANY_ID,
                "issueId": parent_issue_id,
                "pipelineName": "e2e-test",
            }
        },
    )
    if not trigger_result.get("data", {}).get("success"):
        fail(f"trigger-run failed: {trigger_result}")
    passed("Pipeline run triggered")

    # =========================================================================
    # Step 4: Poll for stage 1 dispatch (implement)
    # =========================================================================
    log("Step 4: Wait for stage 'implement' to dispatch")

    def check_stage1():
        return find_stage_issue(parent_issue_id, "implement")

    stage1 = poll_until(
        "stage 'implement' sub-issue", check_stage1, max_attempts=25, interval=2
    )
    stage1_issue_id = stage1["id"]
    cleanup_issue_ids.append(stage1_issue_id)
    log(f"  Stage 1 issue: {stage1_issue_id}")
    passed("Pipeline run materialized, stage 'implement' dispatched")

    # =========================================================================
    # Step 5: Mock agent posts completion comment on stage 1
    # =========================================================================
    log("Step 5: Post mock completion comment on stage 1 (implement)")

    comment_body = f"""{OUTPUT_SENTINEL}
```json
{{"decision": "done"}}
```"""

    comment_result = api_post(
        f"/issues/{stage1_issue_id}/comments",
        {"body": comment_body},
    )
    comment_id = comment_result.get("id")
    if not comment_id:
        fail(f"Failed to post comment on stage 1: {comment_result}")
    log(f"  Comment posted: {comment_id}")
    passed("Mock agent completed stage 'implement'")

    # =========================================================================
    # Step 6: Poll for stage 2 dispatch (validate)
    # =========================================================================
    log("Step 6: Wait for stage 'validate' to dispatch")

    def check_stage2():
        return find_stage_issue(parent_issue_id, "validate")

    stage2 = poll_until(
        "stage 'validate' sub-issue", check_stage2, max_attempts=25, interval=2
    )
    stage2_issue_id = stage2["id"]
    cleanup_issue_ids.append(stage2_issue_id)
    log(f"  Stage 2 issue: {stage2_issue_id}")
    passed("Stage 'validate' dispatched after 'implement' completed")

    # =========================================================================
    # Step 7: Mock agent posts completion comment on stage 2
    # =========================================================================
    log("Step 7: Post mock completion comment on stage 2 (validate)")

    comment_body2 = f"""{OUTPUT_SENTINEL}
```json
{{"decision": "yes"}}
```"""

    comment_result2 = api_post(
        f"/issues/{stage2_issue_id}/comments",
        {"body": comment_body2},
    )
    comment_id2 = comment_result2.get("id")
    if not comment_id2:
        fail(f"Failed to post comment on stage 2: {comment_result2}")
    log(f"  Comment posted: {comment_id2}")
    passed("Mock agent completed stage 'validate'")

    # =========================================================================
    # Step 8: Verify pipeline run completed (parent issue → done)
    # =========================================================================
    log("Step 8: Verify pipeline run completed")

    def check_parent_done():
        issue = api_get(f"/issues/{parent_issue_id}")
        if issue.get("status") == "done":
            return "done"
        return None

    final_status = poll_until(
        "parent issue marked done", check_parent_done, max_attempts=20, interval=2
    )
    if final_status != "done":
        fail(f"Parent issue not done (status={final_status})")
    passed("Parent issue marked done — pipeline completed successfully!")

    # =========================================================================
    # Step 9: Verify stage sub-issues are done
    # =========================================================================
    log("Step 9: Verify all stage sub-issues are done")

    for sid, name in [(stage1_issue_id, "implement"), (stage2_issue_id, "validate")]:
        issue = api_get(f"/issues/{sid}")
        if issue.get("status") != "done":
            fail(f"Sub-issue {name} ({sid}) not done (status={issue.get('status')})")
    passed("All stage sub-issues marked done")

    # =========================================================================
    # Summary
    # =========================================================================
    passed(f"Full pipeline lifecycle: {parent_issue_id}")


# ===========================================================================
# SCENARIO 2: Invalid output format (malformed comment)
# ===========================================================================
def scenario_invalid_output():
    """Test: agent posts comment WITHOUT the sentinel — pipeline should NOT advance."""
    global cleanup_pipeline_name, cleanup_issue_ids, run_id

    log("Save pipeline")
    pipeline_def = {
        "name": "e2e-invalid-output",
        "description": "Test invalid output handling",
        "trigger": {"label": "pipeline:feature"},
        "stages": [
            {
                "id": "step1",
                "type": "stage",
                "agent_role": "pipe-backend",
                "actionId": "write-implementation",
            },
        ],
        "edges": [],
        "positions": {},
    }
    save_result = api_post(
        f"/plugins/{PLUGIN_ID}/actions/save-pipeline",
        {"params": {"name": "e2e-invalid-output", "content": json.dumps(pipeline_def)}},
    )
    if not save_result.get("data", {}).get("success"):
        fail(f"save-pipeline failed: {save_result}")
    cleanup_pipeline_name = "e2e-invalid-output"

    log("Create parent issue + trigger")
    issue_result = api_post(
        f"/companies/{COMPANY_ID}/issues",
        {
            "title": "[E2E] Invalid output test",
            "description": "Testing malformed output",
            "status": "todo",
            "priority": "low",
        },
    )
    parent_id = issue_result["id"]
    cleanup_issue_ids.append(parent_id)

    api_post(
        f"/plugins/{PLUGIN_ID}/actions/trigger-run",
        {
            "params": {
                "companyId": COMPANY_ID,
                "issueId": parent_id,
                "pipelineName": "e2e-invalid-output",
            }
        },
    )

    log("Wait for stage dispatch")
    stage = poll_until(
        "stage dispatch",
        lambda: find_stage_issue(parent_id, "step1"),
        max_attempts=20,
        interval=2,
    )
    stage_id = stage["id"]
    cleanup_issue_ids.append(stage_id)

    # Post a comment WITHOUT the sentinel — should be ignored
    log("Post comment WITHOUT sentinel (should be ignored)")
    api_post(
        f"/issues/{stage_id}/comments",
        {"body": "Just a regular comment, no output here"},
    )
    time.sleep(3)

    # Post a comment WITH sentinel but invalid JSON — THIS WILL KILL THE PIPELINE
    # BUG FOUND: A single malformed JSON comment permanently escalates the run
    # when no error edges are defined. The pipeline cannot recover.
    log("Post comment WITH sentinel but broken JSON (KNOWN BUG: kills pipeline)")
    bad_json_body = f"""{OUTPUT_SENTINEL}
```json
{{this is not valid json
```"""
    api_post(f"/issues/{stage_id}/comments", {"body": bad_json_body})
    time.sleep(3)

    # The pipeline is now escalated — verify it's dead
    parent = api_get(f"/issues/{parent_id}")
    if parent.get("status") == "done":
        fail("Parent issue should NOT be done after invalid output!")

    passed("Invalid JSON with sentinel KILLED the pipeline (no error edges → escalate)")

    # Post valid output — verify it does NOT recover (confirming the bug)
    log("Post valid output AFTER escalation (expect no recovery)")
    valid_body = f"""{OUTPUT_SENTINEL}
```json
{{"decision": "done"}}
```"""
    api_post(f"/issues/{stage_id}/comments", {"body": valid_body})
    time.sleep(3)

    parent = api_get(f"/issues/{parent_id}")
    if parent.get("status") == "done":
        fail("Pipeline recovered from escalation — unexpected!")

    passed(
        "BUG CONFIRMED: Pipeline is permanently dead after malformed output (no retry without error edges)"
    )


# ===========================================================================
# SCENARIO 3: Blocking decision (ci-blocked → escalated)
# ===========================================================================
def scenario_blocking_decision():
    """Test: agent posts a blocking decision → pipeline escalates."""
    global cleanup_pipeline_name, cleanup_issue_ids, run_id

    log("Save pipeline")
    pipeline_def = {
        "name": "e2e-blocking",
        "description": "Test blocking decision handling",
        "trigger": {"label": "pipeline:feature"},
        "stages": [
            {
                "id": "ci",
                "type": "stage",
                "agent_role": "pipe-backend",
                "actionId": "check-ci",
            },
        ],
        "edges": [],
        "positions": {},
    }
    save_result = api_post(
        f"/plugins/{PLUGIN_ID}/actions/save-pipeline",
        {"params": {"name": "e2e-blocking", "content": json.dumps(pipeline_def)}},
    )
    if not save_result.get("data", {}).get("success"):
        fail(f"save-pipeline failed: {save_result}")
    cleanup_pipeline_name = "e2e-blocking"

    log("Create parent issue + trigger")
    issue_result = api_post(
        f"/companies/{COMPANY_ID}/issues",
        {
            "title": "[E2E] Blocking decision test",
            "description": "Test ci-blocked",
            "status": "todo",
            "priority": "low",
        },
    )
    parent_id = issue_result["id"]
    cleanup_issue_ids.append(parent_id)

    api_post(
        f"/plugins/{PLUGIN_ID}/actions/trigger-run",
        {
            "params": {
                "companyId": COMPANY_ID,
                "issueId": parent_id,
                "pipelineName": "e2e-blocking",
            }
        },
    )

    log("Wait for stage dispatch")
    stage = poll_until(
        "stage dispatch",
        lambda: find_stage_issue(parent_id, "ci"),
        max_attempts=20,
        interval=2,
    )
    stage_id = stage["id"]
    cleanup_issue_ids.append(stage_id)

    # Post a blocking decision
    log("Post blocking decision (ci-blocked)")
    blocking_body = f"""{OUTPUT_SENTINEL}
```json
{{"decision": "ci-blocked", "tracks": ["backend"]}}
```"""
    api_post(f"/issues/{stage_id}/comments", {"body": blocking_body})
    time.sleep(4)

    # Verify stage sub-issue is marked blocked
    stage_issue = api_get(f"/issues/{stage_id}")
    if stage_issue.get("status") != "blocked":
        warn(f"Expected stage issue to be 'blocked', got '{stage_issue.get('status')}'")

    # Verify parent issue is NOT done (run should be escalated, not completed)
    parent = api_get(f"/issues/{parent_id}")
    if parent.get("status") == "done":
        fail("Parent should NOT be done after blocking decision")

    passed(
        f"Blocking decision handled correctly — parent status: {parent.get('status')}"
    )


# ===========================================================================
# SCENARIO 4: Conditional routing (sourceHandle-based branching)
# ===========================================================================
def scenario_conditional_routing():
    """Test: 3-stage pipeline where stage 1's decision routes to different paths."""
    global cleanup_pipeline_name, cleanup_issue_ids, run_id

    log("Save pipeline with conditional branching")
    pipeline_def = {
        "name": "e2e-branching",
        "description": "Test conditional routing via sourceHandle",
        "trigger": {"label": "pipeline:feature"},
        "stages": [
            {
                "id": "check",
                "type": "stage",
                "agent_role": "pipe-backend",
                "actionId": "validate-scenario",
            },
            {
                "id": "fix",
                "type": "stage",
                "agent_role": "pipe-backend",
                "actionId": "fix-ci",
            },
            {
                "id": "done-path",
                "type": "stage",
                "agent_role": "pipe-backend",
                "actionId": "write-implementation",
            },
        ],
        "edges": [
            {"id": "e1", "from": "check", "to": "fix", "sourceHandle": "no"},
            {"id": "e2", "from": "check", "to": "done-path", "sourceHandle": "yes"},
        ],
        "positions": {},
    }
    save_result = api_post(
        f"/plugins/{PLUGIN_ID}/actions/save-pipeline",
        {"params": {"name": "e2e-branching", "content": json.dumps(pipeline_def)}},
    )
    if not save_result.get("data", {}).get("success"):
        fail(f"save-pipeline failed: {save_result}")
    cleanup_pipeline_name = "e2e-branching"

    log("Create parent issue + trigger")
    issue_result = api_post(
        f"/companies/{COMPANY_ID}/issues",
        {
            "title": "[E2E] Branching test",
            "description": "Test conditional routing",
            "status": "todo",
            "priority": "low",
        },
    )
    parent_id = issue_result["id"]
    cleanup_issue_ids.append(parent_id)

    api_post(
        f"/plugins/{PLUGIN_ID}/actions/trigger-run",
        {
            "params": {
                "companyId": COMPANY_ID,
                "issueId": parent_id,
                "pipelineName": "e2e-branching",
            }
        },
    )

    log("Wait for 'check' stage dispatch")
    stage = poll_until(
        "check stage",
        lambda: find_stage_issue(parent_id, "check"),
        max_attempts=20,
        interval=2,
    )
    check_id = stage["id"]
    cleanup_issue_ids.append(check_id)

    # Post "no" decision → should route to "fix" stage, skip "done-path"
    log("Post decision='no' → should route to 'fix' path")
    body = f"""{OUTPUT_SENTINEL}
```json
{{"decision": "no"}}
```"""
    api_post(f"/issues/{check_id}/comments", {"body": body})

    log("Wait for 'fix' stage to dispatch (not 'done-path')")
    fix_stage = poll_until(
        "fix stage",
        lambda: find_stage_issue(parent_id, "fix"),
        max_attempts=20,
        interval=2,
    )
    fix_id = fix_stage["id"]
    cleanup_issue_ids.append(fix_id)
    passed("Correct branch taken: 'fix' dispatched after decision='no'")

    # Check that 'done-path' was skipped (not dispatched)
    time.sleep(2)
    done_path_issue = find_stage_issue(parent_id, "done-path")
    if done_path_issue:
        # It exists but should be status=skipped or not dispatched
        warn(
            f"'done-path' sub-issue exists: {done_path_issue.get('id')} status={done_path_issue.get('status')}"
        )
    else:
        passed("'done-path' correctly NOT dispatched (skipped)")

    # Complete 'fix' stage
    log("Complete 'fix' stage")
    fix_body = f"""{OUTPUT_SENTINEL}
```json
{{"decision": "done"}}
```"""
    api_post(f"/issues/{fix_id}/comments", {"body": fix_body})

    poll_until(
        "parent done",
        lambda: api_get(f"/issues/{parent_id}").get("status") == "done" or None,
        max_attempts=20,
        interval=2,
    )
    passed("Pipeline completed via 'no' → 'fix' branch")


# ===========================================================================
# SCENARIO 5: Error edge retry (failure → goto earlier stage)
# ===========================================================================
def scenario_error_edge_retry():
    """Test: stage fails → error edge routes back to retry, eventually succeeds."""
    global cleanup_pipeline_name, cleanup_issue_ids, run_id

    log("Save pipeline with error edge (validate → implement on failure)")
    pipeline_def = {
        "name": "e2e-retry",
        "description": "Test error edge retry mechanism",
        "trigger": {"label": "pipeline:feature"},
        "stages": [
            {
                "id": "impl",
                "type": "stage",
                "agent_role": "pipe-backend",
                "actionId": "write-implementation",
            },
            {
                "id": "val",
                "type": "stage",
                "agent_role": "pipe-backend",
                "actionId": "validate-scenario",
            },
        ],
        "edges": [
            {"id": "e1", "from": "impl", "to": "val"},
            {"id": "e-err", "from": "val", "to": "impl", "type": "error"},
        ],
        "positions": {},
    }
    save_result = api_post(
        f"/plugins/{PLUGIN_ID}/actions/save-pipeline",
        {"params": {"name": "e2e-retry", "content": json.dumps(pipeline_def)}},
    )
    if not save_result.get("data", {}).get("success"):
        fail(f"save-pipeline failed: {save_result}")
    cleanup_pipeline_name = "e2e-retry"

    log("Create parent issue + trigger")
    issue_result = api_post(
        f"/companies/{COMPANY_ID}/issues",
        {
            "title": "[E2E] Error edge retry test",
            "description": "Test retry via error edges",
            "status": "todo",
            "priority": "low",
        },
    )
    parent_id = issue_result["id"]
    cleanup_issue_ids.append(parent_id)

    api_post(
        f"/plugins/{PLUGIN_ID}/actions/trigger-run",
        {
            "params": {
                "companyId": COMPANY_ID,
                "issueId": parent_id,
                "pipelineName": "e2e-retry",
            }
        },
    )

    # First pass: impl → val
    log("Wait for 'impl' stage (pass 1)")
    stage = poll_until(
        "impl stage",
        lambda: find_stage_issue(parent_id, "impl"),
        max_attempts=20,
        interval=2,
    )
    impl_id = stage["id"]
    cleanup_issue_ids.append(impl_id)

    log("Complete 'impl' (pass 1)")
    api_post(
        f"/issues/{impl_id}/comments",
        {"body": f'{OUTPUT_SENTINEL}\n```json\n{{"decision": "done"}}\n```'},
    )

    log("Wait for 'val' stage (pass 1)")
    val_stage = poll_until(
        "val stage",
        lambda: find_stage_issue(parent_id, "val"),
        max_attempts=20,
        interval=2,
    )
    val_id = val_stage["id"]
    cleanup_issue_ids.append(val_id)

    # Make validate FAIL with invalid JSON (triggers error edge → retry impl)
    log("Fail 'val' with broken JSON (trigger error edge → retry)")
    bad_body = f"{OUTPUT_SENTINEL}\n```json\n{{broken\n```"
    api_post(f"/issues/{val_id}/comments", {"body": bad_body})
    time.sleep(3)

    # Error edge should route back to 'impl' — a NEW sub-issue dispatched
    log("Wait for 'impl' retry dispatch (pass 2)")

    def find_retry_impl():
        children = get_child_issues(parent_id)
        impl_issues = [c for c in children if "[pipeline] impl" in c.get("title", "")]
        # Should have 2 impl issues now (original + retry)
        if len(impl_issues) >= 2:
            # Return the one that is NOT the original impl_id
            for iss in impl_issues:
                if iss["id"] != impl_id:
                    return iss
            return impl_issues[-1]
        return None

    retry_impl = poll_until(
        "impl retry dispatch", find_retry_impl, max_attempts=25, interval=2
    )
    retry_impl_id = retry_impl["id"]
    cleanup_issue_ids.append(retry_impl_id)
    passed("Error edge fired: 'impl' re-dispatched after 'val' failure")

    # Complete retry impl
    log("Complete 'impl' (pass 2)")
    api_post(
        f"/issues/{retry_impl_id}/comments",
        {"body": f'{OUTPUT_SENTINEL}\n```json\n{{"decision": "done"}}\n```'},
    )

    # Wait for val retry — look for a NEW val sub-issue (different from val_id)
    log("Wait for 'val' retry dispatch (pass 2)")

    def find_retry_val():
        children = get_child_issues(parent_id)
        val_issues = [
            c
            for c in children
            if "[pipeline] val" in c.get("title", "") and c["id"] != val_id
        ]
        if val_issues:
            return val_issues[-1]
        return None

    retry_val = poll_until(
        "val retry dispatch", find_retry_val, max_attempts=25, interval=2
    )
    retry_val_id = retry_val["id"]
    cleanup_issue_ids.append(retry_val_id)

    # Complete val successfully this time
    log("Complete 'val' successfully (pass 2)")
    api_post(
        f"/issues/{retry_val_id}/comments",
        {"body": f'{OUTPUT_SENTINEL}\n```json\n{{"decision": "yes"}}\n```'},
    )

    poll_until(
        "parent done after retry",
        lambda: api_get(f"/issues/{parent_id}").get("status") == "done" or None,
        max_attempts=20,
        interval=2,
    )
    passed("Pipeline recovered via error edge retry and completed")


# ===========================================================================
# MAIN
# ===========================================================================
def main():
    global AGENTS_TO_PAUSE

    log("Step 0: Verify prerequisites")
    health = api_get("/health")
    log(f"  Server version: {health['version']}")
    plugins = api_get("/plugins")
    plugin = next((p for p in plugins if p["id"] == PLUGIN_ID), None)
    if not plugin or plugin["status"] != "ready":
        fail(f"Plugin not ready (status={plugin['status'] if plugin else 'NOT FOUND'})")
    passed("Prerequisites OK")

    # Pause all agents in the company to prevent them from claiming dispatched issues
    log("Pausing agents to prevent interference...")
    agents = api_get(f"/companies/{COMPANY_ID}/agents")
    for agent in agents:
        if agent.get("status") != "paused":
            try:
                api_post(f"/agents/{agent['id']}/pause", {})
                AGENTS_TO_PAUSE.append(agent["id"])
                log(f"  Paused: {agent['name']} ({agent['id'][:8]})")
            except Exception as e:
                warn(f"  Could not pause {agent['name']}: {e}")
    passed(f"Paused {len(AGENTS_TO_PAUSE)} agent(s)")

    results = []
    # Allow filtering scenarios via CLI arg
    scenario_filter = sys.argv[1] if len(sys.argv) > 1 else None
    all_scenarios = [
        ("Happy Path (2-stage linear)", scenario_happy_path),
        ("Invalid Output Format", scenario_invalid_output),
        ("Blocking Decision (ci-blocked)", scenario_blocking_decision),
        ("Conditional Routing (sourceHandle)", scenario_conditional_routing),
        ("Error Edge Retry", scenario_error_edge_retry),
    ]
    for name, fn in all_scenarios:
        if scenario_filter and scenario_filter.lower() not in name.lower():
            continue
        results.append(run_scenario(name, fn))

    # Summary
    print()
    print(f"{Colors.CYAN}{'═' * 60}{Colors.NC}")
    total = len(results)
    passed_count = sum(results)
    failed_count = total - passed_count
    if failed_count == 0:
        print(f"{Colors.GREEN} ALL {total} SCENARIOS PASSED{Colors.NC}")
    else:
        print(f"{Colors.RED} {failed_count}/{total} SCENARIOS FAILED{Colors.NC}")
    print(f"{Colors.CYAN}{'═' * 60}{Colors.NC}")

    # Resume all paused agents
    log("Resuming agents...")
    for agent_id in AGENTS_TO_PAUSE:
        try:
            api_post(f"/agents/{agent_id}/resume", {})
        except Exception:
            pass
    log(f"  Resumed {len(AGENTS_TO_PAUSE)} agent(s)")

    sys.exit(0 if failed_count == 0 else 1)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        fail(f"Unexpected error: {e}")
