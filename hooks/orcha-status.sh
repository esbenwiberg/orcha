#!/bin/bash
#
# orcha-status.sh - Update orcha status based on Claude Code hook events
#
# Usage: This script is called by Claude Code hooks with JSON on stdin.
# Set STATE env var to override: STATE=working orcha-status.sh
#
# Environment:
#   ORCHA_SESSION_ID  - Required, the session ID
#   ORCHA_STATUS_DIR  - Required, where to write status files
#   STATE             - Optional override (working, idle, waiting)
#

# Exit silently if not in an orcha session
[ -z "$ORCHA_SESSION_ID" ] && exit 0
[ -z "$ORCHA_STATUS_DIR" ] && exit 0

# Read JSON input (may be empty for some hooks)
INPUT=$(cat)

# Get hook event name from input
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty' 2>/dev/null)

# Determine state based on hook event or STATE env var
if [ -n "$STATE" ]; then
  NEW_STATE="$STATE"
elif [ "$HOOK_EVENT" = "UserPromptSubmit" ]; then
  NEW_STATE="working"
  MESSAGE="Processing user request..."
elif [ "$HOOK_EVENT" = "PreToolUse" ]; then
  NEW_STATE="working"
  TOOL=$(echo "$INPUT" | jq -r '.tool_name // "tool"' 2>/dev/null)
  MESSAGE="Using $TOOL..."
elif [ "$HOOK_EVENT" = "Stop" ]; then
  NEW_STATE="idle"
  MESSAGE="Ready"
elif [ "$HOOK_EVENT" = "SessionStart" ]; then
  NEW_STATE="idle"
  MESSAGE="Ready"
else
  # Unknown event, don't update
  exit 0
fi

# Default message if not set
MESSAGE="${MESSAGE:-$NEW_STATE}"

# Ensure status directory exists
mkdir -p "$ORCHA_STATUS_DIR"

# Write status file
STATUS_FILE="$ORCHA_STATUS_DIR/$ORCHA_SESSION_ID.json"
cat > "$STATUS_FILE" <<EOF
{
  "agentId": "$ORCHA_SESSION_ID",
  "state": "$NEW_STATE",
  "message": "$MESSAGE",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
}
EOF

exit 0
