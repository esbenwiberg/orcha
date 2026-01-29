/**
 * Status formatting for CLI output
 */

import type { SessionStatus, SessionState, SessionMode } from '../core/types.js'
import { STATE_ICONS } from '../core/types.js'
import type { SessionMetadata } from '../core/session-store.js'

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
}

const stateColors: Record<SessionState, string> = {
  initializing: colors.gray,
  idle: colors.white,
  working: colors.green,
  waiting: colors.yellow,
  done: colors.cyan,
  error: colors.red,
}

function formatRelativeTime(date: Date): string {
  const now = Date.now()
  const elapsed = now - date.getTime()

  if (elapsed < 1000) return 'now'
  if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s ago`
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`
  return `${Math.floor(elapsed / 3600000)}h ago`
}

function padRight(str: string, len: number): string {
  return str.length >= len ? str.slice(0, len) : str + ' '.repeat(len - str.length)
}

export function formatStatus(
  statuses: Map<string, SessionStatus>,
  metadata?: SessionMetadata[]
): string {
  const lines: string[] = []

  // Build metadata lookup by session ID
  const metadataMap = new Map<string, SessionMetadata>()
  if (metadata) {
    for (const m of metadata) {
      metadataMap.set(m.id, m)
    }
  }

  // Header
  lines.push(
    `${colors.bold}ID  STATUS       BRANCH              MODE    MESSAGE                           ACTIVITY${colors.reset}`
  )
  lines.push(colors.dim + '─'.repeat(95) + colors.reset)

  let working = 0, waiting = 0, idle = 0, done = 0, error = 0

  let displayId = 1
  for (const [sessionId, status] of statuses) {
    const icon = STATE_ICONS[status.state]
    const color = stateColors[status.state]

    // Get real branch/mode from metadata, fall back to session ID
    const meta = metadataMap.get(sessionId)
    const branch = meta?.branch || sessionId
    const mode = meta?.mode || 'claude'
    const activity = formatRelativeTime(status.lastActivity)

    // Count states
    switch (status.state) {
      case 'working': working++; break
      case 'waiting': waiting++; break
      case 'idle': idle++; break
      case 'done': done++; break
      case 'error': error++; break
    }

    // Truncate branch for display
    const branchDisplay = branch.length > 18 ? branch.slice(0, 15) + '...' : branch

    lines.push(
      `#${displayId}  ${color}${icon} ${padRight(status.state, 10)}${colors.reset} ` +
      `${padRight(branchDisplay, 18)}  ${padRight(mode, 6)}  ` +
      `${padRight(status.message, 32)}  ${colors.dim}${activity}${colors.reset}`
    )

    displayId++
  }

  // Summary
  lines.push(colors.dim + '─'.repeat(95) + colors.reset)
  const total = statuses.size
  const parts = [
    `${total} total`,
    working > 0 ? `${colors.green}${working} working${colors.reset}` : null,
    waiting > 0 ? `${colors.yellow}${waiting} waiting${colors.reset}` : null,
    idle > 0 ? `${idle} idle` : null,
    done > 0 ? `${colors.cyan}${done} done${colors.reset}` : null,
    error > 0 ? `${colors.red}${error} error${colors.reset}` : null,
  ].filter(Boolean)

  lines.push(`Sessions: ${parts.join(', ')}`)

  return lines.join('\n')
}

export function formatSessionLine(
  displayId: number,
  sessionId: string,
  status: SessionStatus,
  branch?: string,
  mode = 'claude'
): string {
  const icon = STATE_ICONS[status.state]
  const color = stateColors[status.state]
  const activity = formatRelativeTime(status.lastActivity)

  return (
    `#${displayId} ${color}${icon}${colors.reset} ` +
    `${branch || sessionId} ` +
    `${color}${status.message}${colors.reset} ` +
    `${colors.dim}${activity}${colors.reset}`
  )
}
