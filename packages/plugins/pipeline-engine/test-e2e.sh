#!/usr/bin/env bash
# E2E Test: Mock-Agent Pipeline Run
# Tests the full pipeline lifecycle without real LLM agents.
# Exercises: trigger → materialize → dispatch → output parse → advance → complete
set -euo pipefail

BASE="http://localhost:3100"
COMPANY_ID="f3f8f577-efb7-4b18-9c8a-e70656a09d38"
PLUGIN_ID="bf3901a7-72e3-42ee-a10a-670997636614"
OUTPUT_SENTINEL="<!-- pipeline-output -->"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass() { echo -e "${GREEN}✓ $1${NC}"; }
fail() { echo -e "${RED}✗ $1${NC}"; exit 1; }
info() { echo -e "${YELLOW}→ $1${NC}"; }

poll_until() {
  local desc="$1" cmd="$2" max="${3:-20}" interval="${4:-2}"
  for i in $(seq 1 "$max"); do
    result=$(eval "$cmd" 2>/dev/null || echo "")
    if [ -n "$result" ] && [ "$result" != "null" ] && [ "$result" != "" ]; then
      echo "$result"
      return 0
    fi
    sleep "$interval"
  done
  fail "Timed out waiting for: $desc"
}

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 0: Health check
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Checking Paperclip health..."
HEALTH=$(curl -sf "$BASE/api/health" | python3 -c "import json,sys; print(json.load(sys.stdin)['status'])")
[ "$HEALTH" = "ok" ] || fail "Paperclip not healthy"
pass "Paperclip is running"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 1: Save minimal test pipeline
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Saving e2e-test pipeline..."

PIPELINE_JSON='{
  "name": "e2e-test",
  "version": 1,
  "description": "Minimal 2-stage pipeline for E2E testing",
  "trigger": {"label": "pipeline:e2e-test"},
  "stages": [
    {"id": "implement", "type": "stage", "agent_role": "pipe-backend", "actionId": "write-implementation"},
    {"id": "validate", "type": "stage", "agent_role": "pipe-validator", "actionId": "validate-scenario-result"}
  ],
  "edges": [
    {"id": "e1", "from": "implement", "to": "validate"}
  ],
  "positions": {"implement": {"x": 400, "y": 0}, "validate": {"x": 400, "y": 200}}
}'

SAVE_RESULT=$(curl -sf "$BASE/api/plugins/$PLUGIN_ID/actions/save-pipeline" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"name\": \"e2e-test\", \"content\": $(echo "$PIPELINE_JSON" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}")

echo "$SAVE_RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); assert d.get('success'), f'Save failed: {d}'"
pass "Pipeline saved"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 2: Ensure trigger label exists
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Ensuring pipeline:e2e-test label exists..."

LABEL_ID=$(curl -sf "$BASE/api/companies/$COMPANY_ID/labels" \
  | python3 -c "import json,sys; labels=json.load(sys.stdin); matches=[l['id'] for l in labels if l['name']=='pipeline:e2e-test']; print(matches[0] if matches else '')")

if [ -z "$LABEL_ID" ]; then
  info "Creating label..."
  LABEL_ID=$(curl -sf "$BASE/api/companies/$COMPANY_ID/labels" \
    -X POST -H "Content-Type: application/json" \
    -d '{"name": "pipeline:e2e-test", "color": "#888888"}' \
    | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")
fi
pass "Label ready: $LABEL_ID"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 3: Update plugin config trigger_labels
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Adding e2e-test to trigger_labels config..."

CURRENT_CONFIG=$(curl -sf "$BASE/api/plugins/$PLUGIN_ID/config" \
  | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['configJson']))")

