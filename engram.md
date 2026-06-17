# Engram: Personal Agent with a Self-Managing Cloud Memory (Claude Code Build Brief)

Track 1: MemoryAgent. Qwen Cloud Hackathon.

Mission: a cloud-hosted personal agent, codename Engram, that the user reaches through Telegram, WhatsApp, and WeChat. It reasons on Qwen and is built around a cloud memory layer that manages itself. While the user is active it captures and retrieves fast; during the user's downtime it runs a sleep phase (the REM cycle) that consolidates episodic memories into durable knowledge, forgets the stale, reconciles contradictions, and surfaces new connections, the way sleep consolidates memory in the brain. Everything runs on Alibaba Cloud. The memory layer, and especially the sleep phase, is the hero and the thing this track judges. The agent is the vehicle.

## Starting point: the NanoClaw repo

The user will provide the NanoClaw repository, a self-hosted agent with Telegram and WhatsApp integration. NanoClaw works by wrapping Claude Code as its embedded engine: it pipes inbound messages to a Claude Code process and relays the result back to the channel. Your primary adaptation is to swap that embedded engine from Claude Code to Qwen Code, the analogous open-source terminal agent that runs Qwen models and already provides the agent loop, tool calling, MCP, SubAgents, and Skills. This is an engine swap, not a model-client rewrite.

Concretely:
- Keep NanoClaw's channel adapters and its wrapper pattern. Repoint the engine from Claude Code to Qwen Code, driven the same way NanoClaw drives Claude Code now (non-interactive invocation, or Qwen Code's daemon mode which exposes ACP over HTTP and SSE). Do not rebuild the channel and wrapper plumbing.
- Point the Qwen Code harness at a general Qwen model (Qwen-Max or the current Qwen3 Plus) via Model Studio, not at Qwen3-Coder, because this is a conversational personal assistant, not a coding tool. Give it a conversational system prompt or Skill so it does not behave like a dev agent.
- Wire the cloud memory layer in as an MCP server that Qwen Code connects to. Memory tools are reached over MCP; do not bake memory into the engine.
- Keep the memory boundary clean: Qwen Code holds the session and working context, the cloud memory layer holds the durable long-term memory, and the agent reaches long-term memory by calling the MCP tools. The sleep phase operates on the durable memory only.
- Multi-tenancy: run an isolated Qwen Code session or container per user. Do not use the shared daemon across users, since that shares one agent and breaks per-user isolation.

Since Engram is cloud-first, the engine container runs in the cloud on Alibaba (one per user or per session), with channel webhooks routing into it. Start by reviewing the provided repo and proposing exactly what you will keep, repoint, and add.

## Product framing (so you make the right architecture calls)

- The agent is the vehicle; the cloud memory layer with its sleep phase is the core, the moat, and the demo. Keep the memory service cleanly separated and exposed over MCP, because the SMB product (Desk, Track 4) reuses the exact same memory and agent core.
- Fully cloud on Alibaba is the production and submission target. Multi-tenant by account, strict per-user isolation, encryption at rest. Going cloud trades away the local-data sovereignty angle, so this product differentiates on memory, omnichannel reach, and multilingual support.
- This is the open-source flywheel product. Optimize for a clean, forkable, trustworthy core.

## You are

A senior engineer shipping a production-grade product in about a week. Clean modular architecture, typed, tested, real error handling. Move fast through parallel work streams, but no fragile shortcuts and no overengineering. Make reasonable calls, log them in `ASSUMPTIONS.md`, ask only blocking questions, then proceed.

## Local-first development (how we work)

Build it to run fully on the developer's machine first, then deploy the same code to Alibaba by swapping config. Do not deploy to cloud until it runs and passes the eval harness locally. Concretely:

- Everything is config-driven via env vars. No hardcoded cloud endpoints.
- A `docker-compose.yml` boots local dependencies: Postgres with pgvector (stands in for AnalyticDB for PostgreSQL or DashVector), Redis (stands in for Tair), MinIO (S3-compatible, stands in for OSS).
- Qwen runs over the Model Studio API with an API key, so inference and embeddings behave identically from local and cloud. No local model needed.
- For local channel testing, use Telegram long-polling (getUpdates), which needs no public URL. WhatsApp and WeChat require a public webhook, so use a tunnel (cloudflared or ngrok) only when testing those.
- Put all infrastructure behind interfaces (storage, vector, blob, queue, scheduler, secrets) so the same code runs against the local stack or against Alibaba by switching env config. No rewrite to deploy.
- Provide `make dev` (or an npm script) to boot the whole thing locally, and a separate `make deploy` path to Alibaba. The Alibaba deploy is the final step, for the submission proof.

