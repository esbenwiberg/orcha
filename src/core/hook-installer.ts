/**
 * hook-installer.ts - Auto-configure Claude Code hooks for orcha status updates
 *
 * This ensures that orcha sessions properly report their status by installing
 * hooks that fire on UserPromptSubmit, PreToolUse, and Stop events.
 */

import { readFile, writeFile, mkdir, copyFile, chmod } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const HOOK_SCRIPT = `#!/bin/bash
#
# orcha-status.sh - Update orcha status based on Claude Code hook events
#
# This script is auto-installed by orcha. Do not edit manually.
#
# Environment:
#   ORCHA_SESSION_ID  - Required, the session ID
#   ORCHA_STATUS_DIR  - Required, where to write status files
#

# Exit silently if not in an orcha session
[ -z "$ORCHA_SESSION_ID" ] && exit 0
[ -z "$ORCHA_STATUS_DIR" ] && exit 0

# Read JSON input
INPUT=$(cat)

# Extract hook_event_name using grep/sed (no jq dependency)
HOOK_EVENT=$(echo "$INPUT" | grep -o '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\\([^"]*\\)"/\\1/')

# Determine state based on hook event
case "$HOOK_EVENT" in
  UserPromptSubmit)
    NEW_STATE="working"
    MESSAGE="Processing user request..."
    ;;
  PreToolUse)
    NEW_STATE="working"
    # Extract tool name
    TOOL=$(echo "$INPUT" | grep -o '"tool_name"[[:space:]]*:[[:space:]]*"[^"]*"' | sed 's/.*:.*"\\([^"]*\\)"/\\1/')
    MESSAGE="Using \${TOOL:-tool}..."
    ;;
  Stop)
    NEW_STATE="idle"
    MESSAGE="Ready"
    ;;
  SessionStart)
    NEW_STATE="idle"
    MESSAGE="Ready"
    ;;
  *)
    # Unknown event, don't update
    exit 0
    ;;
esac

# Ensure status directory exists
mkdir -p "$ORCHA_STATUS_DIR"

# Write status file
STATUS_FILE="$ORCHA_STATUS_DIR/$ORCHA_SESSION_ID.json"
TIMESTAMP=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)

cat > "$STATUS_FILE" <<EOF
{
  "agentId": "$ORCHA_SESSION_ID",
  "state": "$NEW_STATE",
  "message": "$MESSAGE",
  "timestamp": "$TIMESTAMP"
}
EOF

exit 0
`

interface ClaudeSettings {
  permissions?: Record<string, unknown>
  hooks?: {
    UserPromptSubmit?: Array<{ hooks: Array<{ type: string; command: string }> }>
    PreToolUse?: Array<{ hooks: Array<{ type: string; command: string }> }>
    Stop?: Array<{ hooks: Array<{ type: string; command: string }> }>
    [key: string]: unknown
  }
  [key: string]: unknown
}

const HOOK_COMMAND = '~/.claude/hooks/orcha-status.sh'

/**
 * Check if orcha hooks are already installed
 */
export async function isHookInstalled(): Promise<boolean> {
  const settingsPath = join(homedir(), '.claude', 'settings.json')
  const hookPath = join(homedir(), '.claude', 'hooks', 'orcha-status.sh')

  // Check if hook script exists
  if (!existsSync(hookPath)) {
    return false
  }

  // Check if settings.json has our hooks configured
  if (!existsSync(settingsPath)) {
    return false
  }

  try {
    const content = await readFile(settingsPath, 'utf-8')
    const settings = JSON.parse(content) as ClaudeSettings

    // Check if our hook is in UserPromptSubmit
    const userPromptHooks = settings.hooks?.UserPromptSubmit?.[0]?.hooks || []
    return userPromptHooks.some(h => h.command === HOOK_COMMAND)
  } catch {
    return false
  }
}

/**
 * Install orcha hooks into Claude Code configuration
 */
export async function installHooks(): Promise<void> {
  const claudeDir = join(homedir(), '.claude')
  const hooksDir = join(claudeDir, 'hooks')
  const settingsPath = join(claudeDir, 'settings.json')
  const hookPath = join(hooksDir, 'orcha-status.sh')

  // Ensure directories exist
  await mkdir(hooksDir, { recursive: true })

  // Write hook script
  await writeFile(hookPath, HOOK_SCRIPT, { mode: 0o755 })

  // Load or create settings.json
  let settings: ClaudeSettings = {}
  if (existsSync(settingsPath)) {
    try {
      const content = await readFile(settingsPath, 'utf-8')
      settings = JSON.parse(content) as ClaudeSettings
    } catch {
      // Invalid JSON, start fresh
    }
  }

  // Ensure hooks object exists
  if (!settings.hooks) {
    settings.hooks = {}
  }

  // Helper to add our hook to an event if not already present
  const ensureHook = (event: 'UserPromptSubmit' | 'PreToolUse' | 'Stop') => {
    if (!settings.hooks![event]) {
      settings.hooks![event] = [{ hooks: [] }]
    }
    const hooks = settings.hooks![event]![0].hooks
    if (!hooks.some(h => h.command === HOOK_COMMAND)) {
      // Add at the beginning so it runs first
      hooks.unshift({ type: 'command', command: HOOK_COMMAND })
    }
  }

  // Add our hook to all relevant events
  ensureHook('UserPromptSubmit')
  ensureHook('PreToolUse')
  ensureHook('Stop')

  // Write updated settings
  await writeFile(settingsPath, JSON.stringify(settings, null, 2))

  console.log('[orcha] Installed Claude Code hooks for status updates')
}

/**
 * Ensure hooks are installed (called on orcha startup)
 */
export async function ensureHooksInstalled(): Promise<void> {
  if (await isHookInstalled()) {
    return
  }
  await installHooks()
}
