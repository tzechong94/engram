---
---

Every agent demo works until the second session. You tell an assistant on Monday that you are allergic to peanuts, and on Friday it cheerfully suggests a peanut-sauce recipe. The reflex fix is to stuff more history into the context window. That is expensive, it does not survive across sessions, and it turns retrieval into a needle-in-a-haystack problem the moment the history gets long.

I built Engram for the Qwen Cloud hackathon (Track 1, MemoryAgent) to attack that head on. It is a memory layer that any agent plugs into over MCP, and it runs entirely on Qwen. This post is the build log: the architecture, the decisions that turned out to matter, the parts that fought back, and how I made "it works" a number instead of a vibe.

## The core idea: split the memory the way a brain does

The insight is old and boring and correct: you do not hold everything in your head at once. You capture the day quickly, and while you sleep your brain consolidates what happened, fades the trivia, fuses related memories, and files the important things for later. Two paths, one fast and one slow.

Engram copies that split exactly.

The **online path** runs on every message and stays cheap. Capture, recall, forget. No heavy model calls on the hot path.

The **offline path** is a "sleep / REM cycle" that runs while the user is idle or on a schedule. This is where the expensive thinking happens, amortized across every future query instead of paid on every turn. This is the part I think of as the hero, and it is the part most memory systems skip.

## Capture: dumb on purpose

Writing a memory should be fast, so the write path does no LLM work.

```
MemoryService.write -> MemoryRepo.insertEpisode
```

Each message becomes an episode. Importance is a cheap heuristic (base 0.4, plus weight for personal pronouns, for durable markers like "allergic" or "deadline" or "birthday," for a time or day mention, and for length, clamped to 0.05 to 1). The text is embedded to a 1024-dim vector with `text-embedding-v3`. Dedup is a content hash:

```sql
INSERT INTO episodes (..., content_hash)
VALUES (..., sha256(tenant_id || lower(content)))
ON CONFLICT (tenant_id, content_hash)
  DO UPDATE SET last_accessed_at = now(), access_count = access_count + 1
```

So the same fact twice bumps an access counter instead of piling up. If embedding fails, the episode still gets stored (null vector) and a re-embed job goes to a dead-letter queue that a maintenance tick drains later. A write is never lost. The real cognition is deferred to sleep, which is the whole point.

## Recall: hybrid retrieval, then a budgeter

`MemoryService.search` embeds the query once, then pulls candidates from four sources into one pool:

1. **Vector** over episodes and notes, pgvector cosine distance (`embedding <=> query`), relevance is `1 - distance`.
2. **Keyword** full-text, `to_tsvector` and `plainto_tsquery` with `ts_rank`. This exists because fuzzy vectors quietly miss exact tokens: a phone number, a confirmation code, the word "Thursday." Keyword catches them.
3. **Graph Personalized PageRank**, the HippoRAG idea. When the per-tenant knowledge graph has at least two edges, seed PageRank from the query's entities and let probability spread across the undirected graph:

   ```
   r = alpha * s + (1 - alpha) * W^T r     (alpha = 0.5, up to 50 iterations)
   ```

   Then aggregate node mass back onto the notes that cite those entities. That is multi-hop associative recall ("one thing reminds you of another") in a single retrieval pass, instead of an iterative chain of LLM calls.
4. **Core memory**, a compact per-tenant profile block that is always prepended.

Candidates get reranked with `gte-rerank` (blended `0.5 * recall + 0.5 * rerank`), and then the piece I care about most kicks in: the **token budgeter**.

Real agents have a limited context window. You cannot paste everything relevant into the prompt. So the budgeter scores each candidate

```
score = 0.5*relevance + 0.2*recency + 0.2*importance + 0.1*diversity
```

with each component min-max normalized across the candidate set, `recency = 0.5^(age / 7 days)`, and diversity computed MMR-style as `1 - max similarity to whatever is already selected`, recomputed every round so you do not pack five near-duplicates. It greedily fills the budget and returns a full trace: every candidate, its four sub-scores, and whether it was kept or dropped.

