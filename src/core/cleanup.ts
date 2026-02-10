/**
 * Cleanup - Detect and remove dead tmux sessions and orphaned resources
 *
 * A "dead" session is one where NO active process (claude, node, python, etc.)
 * is running in ANY pane — only bare shells remain with no child processes.
 *
 * IMPORTANT: We must be conservative. Killing an active session loses work.
 * It's better to leave a dead session around than to kill a live one.
 */

import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { rm } from 'fs/promises'
import { join } from 'path'
import { loadRegistry, saveRegistry, getInstance } from './instance-registry.js'
import type { InstanceInfo } from './types.js'

export interface DeadSession {
  name: string
  reason: string
  created: string
}

export interface CleanupResult {
  deadSessions: DeadSession[]
  cleanedInstances: string[]
  cleanedTempDirs: string[]
}

/**
 * List all tmux sessions starting with "orcha-"
 */
function listOrchaTmuxSessions(): Array<{ name: string; created: string }> {
  try {
    const output = execSync('tmux list-sessions -F "#{session_name}:#{session_created}"', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })

    return output
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('orcha-'))
      .map((line) => {
        const [name, createdTimestamp] = line.split(':')
        const created = new Date(parseInt(createdTimestamp) * 1000).toISOString()
        return { name, created }
      })
  } catch {
    return []
  }
}

/**
 * Check if a tmux session exists
 */
function tmuxSessionExists(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t "${sessionName}" 2>/dev/null`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Check if a tmux session has any active (non-shell) processes running.
 *
 * Walks the full process tree of every pane in the session.
 * Returns true if ANY descendant process is something other than a bare shell.
 * This catches: claude, node, python, npm, git, gh, etc.
 */
function hasActiveProcesses(sessionName: string): boolean {
  try {
    // Get all pane PIDs in the session
    const paneOutput = execSync(
      `tmux list-panes -t "${sessionName}" -F "#{pane_pid}"`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    )

    const panePids = paneOutput.trim().split('\n').map(p => p.trim()).filter(Boolean)

    for (const panePid of panePids) {
      // Get the full process tree under this pane PID
      // pstree shows all descendants — if there's anything beyond the shell, the session is active
      try {
        const tree = execSync(`pstree -A ${panePid} 2>/dev/null`, {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim()

        // pstree output for a bare shell is just "bash" or "zsh" (single line, no children)
        // If there are child processes (indicated by --- or multiple lines), it's active
        const lines = tree.split('\n')
        if (lines.length > 1 || tree.includes('---')) {
          return true
        }
      } catch {
        // pstree failed — process may have exited, treat as inactive
      }
    }

    return false
  } catch {
    // If we can't check, assume it's active (be conservative)
    return true
  }
}

/**
 * Detect dead sessions.
 *
 * A session is only considered dead if it's a bare shell with NO child
 * processes. Instance container sessions (orcha-orcha, orcha-teamplanner, etc.)
 * are NEVER considered dead — they're managed by the instance registry.
 */
export async function detectDeadSessions(): Promise<DeadSession[]> {
  const registry = await loadRegistry()
  const tmuxSessions = listOrchaTmuxSessions()
  const deadSessions: DeadSession[] = []

  // Instance container sessions are never "dead" — they're structural
  const instanceSessionNames = new Set(
    Object.values(registry.instances).map((inst) => inst.tmuxSession)
  )

  // Also build a set of UI session tmux names that are tracked in session stores
  const trackedUiSessions = new Set<string>()
  for (const instanceId of Object.keys(registry.instances)) {
    try {
      const { loadSessionStore } = await import('./session-store.js')
      const sessions = await loadSessionStore(instanceId)
      for (const s of sessions) {
        if (s.tmuxSession) {
          trackedUiSessions.add(s.tmuxSession)
        }
      }
    } catch {
      // Ignore errors loading session store
    }
  }

  for (const { name, created } of tmuxSessions) {
    // NEVER touch instance container sessions
    if (instanceSessionNames.has(name)) {
      continue
    }

    // For UI sessions: only mark as dead if they have NO active processes
    // AND are not tracked in any session store
    if (name.startsWith('orcha-ui-session-') || name.startsWith('orcha-ui-')) {
      if (trackedUiSessions.has(name)) {
        // Tracked session — only dead if truly empty (no processes at all)
        if (!hasActiveProcesses(name)) {
          deadSessions.push({
            name,
            reason: 'Tracked session with no active processes (bare shell only)',
            created,
          })
        }
      } else {
        // Untracked UI session — dead if no active processes
        if (!hasActiveProcesses(name)) {
          deadSessions.push({
            name,
            reason: 'Untracked UI session with no active processes',
            created,
          })
        }
      }
    }
    // Ignore non-UI, non-instance sessions entirely (could be user-created tmux sessions)
  }

  return deadSessions
}

/**
 * Kill a tmux session
 */
function killTmuxSession(sessionName: string): void {
  try {
    execSync(`tmux kill-session -t "${sessionName}"`, { stdio: 'ignore' })
  } catch {
    // Session might already be gone
  }
}

/**
 * Clean up dead sessions.
 *
 * IMPORTANT: This only kills tmux sessions that are truly dead (bare shells
 * with no child processes). It does NOT remove instance registry entries or
 * session store directories — those are structural and should persist.
 */
export async function cleanupDeadSessions(dryRun: boolean = false): Promise<CleanupResult> {
  const deadSessions = await detectDeadSessions()
  const cleanedInstances: string[] = []
  const cleanedTempDirs: string[] = []

  if (!dryRun) {
    // Kill dead tmux sessions only
    for (const session of deadSessions) {
      killTmuxSession(session.name)
    }

    // Remove session store entries for killed UI sessions (NOT the instance dirs!)
    for (const session of deadSessions) {
      if (session.name.startsWith('orcha-ui-')) {
        // Find which instance this session belongs to and remove just the session entry
        const registry = await loadRegistry()
        for (const [instanceId] of Object.entries(registry.instances)) {
          try {
            const { loadSessionStore, removeSession } = await import('./session-store.js')
            const sessions = await loadSessionStore(instanceId)
            const match = sessions.find(s => s.tmuxSession === session.name)
            if (match) {
              await removeSession(instanceId, match.id)
              break
            }
          } catch {
            // Ignore
          }
        }
      }
    }
  }

  return {
    deadSessions,
    cleanedInstances,
    cleanedTempDirs,
  }
}

/**
 * Clean up stale instances from registry (tmux sessions no longer running).
 *
 * Only removes instances whose tmux container session is gone AND that have
 * no active UI sessions. Does NOT delete session store directories.
 */
export async function cleanupInstanceRegistry(): Promise<string[]> {
  const registry = await loadRegistry()
  const removed: string[] = []

  for (const [instanceId, instance] of Object.entries(registry.instances)) {
    if (!tmuxSessionExists(instance.tmuxSession)) {
      // Check if any UI sessions for this instance still exist
      let hasActiveSessions = false
      try {
        const { loadSessionStore } = await import('./session-store.js')
        const sessions = await loadSessionStore(instanceId)
        for (const s of sessions) {
          if (s.tmuxSession && tmuxSessionExists(s.tmuxSession)) {
            hasActiveSessions = true
            break
          }
        }
      } catch {
        // Ignore
      }

      if (!hasActiveSessions) {
        delete registry.instances[instanceId]
        removed.push(instanceId)
      }
    }
  }

  if (removed.length > 0) {
    await saveRegistry(registry)
  }

  return removed
}
