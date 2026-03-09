#!/bin/bash

# Ensure jq is available
if ! command -v jq &> /dev/null; then
    echo "jq is required but not installed. Skipping test."
    exit 0
fi

HARNESS_PORT=3000
HARNESS_TOKEN="test-web-approvals-$(date +%s)"
BASE_URL="http://localhost:$HARNESS_PORT"
TEST_DIR="/tmp/harness-web-approvals-test"
LOG_FILE="/tmp/guardian-web-approvals-harness.log"

# Find user config to copy real LLM settings (so Ollama/Anthropic works)
USER_CONFIG="$HOME/.guardianagent/config.yaml"
if [ -f "$USER_CONFIG" ]; then
  cat "$USER_CONFIG" > /tmp/harness-web-approvals-config.yaml
  echo "channels:" >> /tmp/harness-web-approvals-config.yaml
  echo "  cli:" >> /tmp/harness-web-approvals-config.yaml
  echo "    enabled: false" >> /tmp/harness-web-approvals-config.yaml
  echo "  web:" >> /tmp/harness-web-approvals-config.yaml
  echo "    enabled: true" >> /tmp/harness-web-approvals-config.yaml
  echo "    port: $HARNESS_PORT" >> /tmp/harness-web-approvals-config.yaml
  echo "    authToken: \"$HARNESS_TOKEN\"" >> /tmp/harness-web-approvals-config.yaml
else
  echo "[web-approvals] No user config found, LLM calls might fail if not local."
  exit 0
fi

echo "[web-approvals] Starting GuardianAgent..."

npx tsx src/index.ts "/tmp/harness-web-approvals-config.yaml" > "$LOG_FILE" 2>&1 &
APP_PID=$!

echo "[web-approvals] Waiting for /health..."
for i in {1..60}; do
  if curl -s -f "$BASE_URL/health" | grep -q '"status":"ok"'; then
    echo "[web-approvals] App is healthy"
    break
  fi
  sleep 1
done

if ! curl -s -f "$BASE_URL/health" | grep -q '"status":"ok"'; then
  echo "App failed to start. Logs:"
  tail -n 20 "$LOG_FILE"
  kill $APP_PID
  exit 1
fi

echo "[web-approvals] Setting policy..."
curl -s -X POST "$BASE_URL/api/tools/policy" \
  -H "Authorization: Bearer $HARNESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"mode":"approve_by_policy","sandbox":{"allowedPaths":["."],"allowedCommands":["node"]}}' > /dev/null

echo "[web-approvals] Web UI Simulation: Out of Bounds Write"
RESP1=$(curl -s -X POST "$BASE_URL/api/message" \
  -H "Authorization: Bearer $HARNESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"Write a file named 'web-ui-test.txt' to $TEST_DIR with content 'hello world'\",\"userId\":\"harness\",\"channel\":\"web\"}")

APPROVAL_ID=$(echo "$RESP1" | jq -r '.metadata.pendingApprovals[0].id // empty')
TOOL_NAME=$(echo "$RESP1" | jq -r '.metadata.pendingApprovals[0].toolName // empty')

if [ -z "$APPROVAL_ID" ]; then
  echo "FAIL: No pending approval metadata. Response: $RESP1"
  kill $APP_PID
  exit 1
fi
echo "  PASS: received pendingApprovals metadata ($TOOL_NAME: $APPROVAL_ID)"

echo "[web-approvals] Simulating Web UI approving $TOOL_NAME ($APPROVAL_ID)"
DECISION=$(curl -s -X POST "$BASE_URL/api/tools/approvals/decision" \
  -H "Authorization: Bearer $HARNESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"approvalId\":\"$APPROVAL_ID\",\"decision\":\"approved\",\"actor\":\"web-user\"}")

DECISION_SUCCESS=$(echo "$DECISION" | jq -r '.success // empty')
DECISION_MESSAGE=$(echo "$DECISION" | jq -r '.message // empty')

if [ "$DECISION_SUCCESS" != "true" ]; then
  echo "FAIL: API approval decision failed: $DECISION"
  kill $APP_PID
  exit 1
fi
echo "  PASS: API accepted approval decision"

CONTINUATION_MSG="[User approved the pending tool action(s). Result: $TOOL_NAME: $DECISION_MESSAGE] Please continue with the original task."
echo "[web-approvals] Sending continuation: $CONTINUATION_MSG"

RESP2=$(curl -s -X POST "$BASE_URL/api/message" \
  -H "Authorization: Bearer $HARNESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"content\":\"$CONTINUATION_MSG\",\"userId\":\"harness\",\"channel\":\"web\"}")

NEW_APPROVAL=$(echo "$RESP2" | jq -r '.metadata.pendingApprovals[0].toolName // empty')
CONTENT=$(echo "$RESP2" | jq -r '.content // empty')

if [ "$NEW_APPROVAL" == "$TOOL_NAME" ] || echo "$CONTENT" | grep -qi -E "loop|again|I need your approval"; then
  echo "FAIL: LLM is stuck in a loop. Response: $CONTENT"
  kill $APP_PID
  exit 1
fi

echo "  PASS: continuation successful"
echo "[web-approvals] LLM Final Response: $CONTENT"

kill $APP_PID
rm /tmp/harness-web-approvals-config.yaml
exit 0
