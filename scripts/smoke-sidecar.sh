#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-18765}"
BASE_URL="http://127.0.0.1:${PORT}"
ADMIN_TOKEN="smoke-token"
DASHBOARD_TOKEN="smoke-dashboard-token"
WRITE_KEY="smoke-write-key"
MANIFEST_JSON='{"version":"smoke-v1","groups":["start"],"steps":[{"id":"welcome","group":"start"}]}'
NOW_MS="$(node -e 'process.stdout.write(String(Date.now()))')"
SERVER_LOG="$(mktemp)"

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -f "$SERVER_LOG"
}
trap cleanup EXIT

PORT="$PORT" ADMIN_TOKEN="$ADMIN_TOKEN" DASHBOARD_TOKEN="$DASHBOARD_TOKEN" \
  WRITE_KEY="$WRITE_KEY" MANIFEST_JSON="$MANIFEST_JSON" \
  node packages/kit/dist/sidecar.js >"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

for _ in {1..50}; do
  if curl --fail --silent "$BASE_URL/healthz" >/dev/null; then
    break
  fi
  sleep 0.1
done

echo "POST /api/events"
curl --fail --silent --show-error \
  -H "Content-Type: application/json" \
  -H "X-Firstmile-Write-Key: $WRITE_KEY" \
  -d "{\"events\":[{\"sessionId\":\"smoke-session\",\"seq\":1,\"ts\":$NOW_MS,\"manifestVersion\":\"smoke-v1\",\"type\":\"session_start\"},{\"sessionId\":\"smoke-session\",\"seq\":2,\"ts\":$NOW_MS,\"manifestVersion\":\"smoke-v1\",\"type\":\"page_view\",\"step\":\"welcome\",\"nav\":\"forward\"}]}" \
  "$BASE_URL/api/events"
echo

echo "GET /api/dashboard"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $DASHBOARD_TOKEN" \
  "$BASE_URL/api/dashboard"
echo

echo "GET /present"
curl --fail --silent --show-error "$BASE_URL/present" >/dev/null
echo "ok"

echo "GET /export"
curl --fail --silent --show-error \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  "$BASE_URL/export"
