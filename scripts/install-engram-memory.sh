#!/usr/bin/env bash
# Wire the Engram memory MCP into a NanoClaw agent group — the one Engram-specific
# bit of agent setup (the channels/runtime are nanoclaw's). Same pattern as
# `add-mnemon`: register an MCP server in the group's container config.
#
#   bash scripts/install-engram-memory.sh <agent-group-id> <tenant-id>
#
# Requires the nanoclaw host to be running (ncl talks to it over a socket).
# Transport-agnostic by design: today it wires the stdio memory server (a Node
# subprocess in the container → Postgres). To graduate to the HTTP memory service
# later, set ENGRAM_MEMORY_URL and this writes a remote-MCP config instead — same
# tool names, no agent change.
set -euo pipefail
cd "$(dirname "$0")/.."

GROUP="${1:-}"; TENANT="${2:-}"
if [ -z "$GROUP" ] || [ -z "$TENANT" ]; then
  echo "usage: bash scripts/install-engram-memory.sh <agent-group-id> <tenant-id>" >&2
  exit 1
fi

# Load .env for the secrets the memory server needs.
[ -f .env ] && while IFS= read -r l || [ -n "$l" ]; do case "$l" in ''|\#*) ;; *=*) export "${l%%=*}=${l#*=}";; esac; done < .env

MCP_PATH="$(pwd)/packages/memory/dist/mcp-server.js"
[ -f "$MCP_PATH" ] || { echo "Building memory package…"; pnpm --filter @engram/memory build >/dev/null; }

# The container reaches the host Postgres via host.docker.internal (Docker Desktop).
# In cloud, point this at AnalyticDB via ENGRAM_MEMORY_DB_URL.
CONTAINER_DB_URL="${ENGRAM_MEMORY_DB_URL:-postgres://engram:engram@host.docker.internal:5433/engram}"

ENV_JSON=$(cat <<JSON
{"ENGRAM_TENANT_ID":"$TENANT","DATABASE_URL":"$CONTAINER_DB_URL","QWEN_MOCK":"${QWEN_MOCK:-false}","DASHSCOPE_API_KEY":"${DASHSCOPE_API_KEY:-}","DASHSCOPE_BASE_URL":"${DASHSCOPE_BASE_URL:-https://dashscope-intl.aliyuncs.com/compatible-mode/v1}","ENGRAM_ENCRYPTION_KEY":"${ENGRAM_ENCRYPTION_KEY:-}"}
JSON
)

echo "Wiring Engram memory MCP → agent group $GROUP (tenant $TENANT)…"
if [ -n "${ENGRAM_MEMORY_URL:-}" ]; then
  echo "  (HTTP transport: $ENGRAM_MEMORY_URL — remote MCP)"
  # Future HTTP path: nanoclaw remote MCP config. Documented; stdio is the default today.
  echo "  NOTE: HTTP transport wiring is the planned scale-out upgrade; using stdio for now." >&2
fi

ARGS_JSON="[\"$MCP_PATH\"]"
run_ncl() { ( cd nanoclaw-v2 && pnpm ncl "$@" ); }

if run_ncl groups config add-mcp-server --id "$GROUP" --name memory --command node --args "$ARGS_JSON" --env "$ENV_JSON"; then
  echo "  ✓ memory MCP added. Restarting the group so it takes effect…"
  run_ncl groups restart --id "$GROUP" || echo "  (restart it manually: cd nanoclaw-v2 && pnpm ncl groups restart --id $GROUP)"
  echo "Done. The agent now has mcp__memory__{write,search,forget}."
else
  cat <<EOF >&2

Could not run ncl automatically (is the nanoclaw host running?). Run this manually:

  cd nanoclaw-v2
  pnpm ncl groups config add-mcp-server --id $GROUP --name memory \\
    --command node --args '$ARGS_JSON' \\
    --env '$ENV_JSON'
  pnpm ncl groups restart --id $GROUP
EOF
  exit 1
fi
