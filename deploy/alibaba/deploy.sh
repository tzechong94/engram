#!/usr/bin/env bash
# Engram → Alibaba Cloud deploy entrypoint (config-swap). Validates config and
# walks the deploy. Actual cloud CLI calls are gated on account credentials; if the
# aliyun CLI is absent the script prints the exact commands to run.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENV_FILE="${ENGRAM_ENV_FILE:-$ROOT/.env.alibaba}"

echo "==> Engram Alibaba deploy"
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Copy deploy/alibaba/.env.alibaba.example and fill it in." >&2
  exit 1
fi
# shellcheck disable=SC1090
set -a; . "$ENV_FILE"; set +a

# ---- preflight ---------------------------------------------------------------
fail=0
require() { if [ -z "${!1:-}" ]; then echo "  MISSING: $1" >&2; fail=1; else echo "  ok: $1"; fi; }
echo "==> Preflight config check"
require ENGRAM_INFRA
require DATABASE_URL
require DASHSCOPE_API_KEY
require ENGRAM_ENCRYPTION_KEY
require BLOB_ENDPOINT
[ "${ENGRAM_INFRA:-}" = "alibaba" ] || { echo "  ENGRAM_INFRA must be 'alibaba'" >&2; fail=1; }
[ "${QWEN_MOCK:-true}" = "false" ] || { echo "  QWEN_MOCK must be 'false' for a real deploy" >&2; fail=1; }
if [ "$fail" = "1" ]; then echo "Preflight failed. Fix $ENV_FILE and retry." >&2; exit 1; fi

# ---- 1. migrate AnalyticDB ---------------------------------------------------
echo "==> Applying migrations to AnalyticDB"
( cd "$ROOT" && DATABASE_URL="$DATABASE_URL" pnpm --filter @engram/memory migrate )

# ---- 2. (agent image) --------------------------------------------------------
# Agent runtimes live in their own repos and attach to Engram over MCP; build and
# deploy them from there. Engram itself ships the memory service + viewer only.

# ---- 3. deploy components ----------------------------------------------------
echo "==> Deploying components (SAE / Function Compute)"
if command -v aliyun >/dev/null 2>&1; then
  echo "  aliyun CLI present — invoke your SAE/FC create-or-update here."
  echo "  (left as an explicit step so a misconfigured run can't mutate prod silently)"
else
  cat <<'EOF'
  aliyun CLI not found. Deploy steps:
    - Memory MCP + viewer -> ECS VM or SAE app, env from .env.alibaba
    - Sleep worker   -> Function Compute function; EventBridge rule on SLEEP_CRON invokes it
    - Agent runtimes -> separate repos; they attach to the memory MCP over stdio/HTTP
  Install: https://help.aliyun.com/document_detail/121541.html
EOF
fi

echo "==> Done. Smoke test, then capture the deploy proof."
