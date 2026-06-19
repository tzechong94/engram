#!/usr/bin/env bash
# One-shot bootstrap for an Alibaba ECS VM (Ubuntu 22.04). Installs Docker, Node,
# pnpm, clones Engram, and prepares .env. Run as a sudo-capable user:
#
#   curl -fsSL https://raw.githubusercontent.com/tzechong94/engram/main/deploy/alibaba/bootstrap.sh | bash
#   # or: scp this file up and `bash bootstrap.sh`
#
# After it finishes: edit ~/engram/.env (add DASHSCOPE_API_KEY, set QWEN_MOCK=false,
# set a VIEWER_TOKEN), then `cd ~/engram && ./engram.sh`.
set -euo pipefail

REPO="${ENGRAM_REPO:-https://github.com/tzechong94/engram.git}"
DIR="${ENGRAM_DIR:-$HOME/engram}"

log() { printf "\033[36m▸ %s\033[0m\n" "$1"; }

log "Installing Docker"
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER" || true
  log "Added $USER to the docker group — log out/in (or 'newgrp docker') for it to take effect."
fi

log "Installing Node 20 + pnpm (via nvm)"
if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
  nvm install 20 && nvm alias default 20
fi
export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
corepack enable 2>/dev/null || npm i -g pnpm

log "Cloning Engram → $DIR"
if [ ! -d "$DIR/.git" ]; then git clone "$REPO" "$DIR"; else ( cd "$DIR" && git pull --ff-only ); fi
cd "$DIR"
[ -f .env ] || cp .env.example .env

cat <<EOF

✓ Bootstrap done.

Next:
  1. Edit $DIR/.env:
       DASHSCOPE_API_KEY=sk-...        # your Model Studio key
       QWEN_MOCK=false
       VIEWER_TOKEN=$(head -c 16 /dev/urandom | xxd -p 2>/dev/null || echo "set-a-random-token")
       # For the chat agent on Linux, the spawned agent container reaches Postgres via the
       # docker bridge gateway, not host.docker.internal:
       ENGRAM_MEMORY_DB_URL=postgres://engram:engram@172.17.0.1:5433/engram
  2. Start the hero:        cd $DIR && ./engram.sh
       → viewer on http://<this-vm-public-ip>:8080/?token=<VIEWER_TOKEN>
  3. (optional) run as a service so it survives reboot:
       sudo cp deploy/alibaba/engram.service /etc/systemd/system/
       sudo sed -i "s|__USER__|$USER|g; s|__DIR__|$DIR|g" /etc/systemd/system/engram.service
       sudo systemctl enable --now engram
  4. (optional) the chat agent:   ./engram.sh agent
EOF
