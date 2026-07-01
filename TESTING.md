# Engram — Test Plan & Evals

Two layers of testing:
- **Automated evals** (memory layer, gated) — `pnpm --filter @engram/eval evals`
- **Manual bot tests** (end-to-end via Telegram) — the checklist below

Track-1 (MemoryAgent) judges score: efficient storage/retrieval, **timely forgetting**, and **recall within limited context windows**. Every test below maps to one of those.

---

## A. Automated evals (CI gate)

```bash
# smoke pass (offline, mock Qwen)
pnpm --filter @engram/eval evals

# real run (enforces contradiction + LLM-judged answer gates)
QWEN_MOCK=false DASHSCOPE_API_KEY=sk-... pnpm --filter @engram/eval evals
```

Exits non-zero if any enforced gate fails. Writes `packages/eval/out/evals.{json,md}`. Gates:

| # | Gate | Threshold |
|---|---|---|
| 1 | Recall@k (retention after sleep) | ≥ 90% |
| 2 | Cross-channel recall | true |
| 3 | Forget precision (stale demoted from active recall) | ≥ 80% |
| 4 | Limited-context precision@k (120 tok) | ≥ 75% |
| 5 | RAG retrieval (doc-only facts) | ≥ 90% |
| 6 | RAG answer correctness (answers from doc, incl. dates + "I don't know") | ≥ 80% (real only) |
| 7 | No-confabulation precision | 100% |
| 8 | Retrieval p95 latency | ≤ 4000 ms (real) |
| 9 | Consolidation (notes created) | ≥ 1 |
| 10 | Contradiction/update resolution | ≥ 75% (real only) |
| 11 | Answer correctness (LLM-judged, all) | ≥ 80% (real only) |

`EVAL_RUNS=3` runs the suite 3× and a gate must hold in ≥⅔ of runs (`EVAL_PASS_RATE`) — robust to LLM variance.

The headline before/after-sleep report is the separate `pnpm --filter @engram/eval start`.

---

## B. Manual bot tests (Telegram)

Legend: **DM** = direct message; **GROUP** = the group chat (say the bot's name or @mention to wake it).

### 1. Recall accuracy — *the core proof*
- [ ] DM: "my flight is tomorrow at 6pm" → later "what time is my flight?" → **6pm**
- [ ] "what's my name?" → **Tze**
- [ ] Tell it 3 facts in separate messages, then ask each back → all correct
- [ ] Ask something it was never told → it says **"I don't know"**, does NOT invent

### 2. Conversation context (multi-turn)
- [ ] "I'm planning a trip to Japan" → "what should I pack?" → answer references **Japan** (not generic)
- [ ] A 5-message thread, then "what did I say first?" → recalls the opening message

### 3. Temporal reasoning (dates)
- [ ] "my flight is tomorrow at 6pm" → "what date is that?" → **tomorrow's date**, not today
- [ ] "remind me next Friday" → it computes the correct Friday
- [ ] "what day is it today?" → correct current date

### 4. Cross-session memory (persistence)
- [ ] Tell it a fact → wait for the container to idle out (or restart) → new message later: ask the fact back → still **recalled** (proves Postgres-backed, not in-session only)

### 5. Forgetting & updates (Track-1 keyword)
- [ ] "I live in New York" → later "actually I moved to San Francisco" → run a sleep cycle → "where do I live?" → **San Francisco** only, NOT New York
- [ ] Trivial throwaway fact mentioned once, never referenced → after sleep, not surfaced

### 5b. Document RAG (upload → recall from docs)
- [ ] Upload a `.txt`/`.md`/`.pdf` (viewer "Documents" panel or `POST /api/<tenant>/upload`) with a fact the model can't already know
- [ ] Ask the bot that fact → it answers **from the document** (verbatim detail: numbers, names)
- [ ] Ask a fact the document does **not** contain → it says **"I don't know"**, doesn't invent
- [ ] Upload a long multi-page doc → a fact buried in the middle is still retrieved

### 6. Behavior config from chat (with approval)
- [ ] DM: "keep your replies to one line" → **approval card** in DM → approve → next replies are one line
- [ ] GROUP: "only reply when I say your name" → approval card → approve → it goes quiet unless named
- [ ] DM stays always-on even after the above (DMs shouldn't get gated)

### 7. Name-as-mention (group)
- [ ] GROUP: a message containing "Engram" or "qwenny" (no @) → it replies
- [ ] GROUP: a message without the name → it stays silent
- [ ] GROUP: @mention via Telegram → it replies

### 8. Destination routing
- [ ] Ask a question in the GROUP → reply lands **in the group**, once (NOT duplicated to your DM)
- [ ] Ask in DM → reply in DM only

### 9. Scheduling / reminders
- [ ] "remind me in 2 minutes to drink water" → ~2 min later it pings you
- [ ] "remind me every weekday at 9am" → confirms a recurring reminder

### 10. Robustness / edge cases
- [ ] Send an empty / emoji-only / very long message → no crash, sensible reply
- [ ] Rapid-fire 5 messages → all handled, no dropped/duplicated replies
- [ ] Ask the same question twice → consistent answer

### 11. The viewer (presentation — `localhost:8080`)
- [ ] Brain graph renders; nodes = entities, edges = relationships
- [ ] "💤 Dream now" → graph grows; the **step-by-step dream trace** shows forget→cluster→consolidate→reconcile→synthesize→profile
- [ ] A contradiction shows as a superseded (greyed) edge after a cycle
- [ ] Files view: notes / episodes / sleep-cycle reports are browsable

---

## C. Pre-submission gate (must all be green)
- [ ] `pnpm --filter @engram/eval evals` (real Qwen) — all enforced gates pass
- [ ] Manual sections 1–5 green (memory is the Track-1 hero)
- [ ] One clean real-Qwen demo recorded: teach → dream (viewer) → recall → forget/update
- [ ] Host runs as a single stable instance (not a stray `pnpm dev` that crashed)