## Hard constraints (hackathon)

- The production backend (agent runtime, channels, memory, sleep phase, inference routing) runs on Alibaba Cloud. The deployment-proof recording covers it.
- Qwen via Model Studio / DashScope (confirm exact IDs): the Qwen Code engine reasons on a general Qwen model (Qwen-Max or the current Qwen3 Plus), not Qwen3-Coder; cheap classification on Qwen-Turbo; memory internals use Qwen text-embedding, Qwen or GTE rerank, Qwen-Turbo for extraction and the online contradiction check, and Qwen-Max for the sleep-phase consolidation and synthesis.
- The memory service IS an MCP server; the agent runtime is an MCP client. MCP usage is explicitly scored.
- Public repo, MIT license, `ARCHITECTURE.md` with a diagram, three-minute demo, deploy proof.

## Recommended stack

A monorepo, TypeScript and Node throughout. Packages:
- `memory`: the MCP memory server with the online path and the sleep phase. The separable core that Desk reuses.
- `agent-runtime`: the cloud agent, the NanoClaw wrapper with its embedded engine swapped from Claude Code to Qwen Code (pointed at a general Qwen model).
- `shared`: the Qwen client wrapper, shared types, observability, the infra interfaces.

Local: docker-compose (Postgres+pgvector, Redis, MinIO). Cloud: SAE or Function Compute for the runtime and memory service, AnalyticDB for PostgreSQL or DashVector for vectors, Tair for the hot tier and session state, OSS for the cold archive, Function Compute plus EventBridge for async indexing and the scheduled sleep phase, API Gateway for the channel webhooks, SLS and ARMS for observability.

## Architecture

- Cloud agent runtime (NanoClaw wrapper plus the Qwen Code engine): channel webhooks, per-user isolated engine sessions, skills. The engine runs the agent loop on a general Qwen model and reaches the memory service over MCP.
- Cloud memory layer (the hero, separable, MCP), with two paths:
  - Online path (real time, fast and cheap): `memory.write` (lightweight episodic capture plus embedding), `memory.search` (budgeter retrieval), `memory.forget` (explicit). Defer heavy cognition to the sleep phase.
  - Sleep phase / REM cycle (offline, during downtime): cluster recent episodes, consolidate them into durable semantic notes and merge into the personal knowledge graph, run the decay and forgetting sweep, reconcile contradictions in batch, and synthesize new cross-cluster connections. Triggered per user after a configurable period of inactivity or on a per-user nightly schedule in their timezone, whichever comes first. Rate-limited and cost-bounded. This is where the heavier Qwen-Max work batches efficiently.
- Account and auth: web signup, channel linking, per-user token, strict isolation, billing-ready.
- Cloud brain: Qwen via Model Studio. Routed, not built.

Read path: hybrid recall (vector ANN plus keyword plus one hop of graph expansion), rerank, then the context budgeter.

## Channels (read before building)

All channels are cloud-native and used through official APIs; the user talks to the agent as a bot or business contact, never by automating their personal account. Telegram (bot API) and WhatsApp (Business Cloud API) are cleanest, build those first. WeChat is reachable through an Official Account or WeCom (企业微信). Channels are pluggable adapters so one failing channel never breaks the agent, and so the same adapters serve Desk later.

## The hard problems to nail (this is the score)

