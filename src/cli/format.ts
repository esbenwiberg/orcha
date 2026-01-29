/**
 * Status formatting for CLI output
 */

import type { SessionStatus, SessionState } from '../core/types.js'
import { STATE_ICONS } from '../core/types.js'

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

export function formatStatus(statuses: Map<string, SessionStatus>): string {
  const lines: string[] = []

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

    // Extract branch from sessionId or use placeholder
    const branch = sessionId.replace('session-', 'feature/task-')
    const mode = 'claude'
    const activity = formatRelativeTime(status.lastActivity)

    // Count states
    switch (status.state) {
      case 'working': working++; break
      case 'waiting': waiting++; break
      case 'idle': idle++; break
      case 'done': done++; break
      case 'error': error++; break
    }

    lines.push(
      `#${displayId}  ${color}${icon} ${padRight(status.state, 10)}${colors.reset} ` +
      `${padRight(branch, 18)}  ${padRight(mode, 6)}  ` +
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
