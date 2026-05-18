#!/usr/bin/env bash
# =============================================================================
# E2E Test: Pipeline Engine — Mock Agent approach
# =============================================================================
# This test exercises the full pipeline lifecycle via HTTP APIs without any
# real LLM calls. A "mock agent" simulates completion by posting structured
# comments with the pipeline-output sentinel.
#
# Prerequisites:
#   - Paperclip server running at localhost:3100
#   - Pipeline engine plugin installed and status=ready
#   - "Internal Developer Portal" company exists with pipe-backend agent
#
# Usage:
#   bash tests/e2e-mock-agent.sh
# =============================================================================

set -euo pipefail

BASE="http://localhost:3100/api"
COMPANY_ID="f3f8f577-efb7-4b18-9c8a-e70656a09d38"
PLUGIN_ID="bf3901a7-72e3-42ee-a10a-670997636614"
LABEL_FEATURE="18d95ec1-363f-40c1-af8e-4936ebe71ce4"  # pipeline:feature

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${CYAN}[E2E]${NC} $*"; }
pass() { echo -e "${GREEN}[PASS]${NC} $*"; }
fail() { echo -e "${RED}[FAIL]${NC} $*"; exit 1; }
warn() { echo -e "${YELLOW}[WARN]${NC} $*"; }

# Track resources for cleanup
CLEANUP_ISSUE_IDS=()
CLEANUP_PIPELINE_NAME=""

cleanup() {
  log "Cleaning up..."
  # Cancel any active run
  if [ -n "${RUN_ID:-}" ]; then
    curl -sf -X POST "$BASE/plugins/$PLUGIN_ID/actions/cancel-run" \
      -H "Content-Type: application/json" \
      -d "{\"params\": {\"runId\": \"$RUN_ID\"}}" 2>/dev/null || true
  fi
  # Delete e2e-test pipeline
  if [ -n "$CLEANUP_PIPELINE_NAME" ]; then
    curl -sf -X POST "$BASE/plugins/$PLUGIN_ID/actions/delete-pipeline" \
      -H "Content-Type: application/json" \
      -d "{\"params\": {\"name\": \"$CLEANUP_PIPELINE_NAME\"}}" 2>/dev/null || true
    log "Deleted pipeline: $CLEANUP_PIPELINE_NAME"
  fi
  # Delete created issues
  for iid in "${CLEANUP_ISSUE_IDS[@]+"${CLEANUP_ISSUE_IDS[@]}"}"; do
    curl -sf -X DELETE "$BASE/issues/$iid" 2>/dev/null || true
  done
  if [ "${#CLEANUP_ISSUE_IDS[@]}" -gt 0 ] 2>/dev/null; then
    log "Deleted ${#CLEANUP_ISSUE_IDS[@]} issue(s)"
  fi
  log "Cleanup complete."
}
trap cleanup EXIT

# =============================================================================
# Helper: poll until condition is met
# =============================================================================
poll_until() {
  local description="$1"
  local cmd="$2"
  local max_attempts="${3:-30}"
  local interval="${4:-2}"

  echo -e "${CYAN}[E2E]${NC} Polling: $description (max ${max_attempts}x${interval}s)..." >&2
  for ((i=1; i<=max_attempts; i++)); do
    if result=$(eval "$cmd" 2>/dev/null) && [ -n "$result" ]; then
      echo "$result"
      return 0
    fi
    sleep "$interval"
  done
  fail "Timed out polling: $description"
}

# =============================================================================
# Step 0: Verify prerequisites
# =============================================================================
log "Step 0: Verify prerequisites"

HEALTH=$(curl -sf "$BASE/health")
VERSION=$(echo "$HEALTH" | python3 -c "import sys,json; print(json.load(sys.stdin)['version'])")
log "  Server version: $VERSION"

