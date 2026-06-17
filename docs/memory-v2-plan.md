# Engram Memory v2 + Brain Viewer — Plan (research-backed)

Status: IMPLEMENTED — Hero bundle shipped (M1, M2, M3, M4, V). M6/M7 deferred → TODOS.md.

## GSTACK REVIEW REPORT
| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | SELECTIVE EXPANSION; Hero bundle accepted, M6/M7 deferred |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | PPR/bi-temporal/core/viewer locked; 0 critical gaps |
| Deep Research | `/deep-research` | Evidence base | 1 | DONE | 25 claims verified 3-0, 21 sources |

**VERDICT:** CEO + ENG CLEARED, implemented + tested (39 tests green; eval shows recall
100% before/after, forget 100%, PPR/bi-temporal/core all exercised). Deferred: M6, M7.


## CEO decision (2026-06-17)
Mode: SELECTIVE EXPANSION. **Accepted this iteration ("do the highest-impact"):**
M1 (PPR retrieval), M2 (bi-temporal + invalidation, incl. Mem0-style ADD/UPDATE/DELETE/
NOOP ops), M3 (core memory blocks / learned context), M4 (LLM importance + reflection
trigger), and the **full brain viewer (V)**.
**Deferred → TODOS:** M6 (A-MEM note linking), M7 (LoCoMo/LongMemEval benchmarks).
**Hard constraint:** the viewer must ship as a **simple, elegant container in the cloud
docker stack**, viewable in a browser on one port (a `viewer` service in docker-compose;
local `make up` brings it up; cloud deploy serves it the same way). No heavy frontend
toolchain that complicates the container.
Research summary written to `docs/memory-research-summary.md`.


Date: 2026-06-17
Inputs: deep-research report (25 claims verified 3-0; sources: Letta, HippoRAG
NeurIPS'24/ICML'25, Generative Agents, A-MEM, Zep/Graphiti, Karpathy LLM-wiki,
LongMemEval/LoCoMo) + the shipped Engram v1 (episodic→semantic consolidation, KG in
Postgres, decay/forget, contradiction supersede, synthesis, hybrid recall + budgeter,
offline sleep phase).

## What the research says (digest → Engram gap)

| Technique (source, evidence) | What Engram has | Gap / upgrade |
|---|---|---|
| **Personalized PageRank multi-hop retrieval** — HippoRAG/HippoRAG2 (NeurIPS'24, ICML'25; peer-reviewed). Single-pass multi-hop beats SOTA embeddings ~7% on associative recall; matches iterative LLM retrievers at 10-30× lower cost, 6-13× faster. | 1-hop graph expansion from seed notes | **Replace 1-hop with PPR** seeded by query entities over the entity graph; aggregate node mass back to notes/episodes. Strongest-evidence win. |
| **Bi-temporal KG + edge invalidation** — Zep/Graphiti (sources fetched; claim budget-dropped, so lower-verification). valid-time vs transaction-time; contradicted edges get `invalidated_at` not deleted. | notes get `superseded_by`; episodes hard-status | **Add bi-temporal fields** (`valid_from/valid_to`, `recorded_at`, `invalidated_at`) to notes + edges; contradiction → invalidate, don't delete. Enables "what did I believe at T". |
| **Two-agent sleep-time compute** — Letta (vendor-primary). Memory edits off the real-time path; idle time precomputes reusable "learned context"; ~5× test-time compute cut, ~2.5× amortized (synthetic benchmarks, directional). | online path already write/search only; sleep phase does all cognition | **Mostly already done.** Add: precompute "learned context" (a per-tenant evolving profile the agent reads cheaply) during sleep. |
| **Tiered self-editing memory blocks** — MemGPT/Letta (vendor-primary). core (bounded, in-context) / recall / archival; `read_only` developer blocks. | episodes + notes + graph; no bounded human-readable core | **Add `core_memory` blocks** per tenant: labeled, size-bounded, sleep-maintained, human-readable (also = Karpathy LLM-wiki pattern). `pinned/read_only` for protected facts. |
| **Importance scoring + reflection trigger** — Generative Agents (peer-reviewed). score = recency+importance+relevance (min-max normalized); LLM 1-10 importance; reflection fires when Σimportance > threshold. | heuristic importance; budgeter has recency+importance+relevance+diversity; sleep triggered by inactivity/cron | **LLM importance (1-10)** during sleep; **importance-accumulation trigger** for sleep (Σ since last cycle > threshold) alongside inactivity/cron; min-max normalize budgeter components. |
| **Mem0 ADD/UPDATE/DELETE/NOOP** — (source budget-dropped; lower-verification). extract candidate facts → diff vs existing → explicit op. | sleep reconcile = pairwise supersede | **Reframe reconciliation** as explicit ADD/UPDATE/DELETE/NOOP ops vs existing similar memories (cleaner, auditable). |
| **A-MEM Zettelkasten linking + evolution** — (peer-reviewed arXiv). new note → structured note (keywords/tags) + dynamic links to similar notes + update linked notes. | notes; scheduled batch synthesis only | **Note↔note links + evolution**: on new note, link to similar notes and let them co-update; emergent synthesis between scheduled cycles. |
| **Benchmarks** — LongMemEval, LoCoMo (sources fetched). standard agent-memory eval suites. | custom eval harness | **Add LoCoMo/LongMemEval-style** multi-session QA to the eval harness for an external yardstick. |

