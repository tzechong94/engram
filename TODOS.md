# Engram TODOs

Deferred from the Memory v2 CEO/Eng reviews (scope: "Hero bundle"). Each has enough
context to pick up cold.

## M6 — A-MEM Zettelkasten note-linking + evolution  (P2)
**What:** When a semantic note is created, dynamically link it to similar existing notes
(note↔note edges) and let adding a note update the linked notes ("memory evolution"),
forming a self-revising knowledge network — emergent synthesis between scheduled cycles.
**Why:** complements the scheduled `synthesize` step; surfaces connections continuously.
**Where to start:** add a `note_links(tenant_id, src_note, dst_note, weight)` table; on
`insertNote`, vector-search top-k similar notes and link; a sleep step can co-update linked
note bodies. Source: A-MEM (arXiv 2502.12110). Effort: M (CC).

## M7 — LoCoMo / LongMemEval benchmark harness  (P2)
**What:** Add standard multi-session conversational-memory QA scenarios to `packages/eval`
as an external yardstick alongside the synthetic scenario.
**Why:** credible external numbers for the memory moat (judges/readers).
**Where to start:** adapt a LoCoMo/LongMemEval sample into the eval's seed+query format;
score recall/temporal/contradiction. Sources: arXiv 2410.10813 (LongMemEval), LoCoMo.
Effort: M-L (CC) — the datasets need adapters.

## Viewer runtime image slimming  (P3)
**What:** the viewer Docker runtime currently copies the built workspace + runs via `tsx`.
**Why:** smaller, faster cold start.
**Where to start:** compile `server/index.ts` to JS (tsc), copy only `dist-server` +
`dist-web` + the runtime deps of `@engram/memory`/`@engram/shared`, run with `node`.
Effort: S.

## Repo finalization (git) — DONE + caveat
`git init` at engram root + nanoclaw-v2 vendored (its `.git` moved to
`~/.engram-nanoclaw-upstream-git.bak`, not deleted). Remote: git@github.com:tzechong94/engram.git.
Initial commit made; **not pushed** (`git push -u origin main` when ready).
**Caveat:** vendoring removed nanoclaw's `origin`, so the `/add-telegram` /add-whatsapp`
skills (which `git fetch origin <channels-branch>`) need the upstream re-added first:
`git remote add nanoclaw https://github.com/nanocoai/nanoclaw.git && git fetch nanoclaw`
(or run the channel install before vendoring on a fresh nanoclaw clone). The adapter code,
once installed, is committed normally.

## Live-gated (need credentials/binary, not code)
- Real Qwen: set `DASHSCOPE_API_KEY` + `QWEN_MOCK=false`.
- Qwen Code ACP live validation: `nanoclaw-v2/docs/qwen-engine.md`.
- Telegram round-trip; live Alibaba deploy proof.
