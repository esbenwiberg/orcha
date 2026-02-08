#!/bin/bash
#
# Restart Orcha web server gracefully
# This script is meant to be called from the web UI restart button
#

set -e

ORCHA_DIR="${ORCHA_DIR:-$HOME/projects/orcha}"
TMUX_SESSION="orcha-web"

# Kill current server gracefully
tmux send-keys -t "$TMUX_SESSION" C-c 2>/dev/null || true
sleep 1

# Respawn the pane with the server command
tmux respawn-pane -k -t "$TMUX_SESSION" "cd $ORCHA_DIR && npm run web:dev"