PLUGIN_STATUS=$(curl -sf "$BASE/plugins" | python3 -c "
import sys, json
plugins = json.load(sys.stdin)
for p in plugins:
    if p['id'] == '$PLUGIN_ID':
        print(p['status'])
")
[ "$PLUGIN_STATUS" = "ready" ] || fail "Plugin not ready (status=$PLUGIN_STATUS)"
pass "Prerequisites OK"

# =============================================================================
# Step 1: Save a minimal 2-stage pipeline (implement → validate)
# =============================================================================
log "Step 1: Save minimal e2e-test pipeline"

PIPELINE_JSON=$(cat <<'EOF'
{
  "name": "e2e-test",
  "description": "E2E test pipeline",
  "trigger": { "label": "pipeline:feature" },
  "stages": [
    {
      "id": "implement",
      "type": "stage",
      "agent_role": "pipe-backend",
      "actionId": "triage-new-issues"
    },
    {
      "id": "validate",
      "type": "stage",
      "agent_role": "pipe-backend",
      "actionId": "triage-new-issues"
    }
  ],
  "edges": [
    { "id": "e1", "from": "implement", "to": "validate" }
  ],
  "positions": {
    "implement": { "x": 0, "y": 0 },
    "validate": { "x": 0, "y": 200 }
  }
}
EOF
)

SAVE_BODY=$(python3 -c "
import json, sys
content = sys.stdin.read().strip()
print(json.dumps({'params': {'name': 'e2e-test', 'content': content}}))
" <<< "$PIPELINE_JSON")

SAVE_RESULT=$(curl -sf -X POST "$BASE/plugins/$PLUGIN_ID/actions/save-pipeline" \
  -H "Content-Type: application/json" \
  -d "$SAVE_BODY")

echo "$SAVE_RESULT" | python3 -c "import sys,json; d=json.load(sys.stdin); assert d.get('data',{}).get('success'), f'save-pipeline failed: {d}'"
CLEANUP_PIPELINE_NAME="e2e-test"
pass "Pipeline 'e2e-test' saved"

# =============================================================================
# Step 2: Create a parent issue with the trigger label
# =============================================================================
log "Step 2: Create trigger issue"

ISSUE_BODY=$(python3 -c "
import json
print(json.dumps({
    'title': '[E2E Test] Pipeline mock agent test',
    'description': 'Automated E2E test of the pipeline engine using mock agent comments.',
    'status': 'todo',
    'priority': 'low',
    'labelIds': ['$LABEL_FEATURE']
}))
")

ISSUE_RESULT=$(curl -sf -X POST "$BASE/companies/$COMPANY_ID/issues" \
  -H "Content-Type: application/json" \
  -d "$ISSUE_BODY")

PARENT_ISSUE_ID=$(echo "$ISSUE_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")
[ -n "$PARENT_ISSUE_ID" ] || fail "Failed to create parent issue"
CLEANUP_ISSUE_IDS+=("$PARENT_ISSUE_ID")
log "  Parent issue: $PARENT_ISSUE_ID"
pass "Issue created with pipeline:feature label"

# =============================================================================
# Step 3: Poll for pipeline run creation
# =============================================================================
log "Step 3: Wait for pipeline run to materialize"

RUN_ID=$(poll_until "pipeline run created" "
  curl -sf '$BASE/companies/$COMPANY_ID/issues?parentId=$PARENT_ISSUE_ID&limit=10' | python3 -c \"
import sys, json
issues = json.load(sys.stdin)
for i in issues:
    if '[pipeline]' in i.get('title',''):
        print('FOUND')
        break
\"
" 20 3)

# Alternative: use the runs route or check via state
# Let's find the actual run by looking at sub-issues
log "  Looking for stage sub-issues..."
sleep 2

STAGE1_INFO=$(poll_until "stage 'implement' sub-issue" "
  curl -sf '$BASE/companies/$COMPANY_ID/issues?parentId=$PARENT_ISSUE_ID&limit=10' | python3 -c \"
import sys, json
issues = json.load(sys.stdin)
for i in issues:
    if '[pipeline] implement' in i.get('title',''):
        print(i['id'])
        break
\"
" 20 3)

STAGE1_ISSUE_ID="$STAGE1_INFO"
[ -n "$STAGE1_ISSUE_ID" ] || fail "Stage 1 sub-issue not found"
CLEANUP_ISSUE_IDS+=("$STAGE1_ISSUE_ID")
log "  Stage 1 issue: $STAGE1_ISSUE_ID"
pass "Pipeline run materialized, stage 'implement' dispatched"

# =============================================================================
# Step 4: Mock agent posts completion comment on stage 1
# =============================================================================
log "Step 4: Post mock completion comment on stage 1 (implement)"

COMMENT_BODY='<!-- pipeline-output -->
```json
{"status": "success", "files_changed": ["src/feature.ts"], "summary": "Implemented the feature"}
```'

COMMENT_JSON=$(python3 -c "
import json, sys
body = sys.stdin.read()
print(json.dumps({'body': body}))
" <<< "$COMMENT_BODY")

COMMENT_RESULT=$(curl -sf -X POST "$BASE/issues/$STAGE1_ISSUE_ID/comments" \
  -H "Content-Type: application/json" \
  -d "$COMMENT_JSON")

COMMENT_ID=$(echo "$COMMENT_RESULT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
[ -n "$COMMENT_ID" ] || fail "Failed to post comment on stage 1"
log "  Comment posted: $COMMENT_ID"
pass "Mock agent completed stage 'implement'"

# =============================================================================
# Step 5: Poll for stage 2 dispatch (validate)
# =============================================================================
log "Step 5: Wait for stage 'validate' to dispatch"

STAGE2_INFO=$(poll_until "stage 'validate' sub-issue" "
  curl -sf '$BASE/companies/$COMPANY_ID/issues?parentId=$PARENT_ISSUE_ID&limit=10' | python3 -c \"
import sys, json
issues = json.load(sys.stdin)
for i in issues:
    if '[pipeline] validate' in i.get('title',''):
        print(i['id'])
        break
\"
" 20 3)

STAGE2_ISSUE_ID="$STAGE2_INFO"
[ -n "$STAGE2_ISSUE_ID" ] || fail "Stage 2 sub-issue not found"
CLEANUP_ISSUE_IDS+=("$STAGE2_ISSUE_ID")
log "  Stage 2 issue: $STAGE2_ISSUE_ID"
pass "Stage 'validate' dispatched after 'implement' completed"

# =============================================================================
# Step 6: Mock agent posts completion comment on stage 2
# =============================================================================
log "Step 6: Post mock completion comment on stage 2 (validate)"

COMMENT_BODY2='<!-- pipeline-output -->
```json
{"status": "success", "validation_passed": true, "tests_run": 12, "tests_passed": 12}
```'

COMMENT_JSON2=$(python3 -c "
import json, sys
body = sys.stdin.read()
print(json.dumps({'body': body}))
" <<< "$COMMENT_BODY2")

COMMENT_RESULT2=$(curl -sf -X POST "$BASE/issues/$STAGE2_ISSUE_ID/comments" \
  -H "Content-Type: application/json" \
  -d "$COMMENT_JSON2")

COMMENT_ID2=$(echo "$COMMENT_RESULT2" | python3 -c "import sys,json; print(json.load(sys.stdin).get('id',''))")
[ -n "$COMMENT_ID2" ] || fail "Failed to post comment on stage 2"
log "  Comment posted: $COMMENT_ID2"
pass "Mock agent completed stage 'validate'"

# =============================================================================
# Step 7: Verify pipeline run completed
# =============================================================================
log "Step 7: Verify pipeline run completed"

FINAL_STATUS=$(poll_until "pipeline run completed" "
  curl -sf '$BASE/issues/$PARENT_ISSUE_ID' | python3 -c \"
import sys, json
issue = json.load(sys.stdin)
# Check if parent issue is done (pipeline sets it to done on completion)
if issue.get('status') == 'done':
    print('done')
\"
" 20 3)

[ "$FINAL_STATUS" = "done" ] || fail "Parent issue not marked done (status=$FINAL_STATUS)"
pass "Parent issue marked done — pipeline completed successfully!"

# =============================================================================
# Step 8: Verify stage sub-issues are done
# =============================================================================
log "Step 8: Verify all stage sub-issues are done"

for sid in "$STAGE1_ISSUE_ID" "$STAGE2_ISSUE_ID"; do
  STATUS=$(curl -sf "$BASE/issues/$sid" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))")
  [ "$STATUS" = "done" ] || fail "Sub-issue $sid not done (status=$STATUS)"
done
pass "All stage sub-issues marked done"

# =============================================================================
# Summary
# =============================================================================
echo ""
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo -e "${GREEN} E2E TEST PASSED — Full pipeline lifecycle verified ${NC}"
echo -e "${GREEN}═══════════════════════════════════════════════════${NC}"
echo ""
echo "  Pipeline: e2e-test (implement → validate)"
echo "  Parent:   $PARENT_ISSUE_ID"
echo "  Stage 1:  $STAGE1_ISSUE_ID (implement) → done"
echo "  Stage 2:  $STAGE2_ISSUE_ID (validate) → done"
echo ""