NEW_CONFIG=$(echo "$CURRENT_CONFIG" | python3 -c "
import json, sys
config = json.load(sys.stdin)
config.setdefault('trigger_labels', {})['pipeline:e2e-test'] = 'e2e-test'
print(json.dumps(config))
")

curl -sf "$BASE/api/plugins/$PLUGIN_ID/config" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"configJson\": $NEW_CONFIG}" > /dev/null

pass "Config updated with trigger label"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 4: Create issue with trigger label
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Creating test issue with pipeline:e2e-test label..."

ISSUE_ID=$(curl -sf "$BASE/api/companies/$COMPANY_ID/issues" \
  -X POST -H "Content-Type: application/json" \
  -d "{
    \"title\": \"[E2E TEST] Pipeline mock-agent test $(date +%H:%M:%S)\",
    \"description\": \"Automated E2E test — this issue should trigger the e2e-test pipeline and be completed by mock agent responses.\",
    \"status\": \"todo\",
    \"priority\": \"medium\",
    \"labelIds\": [\"$LABEL_ID\"]
  }" | python3 -c "import json,sys; print(json.load(sys.stdin)['id'])")

[ -n "$ISSUE_ID" ] || fail "Issue creation failed"
pass "Issue created: $ISSUE_ID"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 5: Wait for pipeline run + first stage dispatch
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Waiting for pipeline to materialize and dispatch first stage..."
sleep 3

# Find sub-issues (children of our issue)
IMPL_ISSUE_ID=$(poll_until "implement sub-issue created" \
  "curl -sf '$BASE/api/companies/$COMPANY_ID/issues?parentId=$ISSUE_ID' | python3 -c \"import json,sys; issues=json.load(sys.stdin); matches=[i['id'] for i in issues if 'implement' in i.get('title','')]; print(matches[0] if matches else '')\"" \
  15 2)

[ -n "$IMPL_ISSUE_ID" ] || fail "Implement sub-issue never appeared"
pass "Stage 'implement' dispatched → sub-issue: $IMPL_ISSUE_ID"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 6: Mock agent completes 'implement' stage
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Posting mock output for 'implement' stage..."

IMPL_OUTPUT='{"decision": "done", "summary": "Implementation complete — added feature X with tests passing."}'

COMMENT_BODY="$OUTPUT_SENTINEL
\`\`\`json
$IMPL_OUTPUT
\`\`\`"

curl -sf "$BASE/api/companies/$COMPANY_ID/issues/$IMPL_ISSUE_ID/comments" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"body\": $(echo "$COMMENT_BODY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" > /dev/null

pass "Mock output posted for 'implement'"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 7: Wait for 'validate' stage to be dispatched
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Waiting for 'validate' stage dispatch..."

VALIDATE_ISSUE_ID=$(poll_until "validate sub-issue created" \
  "curl -sf '$BASE/api/companies/$COMPANY_ID/issues?parentId=$ISSUE_ID' | python3 -c \"import json,sys; issues=json.load(sys.stdin); matches=[i['id'] for i in issues if 'validate' in i.get('title','')]; print(matches[0] if matches else '')\"" \
  15 2)

[ -n "$VALIDATE_ISSUE_ID" ] || fail "Validate sub-issue never appeared"
pass "Stage 'validate' dispatched → sub-issue: $VALIDATE_ISSUE_ID"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 8: Mock agent completes 'validate' stage
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Posting mock output for 'validate' stage..."

VALIDATE_OUTPUT='{"decision": "valid", "summary": "All scenarios pass."}'

COMMENT_BODY="$OUTPUT_SENTINEL
\`\`\`json
$VALIDATE_OUTPUT
\`\`\`"

curl -sf "$BASE/api/companies/$COMPANY_ID/issues/$VALIDATE_ISSUE_ID/comments" \
  -X POST -H "Content-Type: application/json" \
  -d "{\"body\": $(echo "$COMMENT_BODY" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')}" > /dev/null

pass "Mock output posted for 'validate'"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 9: Verify pipeline completed
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Waiting for pipeline to complete..."
sleep 3

PARENT_STATUS=$(curl -sf "$BASE/api/companies/$COMPANY_ID/issues/$ISSUE_ID" \
  | python3 -c "import json,sys; print(json.load(sys.stdin).get('status',''))")

if [ "$PARENT_STATUS" = "done" ]; then
  pass "Pipeline COMPLETED — parent issue status: done"
else
  echo -e "${YELLOW}  Parent issue status: $PARENT_STATUS (expected 'done')${NC}"
  # Check if pipeline run status gives more info
  # The run ID is not directly exposed via issue, but let's check comments
  info "Checking pipeline progress comment..."
  curl -sf "$BASE/api/companies/$COMPANY_ID/issues/$ISSUE_ID/comments" \
    | python3 -c "
import json, sys
comments = json.load(sys.stdin)
for c in comments:
    if 'Pipeline Progress' in c.get('body', ''):
        print(c['body'])
        break
else:
    print('No progress comment found')
"
  fail "Pipeline did not complete as expected (status: $PARENT_STATUS)"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# STEP 10: Cleanup
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
info "Cleaning up test pipeline..."
curl -sf "$BASE/api/plugins/$PLUGIN_ID/actions/delete-pipeline" \
  -X POST -H "Content-Type: application/json" \
  -d '{"name": "e2e-test"}' > /dev/null
pass "Test pipeline deleted"

echo ""
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  E2E TEST PASSED — Full pipeline lifecycle verified${NC}"
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo "  Trigger: label match → materialization"
echo "  Dispatch: sub-issue creation + agent assignment"
echo "  Completion: OUTPUT_SENTINEL parsing → stage advance"
echo "  Termination: all stages done → run completed → parent done"
