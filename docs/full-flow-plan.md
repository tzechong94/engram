# Engram Full Flow — Conversational Agent on Qwen + Channels (Plan)

Status: PROPOSED (pending CEO + Eng review)
Date: 2026-06-17
Goal: go from "hero runs (`./engram.sh` → memory + viewer)" to "the whole product
runs" — a Qwen Code agent, reachable on Telegram (then WhatsApp), wired to the Engram
memory layer, brought up by one command once keys/tokens are in `.env`.

## Where we are
- `./engram.sh` runs the hero: memory MCP + sleep + eval + brain viewer. No OneCLI; reads
  `DASHSCOPE_API_KEY` from `.env`. Mock by default.
- `nanoclaw-v2` is the agent runtime with a `qwen` provider (ACP) built but never run live.
  It still uses OneCLI by default; channels (Telegram/WhatsApp) install via skills.
- Memory MCP today: a stdio server scoped by `ENGRAM_TENANT_ID` env, talking to Postgres.

## What "full flow" means
`./engram.sh agent` (and an extended `up`) brings up the conversational agent: a user DMs a
Telegram bot → nanoclaw routes to a per-user Qwen Code session → the agent recalls/writes
via the Engram memory MCP → replies. Memory consolidates during downtime (sleep), visible
in the viewer. WhatsApp as a second, clearly-separated step (needs QR/Meta API).

## The real decisions (for review)

### D1 — How does the agent reach memory? (the central fork)
- **(A) stdio MCP subprocess inside each agent container.** The memory package runs in the
  container, scoped by `ENGRAM_TENANT_ID`, talking to Postgres directly.
  - Pros: matches today's build; no new transport.
  - Cons: every agent container needs the memory package + DB creds + DB network reach;
    couples memory into the agent image; weaker multi-tenant/cloud story.
- **(B) one long-lived HTTP/SSE memory service; agents are remote MCP clients.** The memory
  MCP server gains an HTTP transport; Qwen Code connects via `httpUrl` + a per-tenant bearer
  token; the service maps token → tenant.
  - Pros: agent containers hold NO DB creds and no memory code (only a URL+token); one
    service owns the DB; truest to the brief's "memory service IS an MCP server" + cloud;
    the viewer/memory/agent all point at one memory service.
  - Cons: new HTTP MCP transport + per-request tenant auth; Qwen Code remote-MCP config.
  - **Lean: (B).** It's the correct architecture for the full + cloud flow and actually
    simplifies the agent container. Revisits the hero-era stdio choice now that the
    requirement is the whole product.

### D2 — Credentials: OneCLI vs native `.env`
- nanoclaw defaults to OneCLI. For one credential story across Engram, run
  `/use-native-credential-proxy` so the agent reads `DASHSCOPE_API_KEY` from `.env` like the
  rest. **Lean: native `.env` proxy** (keep OneCLI as a documented option).

### D3 — Tenant model for live chat
- nanoclaw owner user id = Engram tenant. `./engram.sh agent` provisions one agent group +
  owner; tenant = owner id. (Demo/eval tenants stay separate.) With (B), the per-tenant
  bearer token is minted from the tenant id.

### D4 — Orchestration & idempotency
- `./engram.sh agent`: ensure hero is up → build agent container → set native proxy →
  install Telegram (if `TELEGRAM_BOT_TOKEN` set) → provision `provider=qwen` agent group +
  wire messaging group → point the agent at the memory service (URL+token or stdio) → start
  the nanoclaw host. Idempotent + re-runnable. Clear, actionable errors if a token is missing.
- `up` stays the fast, key-free hero. `agent` is the gated full stack.

### D5 — Channels scope
- Telegram first (bot token, long-polling, no public URL). WhatsApp second
  (`/add-whatsapp` QR or `/add-whatsapp-cloud` Meta API + tunnel) — separate command/step.

## Open questions for review
- D1: confirm (B) HTTP memory service vs (A) stdio-in-container.
- Scope: Telegram-only this iteration, WhatsApp deferred? How much auto-provisioning vs
  guided steps for the parts that need human input (bot token, QR scan)?
- Cloud: does the HTTP memory service also become the cloud deployment unit (one service the
  agent + viewer share)?
- Live validation: Qwen Code ACP + remote MCP both need one real run (gated on key + binary).
