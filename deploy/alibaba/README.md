# Deploying Engram to Alibaba Cloud

Two paths. **Start with v1 (single VM)** — it's the fastest live deploy and is faithful to
how Engram runs locally. Graduate to managed services later for scale/HA.

## Why a VM (not serverless)
nanoclaw spawns a Docker container per chat session — so the runtime needs Docker. Function
Compute can't spawn sibling containers. One ECS VM with Docker runs the whole thing exactly
like your laptop.

## v1 — single ECS VM (recommended) 🚀

The entire local stack (Postgres+pgvector, Redis, MinIO, the viewer, and the nanoclaw
agent) runs on one VM. No managed services required to go live.

### 1. Provision (your Alibaba account)
- **ECS instance:** Ubuntu 22.04, ~4 vCPU / 8–16 GB RAM, ESSD system disk (≥40 GB). Enable
  **automatic snapshots** (session state + memory live on this disk in v1).
- **Security group inbound:** `22` (SSH), `8080` (viewer — lock to your IP, or front with SLB
  + `VIEWER_TOKEN`). Outbound: open (Telegram polling + Qwen API).

### 2. Bootstrap the VM
```bash
ssh <user>@<vm-ip>
curl -fsSL https://raw.githubusercontent.com/tzechong94/engram/main/deploy/alibaba/bootstrap.sh | bash
```
Installs Docker + Node + pnpm, clones the repo, creates `.env`.

### 3. Configure + launch
```bash
cd ~/engram
nano .env       # DASHSCOPE_API_KEY=..., QWEN_MOCK=false, VIEWER_TOKEN=..., ENGRAM_MEMORY_DB_URL=...
./engram.sh     # boots infra + migrations + viewer + sleep; seeds a demo tenant
```
Viewer: `http://<vm-ip>:8080/?token=<VIEWER_TOKEN>`.

### 4. Survive reboots (optional)
```bash
sudo cp deploy/alibaba/engram.service /etc/systemd/system/
sudo sed -i "s|__USER__|$USER|g; s|__DIR__|$HOME/engram|g" /etc/systemd/system/engram.service
sudo systemctl enable --now engram
```

### 5. Chat agent (optional)
`./engram.sh agent`, then the guided steps (channel install, bot token, wire memory, host).
Linux note: the spawned agent container reaches the Postgres container via the docker bridge
gateway, so set `ENGRAM_MEMORY_DB_URL=postgres://engram:engram@172.17.0.1:5433/engram` (the
installer warns if it sees `host.docker.internal` on Linux).

That's a live deployment. Cost: the VM + your Qwen usage (pennies for memory, see the eval's
measured `costCents`).

## v2 — managed services (scale/HA upgrade)
When you outgrow one VM, move state off it:

| v1 (on the VM) | v2 (managed) | component |
|---|---|---|
| Postgres+pgvector container | **AnalyticDB for PostgreSQL** (enable `vector`) | memory store |
| Redis container | **Tair** | hot tier |
| MinIO container | **OSS** | cold archive |
| `.env` on disk | **KMS** | secrets |
| node-cron sleep | **EventBridge → Function Compute** | scheduled REM cycle |
| viewer on :8080 | **SLB** (+ token) | viewer ingress |
| stdio memory MCP | **HTTP memory service** (connection pooling) | memory transport at concurrency |

Steps: provision the managed services → set `ENGRAM_INFRA=alibaba` + point `DATABASE_URL` at
AnalyticDB in `.env` → `pnpm --filter @engram/memory migrate` → keep the agent runtime on the
VM (it still needs Docker) but its memory + state now live in managed services. `deploy.sh`
validates config and scaffolds this path. True horizontal scale (nanoclaw spawning pods on
ACK/Kubernetes) is a further, separate change.

## Files here
- `bootstrap.sh` — one-shot VM setup (v1).
- `engram.service` — systemd unit (v1).
- `.env.alibaba.example` — managed-services env template (v2).
- `deploy.sh` — config validator + managed-services deploy scaffold (v2).
