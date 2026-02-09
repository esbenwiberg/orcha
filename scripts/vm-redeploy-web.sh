#!/bin/bash
#
# Redeploy Orcha web server on the VM (run FROM the VM itself)
#
# Uses systemd so the web server is fully decoupled from tmux sessions.
# Safe to run from within an Orcha Claude session - restarting the web
# server won't kill your tmux/Claude session.
#
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[+]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[x]${NC} $1"; exit 1; }

ORCHA_DIR="${ORCHA_DIR:-$HOME/projects/orcha}"
cd "$ORCHA_DIR" || err "Cannot cd to $ORCHA_DIR"

# One-time setup: install systemd service if not present
if ! systemctl list-unit-files orcha-web.service &>/dev/null || \
   ! systemctl list-unit-files orcha-web.service 2>/dev/null | grep -q orcha-web; then
    log "Installing orcha-web systemd service (one-time)..."
    sudo cp "$ORCHA_DIR/scripts/orcha-web.service" /etc/systemd/system/orcha-web.service
    sudo systemctl daemon-reload
    sudo systemctl enable orcha-web
    log "Service installed and enabled"
fi

# Optional: pull latest from git
if [[ "${1:-}" == "--pull" ]]; then
    log "Pulling latest from origin..."
    git pull
fi

# Build
log "Building TypeScript..."
npm run build || err "Build failed"

# Kill any leftover tmux-based web server
tmux kill-session -t orcha-web 2>/dev/null || true

# Restart via systemd
log "Restarting orcha-web service..."
sudo systemctl restart orcha-web

# Verify
log "Waiting for server to start..."
for i in 1 2 3 4 5; do
    sleep 1
    if curl -s -o /dev/null -w '' http://localhost:3000 2>/dev/null; then
        log "Server is running on :3000"
        echo ""
        warn "Browser connection was dropped - refresh the page to reconnect."
        exit 0
    fi
done

echo ""
warn "Server may be slow to start. Checking status..."
sudo systemctl status orcha-web --no-pager
err "Server failed to start. Check: sudo journalctl -u orcha-web -n 50"
