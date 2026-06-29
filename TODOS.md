# Engram — Roadmap / deferred work

Genuine future work, scoped out of the current build. Each has enough context to pick up cold.

## M6 — A-MEM Zettelkasten note-linking + evolution (P2)
When a semantic note is created, link it to similar existing notes (note↔note edges) and let
new notes update the linked ones ("memory evolution") — a self-revising knowledge network,
emergent synthesis between scheduled sleep cycles. Start: a `note_links(tenant_id, src, dst,
weight)` table; on `insertNote`, vector-search top-k similar notes and link; a sleep step
co-updates linked bodies. Source: A-MEM (arXiv 2502.12110).

## M7 — LoCoMo / LongMemEval benchmark harness (P2)
Add standard multi-session conversational-memory QA to `packages/eval` as an external
yardstick alongside the synthetic scenario, for credible third-party numbers. Start: adapt a
LoCoMo / LongMemEval sample into the eval's seed+query format; score recall/temporal/
contradiction. Sources: arXiv 2410.10813 (LongMemEval), LoCoMo.

## Memory MCP secret hygiene (P2)
The memory MCP subprocess currently gets `DASHSCOPE_API_KEY` / `ENGRAM_ENCRYPTION_KEY` in its
`container.json` env. Have it **inherit** these from the container env the credential proxy
already injects, instead of duplicating them. Verify nanoclaw's stdio MCP child inherits the
container process env first.

## Viewer runtime image slimming (P3)
The viewer Docker runtime copies the built workspace and runs via `tsx`. Compile
`server/index.ts` to JS, copy only `dist-server` + `dist-web` + runtime deps, run with
`node` — smaller image, faster cold start.

## Scale-out: memory over HTTP (P3)
Today the memory MCP server runs stdio in-container. For higher concurrency, run one
long-lived HTTP memory service with per-tenant tokens + pooled DB connections. Same MCP
protocol, same core, same schema — a transport/config swap, not a rewrite.

## Needs credentials, not code
- Real Qwen: `DASHSCOPE_API_KEY` + `QWEN_MOCK=false`.
- Telegram bot token / WhatsApp QR for the live agent.
- Live Alibaba deploy proof (see `deploy/alibaba/`).
