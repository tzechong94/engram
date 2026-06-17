# Engram Memory — Research Summary (state of the art, 2024-2026)

A digest of the deep-research pass behind Engram's memory design. Each technique is
mapped to where it lives (or will live) in Engram. Verification: 25 claims were
adversarially verified 3-0 (0 killed) across 21 primary sources; items marked
*lower-verification* had their sources fetched but their specific claims fall outside
that verified set, so treat them as well-sourced but not independently re-checked here.

## TL;DR
The field converges on five ideas. Engram already embodies the biggest architectural one
(offline "sleep-time" memory compute). The highest-leverage upgrades are **graph
PageRank retrieval** and **bi-temporal contradiction handling**.

## The techniques

### 1. Sleep-time compute / two-agent memory (Letta, MemGPT)
*Sources: letta.com/blog (sleep-time-compute, memory-blocks, agent-memory), arXiv 2504.13171, github letta-ai/sleep-time-compute. Vendor-primary; efficiency numbers synthetic/directional.*
- **Mechanism:** a primary agent handles the live conversation and never edits long-term
  memory; a separate background ("sleep-time") agent reorganizes raw context into reusable
  "learned context" during idle time. Memory management is off the hot path.
- **Why it works:** amortizes expensive cognition across many future queries; reported
  ~5× less test-time compute for equal accuracy and ~2.5× lower cost/query (synthetic
  benchmarks).
- **Engram:** already the core design — online path only captures/recalls; the **sleep
  phase** does all consolidation/graph/contradiction/synthesis. Upgrade adopted: maintain
  a per-tenant **"learned context"** profile during sleep (see #2).

### 2. Tiered, self-editing memory blocks (MemGPT/Letta)
*Sources: letta.com/blog/agent-memory, /memory-blocks, docs.letta.com. Vendor-primary.*
- **Mechanism:** four tiers — message buffer / core (in-context, bounded, editable) /
  recall (searchable history) / archival (external vector+graph). A core block = label +
  value + size limit; `read_only` blocks are developer-only.
- **Engram gap → adopted (M3):** add **core memory blocks** per tenant — a bounded,
  human-readable, sleep-maintained profile (preferences, durable facts) the agent reads
  first and cheaply. Same spirit as Karpathy's evolving "LLM wiki" file. `pinned/read_only`
  protects facts from decay/edit.

### 3. Personalized PageRank multi-hop retrieval (HippoRAG / HippoRAG 2)
*Sources: NeurIPS 2024 paper, arXiv 2502.14802 (ICML 2025). Peer-reviewed — strongest evidence.*
- **Mechanism:** build a schemaless KG from extracted triples; at query time, seed
  Personalized PageRank from the query's entities, let probability spread multi-hop across
  the graph, then aggregate node mass back onto passages/notes to rank them — multi-hop
  reasoning in a single retrieval step.
- **Why it works / trade-off:** matches iterative LLM retrievers (IRCoT) at **10-30×
  lower cost, 6-13× faster**; +11% R@2 / +20% R@5 on 2WikiMultiHopQA; HippoRAG 2 beats the
  SOTA embedding model ~7% on associative recall. Caveats: needs one query-time
  entity-extraction LLM call; proven on multi-hop QA; quality bounded by graph quality.
- **Engram gap → adopted (M1):** replace the naive **1-hop** graph expansion with PPR over
  the per-tenant entity graph, feeding the existing rerank + budgeter. The clearest win.

### 4. Importance + recency + relevance scoring; reflection (Stanford Generative Agents)
*Source: arXiv 2304.03442. Peer-reviewed.*
- **Mechanism:** retrieval score = recency + importance + relevance (each min-max
  normalized, equal weights). Recency = exponential decay since last access; importance =
  an LLM-rated 1-10 "poignancy"; relevance = embedding cosine. **Reflection** (synthesized
  higher-level insights) fires when accumulated importance crosses a threshold, building a
  tree of progressively abstract notes.
- **Engram gap → adopted (M4):** add **LLM importance (1-10)** at consolidation;
  **trigger sleep on importance-accumulation** (not just inactivity/cron); min-max
  normalize the budgeter's components. (Constants are that paper's choices — tune them.)

### 5. Bi-temporal knowledge graph + edge invalidation (Zep / Graphiti)
*Sources: getzep PDF, neo4j Graphiti blog, arXiv 2501.13956. Lower-verification (sources fetched; claims outside the verified top-25).*
- **Mechanism:** every fact/edge carries **valid-time** (when true in the world) and
  **transaction-time** (when recorded). New contradictory information **invalidates** the
  old edge (sets `invalidated_at`) instead of deleting it — preserving history and enabling
  "what did I believe at time T" queries.
- **Engram gap → adopted (M2):** add valid/transaction time + `invalidated_at` to notes
  and edges; the sleep reconcile step invalidates rather than only superseding; retrieval
  filters to currently-valid by default. Strongest upgrade for contradiction handling.

### 6. Mem0-style ADD / UPDATE / DELETE / NOOP memory ops
*Source: mem0.ai. Lower-verification.*
- **Mechanism:** extract candidate facts from a turn, compare against existing similar
  memories, and emit an explicit operation (add new / update existing / delete stale /
  no-op). Makes memory maintenance auditable.
- **Engram:** folded into M2 — reframe sleep reconciliation as explicit ops, logged in
  `sleep_cycles.stats`.

### 7. Agentic Zettelkasten notes + evolution (A-MEM)
*Source: arXiv 2502.12110. Peer-reviewed.*
- **Mechanism:** each memory becomes a structured note (keywords, tags, context) that is
  dynamically **linked** to similar existing notes; adding a note can **update** the linked
  notes — a self-revising knowledge network, emergent rather than only batch-synthesized.
- **Engram:** deferred (M6) — note↔note links + co-update; complements scheduled synthesis.

### 8. Benchmarks: LongMemEval, LoCoMo
*Sources: arXiv 2410.10813 (LongMemEval), LoCoMo. Lower-verification.*
- Standard multi-session conversational-memory QA suites for measuring recall, temporal
  reasoning, and contradiction handling over long histories.
- **Engram:** deferred (M7) — add LoCoMo/LongMemEval-style scenarios to the eval harness
  as an external yardstick.

## What Engram adopts this iteration (post-CEO review: "Hero bundle")
M1 (PPR retrieval) · M2 (bi-temporal + invalidation, incl. Mem0-style ops) · M3 (core
memory blocks / learned context) · M4 (LLM importance + reflection trigger) · plus the
brain-themed viewer. M6 (A-MEM linking) and M7 (benchmarks) deferred to TODOs.

## Honest caveats
- Letta efficiency figures are vendor/synthetic — directional, not guaranteed.
- HippoRAG needs a query-time entity-extraction LLM call; wins shown on multi-hop QA.
- Generative-Agents constants are implementation choices; tune for Engram.
- Zep/Mem0/benchmark specifics are well-sourced but lower-verification in this pass.

## Sources (primary)
HippoRAG (NeurIPS'24) · HippoRAG 2 / arXiv 2502.14802 · Generative Agents / arXiv 2304.03442 ·
A-MEM / arXiv 2502.12110 · Letta sleep-time-compute / arXiv 2504.13171 + letta.com blog/docs ·
Zep / getzep PDF + Graphiti (neo4j) + arXiv 2501.13956 · LongMemEval / arXiv 2410.10813 ·
Karpathy LLM-wiki gist · Mem0.ai.