This is the direct answer to Track 1's "recall critical memories within limited context windows." The budgeter, not the window size, is what makes recall usable when the window is small. In the eval I run it at a punishing 120 tokens and it still lands the critical fact.

## The sleep cycle: where memory manages itself

`SleepPhase.run` is seven steps, each checkpointed so a crash resumes mid-cycle, all under a per-tenant cost cap so one user cannot run up the bill.

```
forget -> cluster -> consolidate -> graph-merge -> reconcile -> synthesize -> profile
```

1. **Forget** runs first, so junk never gets baked into durable notes. More on the math below.
2. **Cluster**: greedy single-pass cosine-kNN over the survivors (join threshold 0.55 on real embeddings).
3. **Consolidate** (qwen-max): each cluster of two or more collapses into one durable semantic note, strict JSON, importance re-rated 1 to 10. The source episodes are archived, and their raw text is written to an encrypted cold blob.
4. **Graph-merge** (qwen-turbo): pull entities and edges out of each note and upsert them into the graph.
5. **Reconcile** (qwen-turbo): high-similarity note pairs (cosine >= 0.6) are judged for contradiction, and the loser is superseded bi-temporally.
6. **Synthesize** (qwen-max): mid-similarity pairs (cosine 0.3 to 0.6) can produce a genuinely new note when there is a non-obvious connection neither note stated.
7. **Profile** (qwen-max): rewrite the compact profile the agent reads first on every turn.

Watching this run in the viewer, as a graph grows new neurons and a dream trace narrates each step, is the moment the project clicked for me. The agent is not just storing text. It is turning experience into structured knowledge on its own time.

## The decision that mattered most: forgetting is demotion, not deletion

My first forget pass was pure decay:

```
retained = importance * 0.5^(age / 30 days) * (1 + 0.4 * ln(1 + access_count))
forget if retained < 0.15 and not pinned and not accessed in the last 3 days
```

Then a reviewer asked the sharp question: what about something important but 90 days old? Plug in importance 0.8, 90 days, never accessed, and you get `0.8 * 0.5^3 = 0.10`, which is below 0.15. Pure decay would drop a still-true, high-value fact just because it went quiet. That is wrong. The rubric says "timely forgetting of outdated information," and outdated is not the same as old.

The fix was not a hard importance floor. It was to change what "forget" means. In Engram, the forget sweep flips an episode to `status='forgotten'`. It does not delete the row. Default recall filters to the active set, but a `deep` recall relaxes that filter and reaches the cold tier:

```
WHERE tenant_id = $1 <AND status = 'active' unless deep> AND ...
```

So forgetting is demotion. The memory leaves your automatic recall, exactly like you stop reciting last week's small talk, but it is still on disk and still findable if you deliberately look. The token budgeter is the real "limited context window" mechanism; decay just decides what is in the cheap, high-signal hot set versus the searchable long tail. That reframing also killed the "important but old" problem for free, because nothing is ever actually lost.

The demo beat that came out of this is my favorite: chat with it, clear the entire on-screen transcript, then ask "what am I allergic to?" It still answers "peanuts." An empty conversation that still remembers is the proof that memory and transcript are different things.

## Contradictions without amnesia: bi-temporal notes

When a fact changes, overwriting it loses history. So every note and edge carries two timelines: valid time (true in the world) and transaction time (recorded). When reconcile finds a contradiction, it supersedes the loser instead of deleting it:

```sql
UPDATE semantic_notes
SET superseded_by = $winner, invalidated_at = now(), valid_to = now()
WHERE id = $stale
```

A single centralized predicate, `noteValidSql()`, is applied on every note read:

```
superseded_by IS NULL AND invalidated_at IS NULL AND (valid_to IS NULL OR valid_to > now())
```

So recall can never leak a stale memory, but `notesAsOf(t)` can still answer "what did I believe last week." Update the dinner from July 16 to July 17 and recall returns the 17th, while the 16th sits in history, superseded and auditable, not gone.

## The bug that could have sunk the pitch: confabulation

