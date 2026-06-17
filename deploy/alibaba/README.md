# Deploying Engram to Alibaba Cloud

Engram is local-first: the same code runs on the docker-compose stack or on Alibaba by
swapping config (`ENGRAM_INFRA=alibaba` + cloud connection strings). Nothing in the code
hardcodes a cloud endpoint — every dependency is behind a `packages/shared` interface.

## Service mapping (local → cloud)

| Local (docker-compose) | Alibaba managed service | Engram component |
|------------------------|-------------------------|------------------|
| Postgres + pgvector | **AnalyticDB for PostgreSQL** (or DashVector for vectors) | memory store + vectors |
| Redis | **Tair** | hot tier / session state |
| MinIO | **OSS** | cold archive (encrypted blobs) |
| node-cron (in-process) | **EventBridge → Function Compute** | sleep-phase schedule |
| local processes | **SAE** or **Function Compute** | agent runtime + memory MCP + sleep worker |
| — | **API Gateway** | channel webhooks (WhatsApp/WeChat) |
| env / `.env` | **KMS** + OneCLI vault | secrets |
| stdout JSON logs | **SLS** + **ARMS** | logs + traces |

## What to deploy

1. **Memory service** (`packages/memory`): the MCP server + the sleep worker. On Alibaba,
   run the MCP server alongside each agent runtime (SAE sidecar / same FC service) and the
   sleep worker as a Function Compute function triggered by EventBridge (per-tenant nightly
   + inactivity). Point `DATABASE_URL` at AnalyticDB.
2. **Agent runtime** (`nanoclaw-v2`): the per-session Qwen Code containers. Deploy on SAE
   (one isolated container per session) or Function Compute. `provider=qwen`, DashScope key
   from KMS/OneCLI.
3. **Channels:** API Gateway routes WhatsApp/WeChat webhooks into the runtime; Telegram can
   stay long-polling.

## Steps

1. Provision: AnalyticDB for PostgreSQL (enable the `vector` extension), Tair, an OSS
   bucket, a KMS key, an ACR repo. Note their endpoints/credentials.
2. Copy `.env.alibaba.example` → `.env.alibaba`, fill in the cloud values, set
   `ENGRAM_INFRA=alibaba` and a real `ENGRAM_ENCRYPTION_KEY`.
3. Build + push the agent image to ACR (`./container/build.sh` then `docker push`).
4. Run migrations against AnalyticDB: `DATABASE_URL=... pnpm --filter @engram/memory migrate`.
5. Deploy the three components (SAE/FC). Wire the EventBridge → FC sleep schedule.
6. Smoke test, then record the deploy proof.

`deploy.sh` is the entrypoint `make deploy` calls — it validates config and walks the
above. Actual `aliyun`/`fun`/`sae` CLI calls are gated on your account credentials (the
script checks for them and prints the exact commands if absent).