Caveats carried from research: Letta efficiency numbers are vendor/synthetic (directional);
HippoRAG still needs one query-time entity-extraction LLM call and is proven on multi-hop QA;
Generative Agents constants are that paper's choices (tune them); Zep/Mem0 specifics are
lower-verification here (sources fetched, claims not in the verified top-25).

## Proposed work — two streams

### Stream M: Memory layer v2 (prioritized)
- **M1 — PPR multi-hop retrieval** (Tier 1, highest evidence). In-memory Personalized
  PageRank over the per-tenant entity graph, seeded by query entities, mass aggregated to
  notes/episodes; runs as a recall source feeding the existing rerank+budgeter. Keep 1-hop
  as fallback for tiny graphs.
- **M2 — Bi-temporal model + invalidation** (Tier 1). Add valid/transaction time +
  `invalidated_at` to notes & edges; contradiction reconcile invalidates instead of
  supersede-only; retrieval filters to currently-valid by default; enables time-travel reads.
- **M3 — Core memory blocks / learned context** (Tier 2). `core_memory(tenant, label, body,
  size_limit, read_only)`; sleep phase maintains a bounded human-readable profile
  (preferences, key facts) — the cheap context the agent reads first. (Letta + LLM-wiki.)
- **M4 — LLM importance + reflection trigger** (Tier 2). 1-10 importance at consolidation;
  sleep also fires on importance-accumulation; min-max normalize budgeter scoring.
- **M5 — ADD/UPDATE/DELETE/NOOP reconciliation** (Tier 2). Reframe sleep reconcile as
  explicit ops; auditable in `sleep_cycles.stats`.
- **M6 — A-MEM note linking + evolution** (Tier 3). note↔note links; co-update on insert.
- **M7 — LoCoMo/LongMemEval harness** (Tier 3). external benchmark scenarios in `packages/eval`.

### Stream V: Brain-themed memory viewer
- **V1 — Memory read API.** `packages/viewer` ships a tiny **Node built-in-http** server
  (no express) that serves a read-only, tenant-scoped JSON API using ONLY `MemoryRepo`
  read methods + `MemoryService.search` (zero coupling to internals, zero writes):
  `/api/:tenant/graph` (entities/edges + salience/weight + validity), `/notes`, `/episodes`,
  `/cycles` (sleep_cycles before/after + checkpoints), `/search?q=` (returns packing trace),
  `/asof?t=` (bi-temporal). Auth: open locally, optional `VIEWER_TOKEN` bearer in cloud.
- **V2 — Brain UI (LOCKED: Vite + React + react-force-graph).** Multi-stage Docker build
  (builder stage runs `vite build` → `dist/`; runtime image = node:slim + API server +
  static dist, NO node_modules/vite shipped — runtime container stays lean). Same server
  serves the API + the built assets on one port. Neural aesthetic: entities = neurons
  (size=salience), edges = synapses (thickness=weight), notes = consolidated clusters,
  episodes = a fading sensory buffer.
  - **Sleep animation:** play a cycle — raw episodes collapse into notes, the graph grows a
    synapse (synthesis lights up), stale nodes fade (forget), a contradicted edge greys out
    (invalidation). Driven by `sleep_cycles` before/after + checkpoints.
  - **Recall view:** type a query → highlight the PPR activation spreading across the graph
    and show the budgeter packing trace (what was selected and why).
  - **Timeline scrubber** over sleep cycles; bi-temporal "as of T" toggle.

## Demo story (3-min)
Chat → memories appear as neurons firing in the sensory buffer → trigger a sleep cycle →
watch consolidation collapse episodes into glowing semantic clusters, a new synapse form
(synthesis), a stale memory fade (forget), a contradiction grey out (invalidation) → ask a
question → watch PPR activation spread multi-hop and the budgeter pack the answer → show the
eval table (recall holds, active set shrank, LongMemEval score).

## Open questions for review
- M1: PPR as a *recall source feeding rerank+budgeter* vs *reranker over candidates*? (lean: recall source.)
- Scope for "today/this iteration": which tier(s) + viewer depth?
- Viewer: bundle into the engram monorepo (`packages/viewer-*`) vs standalone? read-only API auth model?
- Bi-temporal migration: additive columns + backfill (non-breaking) — confirm.
