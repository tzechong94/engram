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

# ---- 2. build + push agent image --------------------------------------------
echo "==> Building agent image"
if command -v docker >/dev/null 2>&1; then
  ( cd "$ROOT/nanoclaw-v2" && ./container/build.sh )
  if [ -n "${ACR_IMAGE:-}" ]; then
    docker tag nanoclaw-agent:latest "$ACR_IMAGE" && docker push "$ACR_IMAGE"
  else
    echo "  set ACR_IMAGE=registry.<region>.aliyuncs.com/<ns>/nanoclaw-v2:<tag> to push"
  fi
else
  echo "  docker not found — build the image where Docker is available"
fi

# ---- 3. deploy components ----------------------------------------------------
echo "==> Deploying components (SAE / Function Compute)"
if command -v aliyun >/dev/null 2>&1; then
  echo "  aliyun CLI present — invoke your SAE/FC create-or-update here."
  echo "  (left as an explicit step so a misconfigured run can't mutate prod silently)"
else
  cat <<'EOF'
  aliyun CLI not found. Deploy steps:
    - Agent runtime  -> SAE app (image $ACR_IMAGE), env from .env.alibaba, 1 container/session
    - Memory MCP     -> co-located with the agent runtime (same service)
    - Sleep worker   -> Function Compute function; EventBridge rule on SLEEP_CRON invokes it
    - Channels       -> API Gateway routes WhatsApp/WeChat webhooks to the runtime
  Install: https://help.aliyun.com/document_detail/121541.html
EOF
fi

echo "==> Done. Smoke test, then capture the deploy proof."