While testing the chat, I asked it about my client and it confidently told me my client was "Sakura Innovations." I never said that. Nothing in memory said that. The model invented a plausible company name to sound natural. For a memory system whose whole pitch includes "no confabulation," that is a fatal-looking slip.

Two causes. The chat prompt was too permissive ("be warm, weave the facts in"), and the chat model was qwen-turbo, which embellishes more than qwen-max. I hardened the system prompt to forbid inventing any specific (names, companies, numbers, dates) that is not literally in the remembered facts or the user's message, and to offer to record a missing detail rather than guess. Now it says "I do not have your client's name, want me to record it?" I also added an answer-level eval gate so this class of confabulation cannot regress silently. The existing "no-confabulation" gate only tested direct "I do not know" questions; it did not catch gratuitous detail invention inside an otherwise valid answer. That gap is now closed.

## Dates that do not rot

"My flight is tomorrow at 6pm" is meaningless when you recall it a week later. So recall now carries each memory's recorded date, and the assistant resolves relative dates against it and always answers with an absolute date and time. Teach it "flight is tomorrow at 6pm" on July 1, ask later, and it answers "July 2, 2026 at 6pm." Small thing, but a memory that cannot anchor time is not really a memory.

## Making "it works" a number

I did not want to grade this on feel, so the whole thing runs behind an eval suite: 12 gates, three times on real Qwen, all green. Recall retention, cross-channel recall, forget precision, limited-context precision at 120 tokens, RAG retrieval, RAG answer correctness (including dates and honest "I do not know"), no-confabulation, contradiction resolution, consolidation, LLM-judged answer correctness, and about 200 ms p95 recall latency. Answers are graded by an LLM judge, a gate must hold in at least two of three runs to absorb model variance, and the harness exits non-zero if any enforced gate fails. The numbers also render live in the viewer's Proof panel, so the claim is inspectable, not asserted. The newest gate is a cross-session learning curve: four simulated sessions each teach a fact, and after every session the agent is quizzed on everything so far. Memory holds 100 -> 100 -> 100 -> 100% while a no-memory baseline decays 100 -> 50 -> 33 -> 25%, which is "increasingly accurate decisions" as a chart instead of a claim.

Building eval-first changed how I worked. When contradiction resolution sat at 50%, the temptation was to loosen the gate. Instead I found the real gaps (consolidation was dropping the new value, and my metric was brittle) and fixed them until it hit 100% for real. The gate keeps you honest.

## How Qwen powers all of it

Four roles, all on DashScope / Model Studio:
- **qwen-max** for the reasoning-heavy sleep steps: consolidation, synthesis, profile.
- **qwen-turbo** for extraction and contradiction judging.
- **text-embedding-v3** (1024-dim) for every embedding.
- **gte-rerank** for sharpening recall before the budgeter packs.
- **qwen-vl-max** for vision: uploaded images (photos, screenshots, scans) are transcribed into ingestable text.

The memory server, the sleep worker, the eval harness, and the viewer (including its live chat agent) are all Qwen-native. A deterministic offline mock (hash-to-vector embeddings plus rule-based stubs) means the entire system and its tests run with no key, and switching to the real API is one env flag. Local versus Alibaba Cloud (AnalyticDB for PostgreSQL, Tair, OSS, Function Compute) is a config swap, not a rewrite, because everything sits behind infra interfaces.

## What I would tell the next person building agent memory

Memory is not a bigger context window. The leverage is in what happens between conversations. Get the offline compute right, the consolidation and the forgetting and the reconciliation, and recall becomes cheap and accurate because the hot set stays small and high-signal. Treat forgetting as demotion, not deletion, so you never have to be scared of losing something. Preserve history bi-temporally so "update" does not mean "amnesia." And put the whole thing behind an eval you are not allowed to loosen.

Engram is open source (MIT). The fastest way to feel it is to run the viewer, hit "Play the demo as a conversation," and then clear the chat and watch it still remember.

```bash
pnpm --filter @engram/viewer start        # http://localhost:8080
QWEN_MOCK=false DASHSCOPE_API_KEY=sk-... EVAL_RUNS=3 pnpm --filter @engram/eval evals
```
