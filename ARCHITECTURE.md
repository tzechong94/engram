# Engram Architecture

Engram is a **self-managing memory layer for AI agents**, built entirely on Qwen: a
separable MCP service whose **sleep phase** consolidates, forgets, reconciles, and
connects memories during downtime. Any MCP-capable agent runtime attaches by spawning
the memory server with a tenant id; the built-in viewer ships a live chat agent, the
brain visualization, and the proof panel.

## System diagram

### Rendered (Mermaid)

```mermaid
flowchart TB
  User["👤 User"]

  AGENT["🤖 Your agent · any MCP-capable runtime<br/>(the viewer ships a live chat agent)"]

  QWEN["☁️ Qwen · Model Studio / DashScope<br/>qwen-max · qwen-turbo · text-embedding-v3 · gte-rerank · qwen-vl"]

  subgraph ENGRAM["⭐ Engram memory layer · MCP server, THE JUDGED CONTRIBUTION (100% Qwen)"]
    direction TB
    ONLINE["Online path (hot): write · search · forget"]
    RECALL["Hybrid recall: vector + keyword + graph-PPR<br/>→ rerank → token budgeter → packed context + trace"]
    SLEEP["💤 Sleep / REM cycle (offline):<br/>forget → cluster → consolidate → graph-merge<br/>→ reconcile (bi-temporal) → synthesize → profile"]
    ONLINE --> RECALL
  end

  subgraph STORE["Storage · local ↔ Alibaba Cloud (config swap)"]
    PG[("Postgres + pgvector<br/>episodes · notes · entities · edges · profile · sleep_cycles")]
    REDIS[("Redis / Tair · queue")]
    BLOB[("Blob / OSS · encrypted cold archive")]
  end

  VIEWER["🧠 Viewer · graph · dream trace · two-brains · live proof"]
  EVAL["✅ Eval · 12-gate suite · 3× real Qwen · all green"]

  User <--> AGENT
  AGENT <-->|reason| QWEN
  AGENT -->|"MCP · write / search / forget"| ONLINE
  ONLINE <--> PG
  RECALL -. embed + rerank .-> QWEN
  SLEEP <--> PG
  SLEEP -. consolidate + reconcile .-> QWEN
  ONLINE -.-> BLOB
  ONLINE --> REDIS
  VIEWER --> PG
  EVAL --> ENGRAM
```

### Detail (ASCII)

```
 YOUR AGENT (any MCP-capable runtime)                       MEMORY (the hero, MCP)
 ┌───────────────────────────────────┐                      ┌────────────────────────┐
 │ chat app · bot · assistant        │                      │ memory MCP server      │
 │ (the viewer ships a live chat     │        MCP           │  memory.write          │
 │  agent; the eval uses mock        │───────stdio──────▶   │  memory.search (+pack) │
 │  channels)                        │                      │  memory.forget         │
 └───────────────────┬───────────────┘                      └───────────┬────────────┘
                     │ tenant_id env                                    │ core lib (direct)
                     ▼                                                  ▼
                          ┌─────────────────────────────────────────────────────────┐
                          │ packages/shared,  infra interfaces                       │
                          │ Store · Vector · Blob · Queue · Scheduler · Secrets       │
                          │ QwenClient (DashScope, behind interface + offline mock)   │
                          └───────────────┬─────────────────────────────────────────┘
                ┌──────────────────────────┴───────────────────┐
                ▼ online (fast, cheap)                          ▼ offline (scheduled)
   ┌──────────────────────────┐                  ┌──────────────────────────────────┐
   │ write+embed, dedup, DLQ   │                  │ SLEEP / REM CYCLE                 │
   │ hybrid recall → rerank →  │                  │ cluster→consolidate→graph-merge→  │
   │ context budgeter (trace)  │                  │ forget→reconcile→synthesize       │
   └──────────────────────────┘                  │ checkpointed · cost-bounded ·     │
                                                  │ observable (cycle report)         │
                                                  └──────────────────────────────────┘

 local stack   :  Postgres+pgvector (5433) · Redis (6380) · MinIO (9000)
 alibaba (swap):  AnalyticDB for PostgreSQL · Tair · OSS · FunctionCompute+EventBridge
```

