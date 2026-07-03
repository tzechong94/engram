# Engram: Test Plan & Evals

Two layers of testing:
- **Automated evals** (memory layer, gated), `pnpm --filter @engram/eval evals`
- **Manual playground tests** (end-to-end via the viewer chat), the checklist below

Track-1 (MemoryAgent) judges score: efficient storage/retrieval, **timely forgetting**, and **recall within limited context windows**. Every test below maps to one of those.

---

## A. Automated evals (CI gate)

```bash
# smoke pass (offline, mock Qwen)
pnpm --filter @engram/eval evals

# real run (enforces contradiction + LLM-judged answer gates)
QWEN_MOCK=false DASHSCOPE_API_KEY=sk-... pnpm --filter @engram/eval evals
```

Exits non-zero if any enforced gate fails. Writes `packages/eval/out/evals.{json, md}`. Gates:

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
| 12 | Cross-session learning curve (memory vs no-memory baseline) | final-session memory ≥ 75% and ≥ 25pts above baseline (real only) |

`EVAL_RUNS=3` runs the suite 3× and a gate must hold in ≥⅔ of runs (`EVAL_PASS_RATE`), robust to LLM variance.

Gate 12 is the track's "increasingly accurate decisions" made measurable: 4 simulated
sessions each teach a fact, and after every session the agent is quizzed on ALL facts so
far. The memory agent holds ~100% as knowledge accumulates while a no-memory baseline
(context window = current session only) decays toward 1/k (measured: 100→50→33→25%).

The headline before/after-sleep report is the separate `pnpm --filter @engram/eval start`.

---

## B. Manual playground tests (viewer 💬 Chat, `localhost:8080`)

Use the chat tab on a fresh tenant (＋ new). Every message is captured to memory; the
transcript is only a view (🗑 Clear chat wipes the screen, not the memory).

### 1. Recall accuracy: *the core proof*
- [ ] "my flight is tomorrow at 6pm" → later "what time is my flight?" → **6pm with the absolute date**
- [ ] Tell it 3 facts in separate messages, then ask each back → all correct
- [ ] Ask something it was never told → it says **"I don't know"** (offers to record), does NOT invent

### 2. Transcript ≠ memory (cross-session persistence)
- [ ] Teach a fact → **🗑 Clear chat** (screen empty) → ask again → still **recalled**
- [ ] Refresh the page → transcript restored, memory intact

### 3. Temporal reasoning (dates)
- [ ] "dentist appointment tomorrow at 3pm" → stored with `[tomorrow = YYYY-MM-DD]` (Files view) → asks answer with the absolute date
- [ ] "gym every Tuesday" → NOT date-anchored (recurring)

### 4. Forgetting & updates (Track-1 keyword)
- [ ] "I live in New York" → later "actually I moved to San Francisco" → 💤 Dream → "where do I live?" → **San Francisco** only
- [ ] Old trivia (seeded by the demo) absent from normal recall; **deep recall** (Brain view toggle) still finds it
- [ ] Ask about the forgotten trivia in chat → it answers with the **⛏ dug deep** pill (agentic escalation)

### 5. Document RAG (upload → recall from docs)
- [ ] 📎 a `.txt`/`.md`/`.pdf` with a fact the model can't already know → ask → answers **from the document**
- [ ] 📎 an **image** (screenshot/photo of text) → qwen-vl transcribes it → the fact is recallable
- [ ] Ask a fact the document does **not** contain → **"I don't know"**
- [ ] A fact buried mid-document is still retrieved

### 6. Robustness / edge cases
- [ ] Empty / emoji-only / very long message → no crash, sensible reply
- [ ] Ask the same question twice → consistent answer
- [ ] Model dropdown (qwen-max/plus/turbo) switches the reply model; garbage values are rejected server-side

### 7. The viewer (presentation: `localhost:8080`)
- [ ] ▶ Demo: the 10-act stage runs end to end on Autoplay (~2 min) with no manual scrolling
- [ ] Brain graph renders; 💤 Dream grows it; the **dream drawer** shows the step-by-step trace
- [ ] A contradiction shows as a superseded (greyed) edge after a cycle
- [ ] Files view: notes / episodes / sleep-cycle reports are browsable
- [ ] Proof card shows 12/12 gates; the demo's final act shows the learning-curve chart

---

## C. Pre-submission gate (must all be green)
- [ ] `pnpm --filter @engram/eval evals` (real Qwen), all enforced gates pass
- [ ] Manual sections 1–5 green (memory is the Track-1 hero)
- [ ] One clean real-Qwen demo recorded (▶ Demo Autoplay on the stage)
- [ ] The deployed viewer (Alibaba ECS) serves the same build, Proof panel populated
