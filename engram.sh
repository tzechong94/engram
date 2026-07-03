#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Engram — one script to run the whole thing.
#
#   ./engram.sh up      Boot everything (infra + build + seed demo + viewer) and
#                       open the brain at http://localhost:8080
#   ./engram.sh down    Stop the viewer/sleep daemons and the docker stack
#   ./engram.sh test    Run the full test suite (incl. DB integration)
#   ./engram.sh eval    Run the eval harness (before/after-sleep report)
#   ./engram.sh sleep   Force a sleep/REM cycle now for the newest demo tenant
#   ./engram.sh status  Show what's running
#   ./engram.sh logs    Tail the viewer log
#
# No arguments == `up`. Re-runnable (idempotent).
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail
cd "$(dirname "$0")"

RUN_DIR=".data/run"
mkdir -p "$RUN_DIR"
VIEWER_PID="$RUN_DIR/viewer.pid"
SLEEP_PID="$RUN_DIR/sleep.pid"
VIEWER_LOG="$RUN_DIR/viewer.log"
SLEEP_LOG="$RUN_DIR/sleep.log"
VIEWER_PORT="${VIEWER_PORT:-8080}"

c_g() { printf "\033[32m%s\033[0m\n" "$1"; }   # green
c_b() { printf "\033[36m%s\033[0m\n" "$1"; }   # cyan
c_y() { printf "\033[33m%s\033[0m\n" "$1"; }   # yellow
c_r() { printf "\033[31m%s\033[0m\n" "$1"; }   # red
step() { printf "\033[36m▸ %s\033[0m\n" "$1"; }

# Pick docker compose v2 (`docker compose`) or v1 (`docker-compose`).
compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@";
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@";
  else c_r "Docker Compose not found. Install Docker Desktop."; exit 1; fi
}

check_prereqs() {
  command -v node >/dev/null 2>&1 || { c_r "Node.js 20+ required (https://nodejs.org)"; exit 1; }
  if ! command -v pnpm >/dev/null 2>&1; then
    step "pnpm not found — enabling via corepack"
    corepack enable >/dev/null 2>&1 || { c_r "Install pnpm: npm i -g pnpm"; exit 1; }
  fi
  docker info >/dev/null 2>&1 || { c_r "Docker isn't running. Start Docker Desktop and retry."; exit 1; }
}

load_env() {
  if [ ! -f .env ]; then step "creating .env from .env.example (offline defaults, no key needed)"; cp .env.example .env; fi
  # Parse .env safely: take everything after the first '=' literally (values may
  # contain spaces, e.g. SLEEP_CRON=0 4 * * *), never execute it.
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|\#*) continue ;; *=*) ;; *) continue ;; esac
    export "${line%%=*}=${line#*=}"
  done < .env
  export DATABASE_URL="${DATABASE_URL:-postgres://engram:engram@localhost:5433/engram}"
}

wait_for_pg() {
  step "waiting for Postgres to be ready"
  for _ in $(seq 1 40); do
    if compose exec -T postgres pg_isready -U engram >/dev/null 2>&1; then c_g "  Postgres ready"; return 0; fi
    sleep 1
  done
  c_r "Postgres did not become ready in time"; exit 1
}

is_running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# Kill whatever listens on a TCP port (the viewer binds one; reliable regardless
# of how the process was spawned — pnpm/tsx/node wrappers make PIDs unreliable).
kill_port() { local p; p=$(lsof -ti "tcp:$1" 2>/dev/null || true); [ -n "$p" ] && kill $p 2>/dev/null || true; }
# Kill a background worker by the script in its argv (the sleep scheduler has no port).
kill_match() { pkill -f "$1" 2>/dev/null || true; }
port_up() { curl -s -o /dev/null --max-time 2 "http://localhost:$1/" 2>/dev/null; }