1. The sleep phase. Episodic-to-semantic consolidation with graph merge, the forgetting and decay sweep, batch contradiction reconciliation, and cross-cluster synthesis, all running during downtime. This is the centerpiece and the most novel part. Make it observable: show what got consolidated, forgotten, and connected on each cycle. Checkpointed, resumable, cost-bounded.
2. Context budgeter. Treat retrieval as a constrained packing problem. Score each candidate as `w1*relevance + w2*recency_decay + w3*importance + w4*diversity`, then greedily pack under `token_budget`. The direct answer to recalling critical memories in a limited context window. Expose the packing decision for the demo.
3. The online and offline split. Keep the online path fast and cheap (capture and retrieve), push the expensive cognition into the sleep phase. The separation is the engineering story.
4. Memory-aware agent loop. The agent decides what is worth writing and when to recall, autonomously, across sessions and channels.
5. Clean separation. The `memory` package runs and is tested independently of the agent, because Desk depends on it.

## Build plan (phases; stream letters can run in parallel)

- Phase 0, Scaffold (local): monorepo, the three packages, `CLAUDE.md`, `ARCHITECTURE.md` stub, MIT, `.env.example`, CI, the docker-compose local stack, the imported NanoClaw wrapper with the Qwen Code engine wired in, the shared Qwen client and observability and infra interfaces, MCP host and client, and the auth skeleton. Done when it boots locally, a Telegram bot (polling) round-trips a message through the engine, and the eval harness runs.
- Phase 1, Online memory path (Stream A): schema, the storage interfaces (local pgvector, Redis, MinIO), lightweight episodic write plus embedding, idempotent writes (content-hash dedup), dead-letter queue.
- Phase 2, Retrieval and budgeter (Stream B): hybrid recall, rerank, budgeter, packing trace exposed, p95 latency target met.
- Phase 3, Sleep phase (Stream C): the scheduled per-user REM cycle. Consolidation and graph merge, the forgetting sweep, batch contradiction reconciliation, synthesis. Checkpointed and cost-bounded. This is the centerpiece, give it the most attention.
- Phase 4, Agent runtime on Qwen Code (Stream D): repoint NanoClaw's embedded engine from Claude Code to Qwen Code (general Qwen model, conversational system prompt), the pluggable channel adapters (Telegram and WhatsApp first), skills, per-user isolated sessions, and the memory-aware write and recall policy over MCP.
- Phase 5, Multi-tenant hardening, web signup and channel linking, encryption and isolation.
- Phase 6, Deploy to Alibaba (swap config), capture the deploy proof, run the eval on cloud, record the demo.

## Eval harness and headline metric

Combine the retrieval metrics and the consolidation metrics. Retrieval: the budgeter ablation, stale-recall rate over time, recall@k, forget precision, retrieval p95 latency, tokens-in-context per query. Consolidation: answer questions after a sleep phase and show retention holds while the active memory set shrinks, show contradictions resolved, and show a synthesized connection that did not exist before. Add a cross-session and cross-channel recall test (told in Telegram, recalled in WhatsApp later). Headline visual: before versus after a sleep phase, the raw episodic pile becoming a lean consolidated knowledge graph with the stale stuff forgotten. Emit a JSON report and a markdown table.

## Production hardening

Memory: idempotent writes and idempotent webhook handling (channel delivery is at-least-once), retries with backoff plus a dead-letter queue, per-tenant rate and cost caps, encrypted memory at rest, strict per-user isolation, structured logs to SLS, traces to ARMS, graceful fallback on model failure (queue and retry, never drop a write). Sleep phase: checkpointed, resumable, cost-bounded per user, and isolated so one user's cycle cannot starve others.

## Demo (three minutes)

The user signs up on the web, links a Telegram bot, and chats; the agent learns things about them. Fast-forward a sleep phase and show the memory consolidate (episodes into notes and a graph), a stale fact forgotten, a contradiction resolved, and a new connection surfaced. Then show recall is sharper and works cross-channel. Close on the before-and-after sleep visual and the eval table, because the self-managing memory is the hero of this track.

## Submission

Public repo plus MIT (visible in About), Alibaba deploy proof for the full backend and Model Studio usage, `ARCHITECTURE.md` diagram (channels to the agent runtime on Alibaba to Qwen and to the memory MCP service with its online path and sleep phase to AnalyticDB or DashVector, Tair, and OSS), three-minute video, text description, Track 1.

## Start now

Review the NanoClaw repo I provide. Propose what to keep, refactor, and add; the monorepo structure; the local docker-compose stack; the MCP memory tool schemas; the sleep-phase design; and the multi-tenant data model. List blocking questions only. Then build Phase 0 locally.
