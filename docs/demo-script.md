# Engram — 3-Minute Demo Script (Track 1)

The hero is the self-managing memory + sleep phase. Show the before→after transformation,
because that's what the track scores. Record on the **Alibaba deployment** with **real Qwen**
(satisfies the deploy + Model Studio proof at the same time).

Pre-record setup (off camera):
- Cloud VM running (`./engram.sh` on the ECS box), `QWEN_MOCK=false`, real DashScope key.
- Viewer open at `http://<vm-ip>:8080/?token=…`.
- A tenant seeded with a vivid scenario (run `./engram.sh eval` once, or chat a few facts
  through the bot — include one contradiction, e.g. "I live in SF" then later "I moved to NY").

## The 3 minutes

**0:00–0:25 — The problem (say it over the brain view).**
"Personal agents forget, or they hoard everything until it's noise. Engram is a personal
agent on Qwen with a memory that manages itself — it consolidates, forgets, and reconciles
during downtime, like sleep does in the brain. Everything runs on Alibaba Cloud." Show the
viewer: the knowledge graph as neurons + synapses.

**0:25–1:00 — Capture (live).**
DM the Telegram bot a few things: "I'm vegetarian", "my dog Rocky is a golden retriever",
"I live in San Francisco". Switch to the viewer — new neurons fire in the episodic buffer.
Then on WhatsApp (or a second chat) say "actually I just moved to New York." Point out:
two channels, one memory.

**1:00–1:50 — The sleep phase (the hero).**
"Now Engram sleeps." Trigger a cycle (`FORCE=1 TENANT=<id> ./engram.sh sleep`, or the
scheduler). Refresh the viewer and narrate the before→after:
- raw episodes **collapse** into semantic notes (neurons cluster + light up),
- a **stale** memory fades (forgotten),
- the **contradiction** resolves — "lives in SF" greys out (invalidated), "New York" stays,
- a **new synapse** forms (a connection synthesized that wasn't there before).
Show the sleep-cycle card: consolidated / forgotten / reconciled / connected counts.

**1:50–2:30 — Recall is sharper + cross-channel.**
Ask the bot "where do I live and what do I eat?" → it answers New York + vegetarian. Show the
viewer's recall view: PPR activation spreading across the graph, and the budgeter's packing
trace (what it pulled and why, under a token budget). Note: asked on a different channel than
some facts were told — cross-channel recall.

**2:30–3:00 — Proof + close.**
Flash the eval table: recall holds (100% before/after sleep), the active memory set shrank,
forget precision, p95 latency, budgeter token savings. One line: "The memory is a separable
MCP service — the same core powers the agent and reuses into other products. Running on
Alibaba, reasoning on Qwen via Model Studio." End on the before/after brain visual.

## What to capture for the deploy proof (required)
- Terminal/console showing it running on the **Alibaba ECS** instance (instance ID visible).
- A **Model Studio / DashScope** call (e.g. the eval log line showing real `tokensUsed` +
  `costCents`, or the DashScope console usage page).
- The viewer served from the VM's public IP.

## Tips
- Real Qwen makes contradiction-resolution + synthesis genuinely work (the mock can't judge
  contradictions) — record with `QWEN_MOCK=false`.
- Keep narration on the *memory behavior*, not the plumbing. The judges score the self-managing
  memory; the agent is the vehicle.
