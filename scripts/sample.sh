#!/usr/bin/env bash
set -euo pipefail

PORT="${OPENMEMORY_PORT:-8080}"
BASE_URL="http://127.0.0.1:${PORT}"

echo "== Health =="
curl -sS "${BASE_URL}/health"
echo

echo "== Save 1 =="
curl -sS -X POST "${BASE_URL}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"memory.save","content":"User prefers docker compose for deployments","importance":0.9,"tags":["docker","deploy"]}'
echo

echo "== Save 2 =="
curl -sS -X POST "${BASE_URL}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"memory.save","content":"On Ubuntu, install Docker via apt repo and enable compose plugin","importance":0.7,"tags":["ubuntu","docker","compose"]}'
echo

echo "== Search =="
curl -sS -X POST "${BASE_URL}/mcp" \
  -H 'content-type: application/json' \
  -d '{"type":"memory.search","query":"docker deployment setup on ubuntu","limit":5}'
echo
