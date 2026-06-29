# Engram

**A personal agent with a self-managing cloud memory.** You reach Engram over Telegram /
WhatsApp / WeChat. It reasons on Qwen. Its memory manages itself: it captures and recalls
fast while you're active, and during your downtime it runs a **sleep phase** (a REM cycle)
that consolidates episodes into durable knowledge, forgets the stale, reconciles
contradictions, and surfaces new connections — the way sleep consolidates memory in the
brain.

The agent is the vehicle. **The self-managing memory layer is the hero** — a clean,
separable MCP service. (It's the same core the Desk SMB product reuses.)

> Qwen Cloud Hackathon · Track 1 (MemoryAgent) · MIT.

## See it in 60 seconds

```bash
pnpm --filter @engram/viewer start        # brain viewer on http://localhost:8080
```

Open it and hit **▶ Demo**. It self-runs the whole story, no driving needed:
teach 3 facts → **Ask both brains** (with-memory answers, no-memory shrugs) → 💤 Dream
(graph consolidates) → change a fact → Dream again → ask again, and it answers the **new**
value with the old one gone. Or use **Teach Engram** to feed it your own facts and watch.

**Prove it** — the memory layer passes a 10-dimension eval gate, 3× on real Qwen, all green
(recall, *timely forgetting*, *limited-context recall*, contradiction/update resolution, RAG,
no-confabulation, ~200ms p95). The numbers show live in the viewer's **Proof** panel:

```bash
QWEN_MOCK=false DASHSCOPE_API_KEY=sk-... EVAL_RUNS=3 pnpm --filter @engram/eval evals
```

## What's here

```
engram/
  packages/memory/    ← the hero: cloud memory MCP server (online path) + sleep/REM cycle
  packages/shared/     ← infra interfaces (Store/Vector/Blob/Queue/Scheduler/Secrets),
                          Qwen client (DashScope, behind an interface + offline mock)
  packages/eval/       ← eval harness: retrieval + consolidation metrics, before/after report
  packages/viewer/     ← brain-themed memory viewer: read-only API + React neural-graph UI
  nanoclaw-v2/         ← agent runtime: NanoClaw, running on Qwen Code (DashScope)
  deploy/alibaba/      ← config-swap deploy to Alibaba Cloud
  docker-compose.yml   ← local stack: Postgres+pgvector, Redis, MinIO (+ viewer profile)
```

**Memory v2 (research-backed — see `docs/memory-research-summary.md`):** multi-hop
retrieval via **Personalized PageRank** over the knowledge graph (HippoRAG); a
**bi-temporal** model where contradictions *invalidate* rather than delete (Zep/Graphiti)
+ Mem0-style ADD/UPDATE/DELETE/NOOP ops; **core memory blocks** — a bounded, human-readable
per-tenant profile the sleep phase maintains (MemGPT/Letta + Karpathy LLM-wiki); and
**LLM-rated importance** + reflection-trigger sleep (Generative Agents).

The two memory paths:

- **Online (fast, cheap):** `memory.write` (episodic capture + embed, idempotent),
  `memory.search` (hybrid recall → rerank → **context budgeter** that packs under a token
  budget and exposes its packing trace), `memory.forget`.
- **Sleep / REM (offline, scheduled per user):** forget-sweep → cluster → consolidate to
  semantic notes → merge a knowledge graph → reconcile contradictions → synthesize new
  connections. Checkpointed, cost-bounded, and **observable** (every cycle emits a report).

## Quickstart — one command (no API key needed)

The whole system runs offline on a deterministic mock Qwen until you add a key.
Prereqs: Node 20+, pnpm, Docker running.

```bash
./engram.sh          # boots docker, installs, migrates, builds, seeds a demo
                     # user, starts the brain viewer, and opens your browser
```

That's it. It opens **http://localhost:8080** — pick the `eval-…` tenant and explore the
brain: entities are neurons (size = salience), edges are synapses (invalidated ones grey
out), the recall box lights up activated neurons and shows the budgeter's packing trace,
and each sleep cycle shows the before→after consolidation.

```bash
./engram.sh down     # stop everything (data preserved)
./engram.sh test     # full test suite (unit + DB integration)
./engram.sh eval     # re-run the eval, print the before/after-sleep report
./engram.sh sleep    # force a sleep/REM cycle now
./engram.sh status   # what's running
```

Turn on real Qwen: set `DASHSCOPE_API_KEY` and `QWEN_MOCK=false` in `.env`, then
`./engram.sh up` again.

## Run the full conversational agent (Telegram / WhatsApp)

The agent half is built on the NanoClaw runtime (its Telegram + Baileys WhatsApp adapters,
routing, per-session containers) with the engine swapped to **Qwen Code** and **Engram
memory** wired in. One command does the deterministic setup and guides the human bits
(bot token, WhatsApp QR):

```bash
./engram.sh agent
```

It builds the agent container, then walks you through installing a channel
(`/add-telegram` / `/add-whatsapp`), creating the agent (`/init-first-agent`), pointing it
at Qwen, attaching memory (`scripts/install-engram-memory.sh`), and starting the host. DM
your bot and watch memory grow in the viewer. Credentials are one operator-held DashScope
key (no OneCLI, nothing exposed to users). Full runbook + Alibaba cloud shape:
**`docs/agent-and-deploy.md`**.

<details><summary>Prefer the raw <code>make</code> targets?</summary>

`make up` (infra+migrate), `make test`, `make eval`, `make viewer`, `make viewer-docker`,
`make down`. The `engram.sh` script just orchestrates these for you.
</details>

## Turn on real Qwen

1. Get a Model Studio (DashScope) key.
2. In `.env`: set `DASHSCOPE_API_KEY=...` and `QWEN_MOCK=false`.

That's the only change — the Qwen client is behind an interface, so inference + embeddings
behave identically local and cloud.

## Run the agent

```bash
# memory MCP server for a tenant (the agent connects to this)
ENGRAM_TENANT_ID=<user> make mcp
# sleep scheduler (or force one cycle for a demo)
make sleep                       # scheduled
FORCE=1 TENANT=<user> make sleep # fast-forward a cycle now
```

The agent runtime is `nanoclaw-v2` with a `qwen` provider (Qwen Code in ACP daemon mode).
See `nanoclaw-v2/docs/qwen-engine.md` (engine) and `nanoclaw-v2/docs/engram-memory-wiring.md`
(how the memory MCP server attaches to an agent group).

## Deploy to Alibaba

`make deploy` — config swap (`ENGRAM_INFRA=alibaba`). AnalyticDB for PostgreSQL, Tair, OSS,
Function Compute + EventBridge for the sleep schedule. See `deploy/alibaba/`.

## Architecture & decisions

`ARCHITECTURE.md` (diagram + the two paths), `ASSUMPTIONS.md` (the calls made and why).
