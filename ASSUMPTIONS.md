# Engram — Assumptions & Decisions Log

Reasonable calls made during the build, per the brief's instruction to log them
and proceed. Each is reversible unless noted.

## Architecture
- **Engine swap = new `qwen` provider in nanoclaw's provider registry**, driving the
  Qwen Code terminal agent in **ACP daemon mode** (`--experimental-acp`) over stdio,
  pointed straight at Model Studio/DashScope. No routing/middle layer (user directive:
  a direct coding-agent integration, like Qwen Code itself). Provider designed so a one-shot fallback can slot in.
- **Memory is a separable package reached over MCP.** `packages/memory` ships one core
  library with two thin entrypoints: an MCP server (stdio — the online path the agent
  calls) and a sleep worker (scheduled — runs the REM cycle by importing the core
  directly, not via MCP). Durable state in shared Postgres → all of a user's
  sessions/channels share memory → cross-channel recall is free.
- **nanoclaw-v2 is NOT a pnpm workspace member.** It stays a self-contained project and
  reaches memory as an MCP subprocess (`node .../memory/dist/mcp-server.js`) wired via
  `container.json`. Keeps memory forkable + zero agent-runtime coupling (Desk reuse).
- **Tenant = agent group's owner user id**, injected as `ENGRAM_TENANT_ID` env into the
  memory MCP server at container spawn. Cross-channel recall = same agent_group → same
  tenant → same memory.

## Repo / git
- **Deferred the destructive `git init engram` + vendor-nanoclaw (drop its upstream
  `.git`) step** to a clean finalization, to avoid risking nanoclaw's history mid-build.
  The local stack runs fine without it. Finalize when ready to publish the public repo:
  `rm -rf nanoclaw-v2/.git && git init && git add -A`.

## Memory model (Approach A — graph-in-Postgres)
- Knowledge graph is plain Postgres tables (`entities`/`edges`), not a graph DB —
  maps cleanly to AnalyticDB and avoids extra infra that fights the Alibaba constraint.
- Episode→cluster in the sleep phase uses embedding cosine-kNN with a threshold
  (cheap, deterministic-ish), not an LLM grouping pass.

## Models (confirm against Model Studio when key lands)
- `qwen-max` (chat + sleep synthesis), `qwen-turbo` (classification/extraction/online
  contradiction), `text-embedding-v3` @ 1024 dims, `gte-rerank`. IDs in `.env.example`.
- **Offline mock:** with `QWEN_MOCK=true` (default until a key is set), embeddings are
  deterministic hash→vector and consolidation/synthesis use a rule-based stub, so all
  tests + the eval harness pass with no API key. Real Qwen swaps in by setting
  `DASHSCOPE_API_KEY` and `QWEN_MOCK=false`.

## Infra interfaces (local ↔ Alibaba by config)
- `ENGRAM_INFRA=local|alibaba` flips Store/Vector/Blob/Queue/Scheduler/Secrets impls.
- Local: Postgres+pgvector (port 5433), Redis (6380), MinIO (9000). Cloud: AnalyticDB
  for PostgreSQL, Tair, OSS, Function Compute + EventBridge (sleep schedule).

## Scope (from CEO review — HOLD SCOPE, hero-first)
- Web signup → minimal CLI provisioning (reuse nanoclaw `init-first-agent` pattern).
- Channels: Telegram (polling) wired end-to-end; WhatsApp adapter wired but creds-gated;
  a **mock channel** drives the cross-channel recall eval without WhatsApp creds.
- Live Alibaba deploy proof is creds-gated; the `make deploy` config path is built.

## Security
- **Encryption at rest:** DB `content` is stored **plaintext** so keyword full-text search,
  vector embedding, and LLM consolidation all work; "at rest" is provided by storage-layer
  TDE (AnalyticDB) / disk encryption. App-level **AES-256-GCM** field encryption
  (`ENGRAM_ENCRYPTION_KEY`, `packages/shared/src/crypto.ts`) is applied to the **cold-archive
  blobs** (forgotten/consolidated raw episodes written to OSS/MinIO), which are never
  searched. Field encryption would break search if applied to `content`. Key falls back to
  plaintext with a loud warning if unset, so local dev isn't blocked; required in cloud.
