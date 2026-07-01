# Engram: Design Decisions

The calls that shaped the final system, and why.

## Memory is a separable MCP service
- `packages/memory` is one core library with two entrypoints: an **MCP server** (stdio,
 the online path the agent calls) and a **sleep worker** (scheduled, imports the core
 directly, not over MCP). Durable state lives in shared Postgres, so all of a user's
 sessions and channels share memory → cross-channel recall is free.
- The agent runtime stays fully decoupled: it reaches memory as an MCP subprocess. The
 memory layer drops into any agent.
- **Tenant = the owner user id**, injected as `ENGRAM_TENANT_ID` into the MCP server at
 spawn (never from tool args), so an agent can't reach another tenant's memory.

## The knowledge graph is plain Postgres
`entities` / `edges` tables, not a graph DB, maps cleanly to AnalyticDB and avoids extra
infra. Episode→cluster in the sleep phase uses embedding cosine-kNN with a threshold
(cheap, deterministic-ish), not an LLM grouping pass.

## Sleep order: forget first
The 7 steps run **forget → cluster → consolidate → graph-merge → reconcile → synthesize →
profile**, each checkpointed. Pruning stale, low-value episodes *before* consolidation keeps
junk out of the durable notes. Decay half-life is **30 days** (a personal-assistant
timescale); pinned/recently-accessed memories are always protected.

## Retrieval (research-backed)
- **PPR (HippoRAG):** Personalized PageRank over the entity graph is a recall source feeding
 the rerank + budgeter, seeded by query entities matched without an online LLM call (α=0.5;
 1-hop fallback for tiny graphs).
- **Bi-temporal (Zep/Graphiti):** notes/edges carry valid + transaction time; contradictions
 *invalidate* rather than delete (preserved for "as of T" reads). The validity filter is
 centralized (`noteValidSql()`) so no read leaks stale memory. Mem0-style ADD/UPDATE/
 DELETE/NOOP ops recorded in `sleep_cycles.stats`.
- **Core memory (MemGPT/Letta):** a bounded, per-tenant `profile` block the sleep phase
 maintains; `memory.search` always prepends it (budget-counted).
- **Importance (Generative Agents):** consolidation rates importance 1–10; the budgeter
 min-max normalizes relevance/recency/importance/diversity; sleep can also fire on
 accumulated importance.

## Models (Model Studio / DashScope)
`qwen-max` (chat + sleep synthesis), `qwen3-coder` (agent engine), embeddings @ 1024 dims,
`gte-rerank`. **Offline mock** (`QWEN_MOCK=true`, default until a key is set): deterministic
hash→vector embeddings + rule-based stubs, so all tests and the eval pass with no API key.
Real Qwen swaps in via `DASHSCOPE_API_KEY` + `QWEN_MOCK=false`.

## Local ↔ Alibaba is a config swap
`ENGRAM_INFRA=local|alibaba` flips Store / Vector / Blob / Queue / Scheduler / Secrets.
Local: Postgres+pgvector (5433), Redis (6380), MinIO (9000). Cloud: AnalyticDB for
PostgreSQL, Tair, OSS, Function Compute + EventBridge.

## Security
- Strict per-tenant isolation: every query is scoped by `tenant_id`; the MCP server takes
 the tenant from env, not tool args.
- DB `content` is plaintext so full-text search, embeddings, and consolidation work; "at
 rest" is storage-layer TDE / disk encryption. App-level **AES-256-GCM** encrypts the
 **cold-archive blobs** (forgotten/consolidated raw episodes in OSS/MinIO), which are never
 searched.

## Agent engine
NanoClaw runtime with a `qwen` provider driving **Qwen Code** (`@qwen-code/qwen-code`,
pinned) in ACP daemon mode over stdio, pointed straight at Model Studio. Channels: Telegram
(polling) end-to-end; WhatsApp wired but creds-gated; a mock channel drives the cross-channel
recall eval without WhatsApp creds.
