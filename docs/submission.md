# Engram — Submission (Qwen Cloud Hackathon, Track 1: MemoryAgent)

Draft text for the submission form. Edit names/links before submitting.

## One-liner
Engram is a personal agent on Qwen with a self-managing cloud memory layer — it captures and
recalls fast while you're active, and during downtime runs a sleep/REM cycle that consolidates
episodes into durable knowledge, forgets the stale, reconciles contradictions, and synthesizes
new connections. The agent is the vehicle; the self-managing memory is the hero.

## What it does
- **Omnichannel personal agent** (Telegram + WhatsApp) reasoning on Qwen via Model Studio,
  built on the NanoClaw runtime with the engine swapped from Claude to Qwen Code.
- **Cloud memory layer, exposed as an MCP server** (memory.write / memory.search / memory.forget).
  The agent is the MCP client. Memory is cleanly separable and independently tested.
- **Sleep phase (the hero):** offline, per-user — clusters recent episodes, consolidates them
  into semantic notes, merges a knowledge graph, runs a decay/forget sweep, reconciles
  contradictions (bi-temporal invalidation), and synthesizes cross-cluster connections.
  Checkpointed, cost-bounded, and observable (every cycle emits a report).
- **Research-backed retrieval:** Personalized PageRank multi-hop recall over the knowledge
  graph (HippoRAG), hybrid vector+keyword candidates, rerank, and a context budgeter that
  packs under a token budget and exposes its decision.
- **Brain viewer:** a browser visualization — entities as neurons, edges as synapses, the
  sleep cycle's before→after, and live recall activation.

## Why it's different
Most agent memory is a flat vector store that never forgets, never reconciles, and never
connects facts across time. Engram's memory manages itself: the online path stays fast and
cheap; the expensive cognition is batched into the sleep phase. The result is recall that
holds while the active memory set shrinks — proven in the eval.

## Architecture (see ARCHITECTURE.md + docs/)
Channels → agent runtime (Qwen Code, per-session isolated containers) → memory MCP service →
Postgres+pgvector (AnalyticDB in cloud). Sleep worker runs the REM cycle on a schedule.
Everything behind infra interfaces so local↔Alibaba is a config swap. Research basis in
docs/memory-research-summary.md (HippoRAG, Letta sleep-time compute, Zep/Graphiti bi-temporal,
Generative Agents, A-MEM), 25 claims adversarially verified.

## Hard requirements (checklist)
- [x] Public repo, MIT license — github.com/tzechong94/engram
- [x] ARCHITECTURE.md + diagram
- [ ] Alibaba Cloud deploy proof (full backend + Model Studio usage) — see deploy/alibaba/
- [ ] 3-minute demo video — see docs/demo-script.md
- [x] Local-first, runs offline on a mock; real Qwen by config
- [ ] Track 1 selected on the form

## Eval headline (from the harness)
Before vs after a sleep cycle: the raw episodic pile collapses into a lean consolidated graph;
stale memories forgotten; recall@k holds 100% before AND after sleep; cross-channel recall
works; forget precision 100%; retrieval p95 ~3ms; context budgeter ~33% fewer tokens at no
recall loss. (Run `./engram.sh eval`; report in packages/eval/out/report.md.)

## Links
- Repo: https://github.com/tzechong94/engram
- Demo video: <add>
- Deploy proof: <add screenshots/recording>
