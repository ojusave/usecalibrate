#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-18765}"
BASE_URL="http://127.0.0.1:${PORT}"
ADMIN_TOKEN="smoke-token"
MANIFEST_JSON='{"version":"smoke-v1","groups":["start"],"steps":[{"id":"welcome","group":"start"}]}'
SERVER_LOG="$(mktemp)"

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  rm -f "$SERVER_LOG"
}
trap cleanup EXIT

PORT="$PORT" ADMIN_TOKEN="$ADMIN_TOKEN" MANIFEST_JSON="$MANIFEST_JSON" \
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
  -d '{"events":[{"sessionId":"smoke-session","seq":1,"ts":1000,"manifestVersion":"smoke-v1","type":"session_start"},{"sessionId":"smoke-session","seq":2,"ts":1100,"manifestVersion":"smoke-v1","type":"page_view","step":"welcome","nav":"forward"}]}' \
  "$BASE_URL/api/events"
echo

echo "GET /api/dashboard"
curl --fail --silent --show-error "$BASE_URL/api/dashboard"
echo

echo "GET /present"
curl --fail --silent --show-error "$BASE_URL/present" >/dev/null
echo "ok"

echo "GET /export"
curl --fail --silent --show-error \
  "$BASE_URL/export?token=$ADMIN_TOKEN"