## The two memory paths

**Online (real-time, fast & cheap)**: `memory.write` does lightweight episodic capture
plus embedding with content-hash dedup; `memory.search` runs hybrid recall (vector ANN +
keyword + one hop of graph), reranks, then the **context budgeter** packs candidates under
a token budget scoring `w1·relevance + w2·recency_decay + w3·importance + w4·diversity`
and returns the packing trace. `memory.forget` is explicit. All heavy cognition is
deferred to the sleep phase.

**Sleep phase / REM cycle (offline, during downtime)**: per-user, triggered by
inactivity or a nightly schedule (whichever first), or forced for a demo. Steps:
1. cluster recent active episodes (embedding cosine-kNN)
2. consolidate each cluster into a durable semantic note (Qwen-Max)
3. merge entities/edges into the personal knowledge graph (Qwen-Turbo extraction)
4. forgetting/decay sweep (archive/forget low-value, unaccessed episodes)
5. batch contradiction reconciliation (flag overlaps, resolve, supersede stale notes)
6. cross-cluster synthesis (surface new connections that didn't exist before)
7. checkpoint after each step; enforce per-tenant cost cap; emit an observable report.

## Memory v2 (research-backed: `docs/memory-research-summary.md`)
- **Multi-hop retrieval:** Personalized PageRank over the entity graph (HippoRAG) is a
  recall source feeding rerank + budgeter, seeded by query entities (no online LLM call);
  1-hop fallback for tiny graphs.
- **Bi-temporal + invalidation (Zep/Graphiti):** notes/edges carry valid + transaction time;
  contradictions invalidate (preserved for "as of T" reads), recorded as Mem0-style
  ADD/UPDATE/DELETE/NOOP ops. The validity filter is centralized so no read leaks stale memory.
- **Core memory blocks (MemGPT/Letta + LLM-wiki):** a bounded, human-readable per-tenant
  profile maintained by the sleep phase; `memory.search` prepends it cheaply.
- **Importance + reflection (Generative Agents):** LLM-rated 1-10 importance; min-max
  normalized budgeter; sleep fires on accumulated importance, not just inactivity/cron.

## Memory viewer (brain UI)
`packages/viewer`: a tenant-scoped JSON API over `MemoryRepo` + `MemoryService` and a
React/Vite neural-graph UI on one port (`http://localhost:8080`). Entities = neurons,
edges = synapses (invalidated ones grey out); recall lights up activated neurons and shows
the budgeter's per-candidate packing trace; sleep cycles show before→after consolidation
with a step-by-step dream trace. For the demo it adds:
- **▶ Demo Mode**: a self-running arc: teach → ask → dream → update a fact → dream → ask
  again (answers the new value, old gone).
- **Ask both brains**: the same question answered *with* Engram memory vs a no-memory model.
- **Teach Engram**: type a fact and watch it get remembered.
- **Proof panel**: the eval gate results (3× real Qwen) live in the UI.

## Data model
See `packages/memory/src/db/migrations/`. Tables: `tenants`, `episodes`,
`semantic_notes` (+ bi-temporal cols + importance), `entities`, `edges` (+ bi-temporal),
`contradictions`, `sleep_cycles` (stats incl. memoryOps), `core_memory`, `queue_items`.

## Local ↔ Cloud
Everything is behind `packages/shared` interfaces selected by `ENGRAM_INFRA`. No
hardcoded cloud endpoints; deploying to Alibaba is a config swap. See `deploy/alibaba/`.

## Multi-tenancy & isolation
The agent runtime isolates sessions; memory is scoped per tenant
(`tenant_id` = the owner user id) on every query; content is encrypted at rest. The
sleep phase is isolated and cost-bounded per tenant so one user's cycle can't starve
others.