- Strict per-tenant isolation: every memory query is scoped by `tenant_id`; the MCP server
  takes the tenant from `ENGRAM_TENANT_ID` (not tool args), so the agent cannot reach
  another tenant's memory. No query path omits `tenant_id`.

## Build-time refinements (logged as discovered)
- **Sleep step order: forget-sweep runs FIRST**, before clustering/consolidation, so stale
  low-value episodes are pruned and never pollute the durable notes (prune, then
  consolidate). The brief listed forget after consolidate; pruning first is cleaner and
  matches brain-like consolidation. The 7 steps: forget → cluster → consolidate → graph
  merge → reconcile → synthesize, each checkpointed.
- **Decay half-life = 30 days** (was 14): a personal-assistant timescale where ~1-month-old
  important facts survive but multi-month low-importance trivia decays below the forget
  threshold. Pinned/recently-accessed memories are always protected.
- **Qwen Code pinned to `@qwen-code/qwen-code@0.18.1`** (bin `qwen`) in
  `nanoclaw-v2/container/cli-tools.json`. ACP wire details (framing, method names) are
  verified on first live run — see `nanoclaw-v2/docs/qwen-engine.md`.
- **Memory MCP server runs inside the agent container** (stdio subprocess spawned by Qwen
  Code), connecting to shared Postgres. The sleep worker runs out-of-band on the same DB.
- **Knowledge graph clustering threshold is mock-aware** in the eval (0.15 for the noisier
  mock embeddings, 0.55 for real Qwen embeddings).

## Memory v2 (research-backed; CEO+Eng reviewed; "Hero bundle")
- **PPR retrieval (M1):** Personalized PageRank (`packages/memory/src/ppr.ts`, pure) runs
  as a *recall source* feeding the existing rerank+budgeter, seeded by query entities
  matched without an online LLM call (embedding/keyword). Restart α=0.5 for strong
  personalization. 1-hop fallback below 2 edges. Undirected graph (associative spread).
- **Bi-temporal (M2):** additive migration `0002` adds valid/transaction time +
  `invalidated_at` to notes/edges. Contradictions invalidate (not delete); the validity
  filter is centralized in `noteValidSql()` so no read path can leak stale memory. Mem0-style
  ADD/UPDATE/DELETE/NOOP ops recorded in `sleep_cycles.stats.memoryOps`.
- **Core memory (M3):** migration `0003` adds `core_memory` (bounded, per-tenant, `pinned`/
  `read_only`). A sleep step writes a `profile` block; `memory.search` always prepends core
  blocks (budget-counted) so the agent reads them first. Read-only blocks are protected from
  sleep writes.
- **Importance (M4):** consolidation rates importance 1-10 (stored on notes); the budgeter
  min-max normalizes its components; the sleep worker also fires on accumulated importance
  (`SLEEP_IMPORTANCE_THRESHOLD`).
- **Mock routing:** the offline mock routes on the *system* prompt (the step instruction),
  not user content, so a synthesis note's text can't misroute the profile step. Real Qwen
  is unaffected.
- **Viewer (V):** `packages/viewer` = a Node built-in-http server (read-only, tenant-scoped
  API over `MemoryRepo` read methods + `MemoryService.search`, no writes) serving a React +
  Vite + react-force-graph UI on one port. Multi-stage Dockerfile; `viewer` is a profiled
  docker-compose service (`make viewer-docker`) so the base stack stays lean. Auth: open
  locally, optional `VIEWER_TOKEN` bearer in cloud. Note: the runtime image currently copies
  the built workspace and runs the server via `tsx` — a follow-up can slim it to compiled JS
  + pruned deps.