cmd_up() {
  check_prereqs
  load_env
  step "installing dependencies"; pnpm install >/dev/null 2>&1 || pnpm install
  step "starting local infra (Postgres+pgvector, Redis, MinIO)"; compose up -d
  wait_for_pg
  step "applying database migrations"; pnpm --filter @engram/memory migrate >/dev/null 2>&1 && c_g "  migrations applied"
  step "building packages"; pnpm run build >/dev/null 2>&1 && c_g "  build complete"
  # No demo seeding — the viewer shows ONLY real memory (from the agent / your usage).
  # Run the eval explicitly for metrics: ./engram.sh eval

  # (re)start the brain viewer in the background
  kill_port "$VIEWER_PORT"
  step "starting the brain viewer on :$VIEWER_PORT"
  VIEWER_PORT="$VIEWER_PORT" ENGRAM_LOG_LEVEL="${ENGRAM_LOG_LEVEL:-info}" \
    nohup pnpm --filter @engram/viewer start >"$VIEWER_LOG" 2>&1 &
  echo $! > "$VIEWER_PID"

  # start the per-user sleep scheduler in the background (the self-managing memory)
  kill_match "sleep-worker"
  step "starting the sleep/REM scheduler"
  nohup pnpm --filter @engram/memory sleep >"$SLEEP_LOG" 2>&1 &
  echo $! > "$SLEEP_PID"

  sleep 2
  echo
  c_g "Engram is up."
  c_b "  Brain viewer   →  http://localhost:$VIEWER_PORT   (pick the eval-… tenant)"
  echo "  Eval report    →  packages/eval/out/report.md"
  echo "  Viewer logs    →  ./engram.sh logs        Stop everything → ./engram.sh down"
  [ "${QWEN_MOCK:-true}" = "true" ] && c_y "  (running on the offline mock — set DASHSCOPE_API_KEY + QWEN_MOCK=false in .env for real Qwen)"

  # Open the browser for the end user.
  if command -v open >/dev/null 2>&1; then open "http://localhost:$VIEWER_PORT" 2>/dev/null || true
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "http://localhost:$VIEWER_PORT" 2>/dev/null || true; fi
}

cmd_down() {
  step "stopping viewer + sleep daemons"
  kill_port "$VIEWER_PORT"
  kill_match "sleep-worker"
  kill_match "@engram/viewer"
  rm -f "$VIEWER_PID" "$SLEEP_PID"
  step "stopping docker stack"; compose down
  c_g "Engram stopped. (data preserved; './engram.sh up' to restart, or rm -rf .data to wipe)"
}

cmd_test() { check_prereqs; load_env; compose up -d >/dev/null 2>&1; wait_for_pg
  pnpm --filter @engram/memory migrate >/dev/null 2>&1
  step "running full test suite (unit + DB integration)"
  ENGRAM_TEST_DB=1 pnpm run test
}
cmd_agent() {
  c_y "The conversational agent has moved to its own project (an agent runtime that"
  c_y "consumes Engram's memory over MCP). Engram itself is the memory layer + viewer:"
  c_y "  ./engram.sh          # run the memory layer and the brain viewer"
  c_y "Any MCP-capable agent can attach: point it at packages/memory/dist/mcp-server.js"
  c_y "with ENGRAM_TENANT_ID + DATABASE_URL env (see ARCHITECTURE.md)."
}

cmd_eval()  { load_env; pnpm --filter @engram/eval start; }
cmd_sleep() { load_env; step "running the sleep/REM scheduler (Ctrl+C to stop)"; pnpm --filter @engram/memory sleep; }

# Manually trigger a "dream" (REM cycle) now, with verbose step-by-step logs so you
# can watch it think. Usage: ./engram.sh dream [tenant-id]  (defaults to newest tenant)
cmd_dream() { load_env
  local t="${2:-${TENANT:-}}"
  if [ -z "$t" ]; then
    t=$(docker exec engram-postgres-1 psql -U engram -d engram -tAc "SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1;" 2>/dev/null | tr -d '[:space:]')
  fi
  if [ -z "$t" ]; then
    c_r "No tenant found. Chat with the agent first, or pass one: ./engram.sh dream <tenant-id>"; exit 1
  fi
  c_b "💤 dreaming for tenant: $t  (verbose)"
  FORCE=1 TENANT="$t" ENGRAM_LOG_LEVEL=info pnpm --filter @engram/memory sleep
}
cmd_status() {
  port_up "$VIEWER_PORT" && c_g "viewer: running → http://localhost:$VIEWER_PORT" || c_y "viewer: stopped"
  pgrep -f "sleep-worker" >/dev/null 2>&1 && c_g "sleep scheduler: running" || c_y "sleep scheduler: stopped"
  compose ps 2>/dev/null || true
}
cmd_logs() { tail -f "$VIEWER_LOG"; }

case "${1:-up}" in
  up) cmd_up ;;
  down|stop) cmd_down ;;
  agent) cmd_agent ;;
  test) cmd_test ;;
  eval) cmd_eval ;;
  sleep) cmd_sleep ;;
  dream) cmd_dream "$@" ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *) echo "usage: ./engram.sh [up|agent|dream|down|test|eval|sleep|status|logs]"; exit 1 ;;
esac
