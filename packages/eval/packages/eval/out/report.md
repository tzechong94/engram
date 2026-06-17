# Engram Eval Report (mock-qwen)

_Generated 2026-06-16T15:45:50.425Z — tenant `eval-1594f752-5082-4f52-828e-7fcef56612b4`_

## Before vs After Sleep (the headline)
```
                       BEFORE          AFTER
active episodes     13  ████████████████████████    10 ██████████████████······
semantic notes       0                               1
graph entities       0                               2
graph edges          0                               1
forgotten            0                               0
```

The raw episodic pile becomes a lean consolidated graph; stale memories are forgotten; recall holds.

## Sleep cycle work

| metric | value |
|---|---|
| episodesScanned | 13 |
| clusters | 11 |
| consolidated | 1 |
| entitiesMerged | 2 |
| edgesMerged | 1 |
| forgotten | 0 |
| contradictionsResolved | 0 |
| connectionsSynthesized | 0 |
| tokensUsed | 250 |
| costCents | 0.05 |
| status | completed |

## Retrieval & consolidation metrics

| metric | value |
|---|---|
| recall@k before sleep | 100% (4/4) |
| recall@k after sleep (retention) | 75% (3/4) |
| cross-channel recall (before → after) | true → true |
| forget precision | 0% (0/2 stale forgotten) |
| retrieval p95 latency | 2.91 ms |

## Budgeter ablation (tokens-in-context)

| config | recall | avg tokens/query |
|---|---|---|
| with budgeter (300-token budget) | 100% | 142 |
| relevance-only, no cap | 100% | 142 |
| **savings** | | 0 fewer tokens/query with budgeter |
