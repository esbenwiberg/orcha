/**
 * Cleanup - Detect and remove dead tmux sessions and orphaned resources
 *
 * A "dead" session is:
 * - A tmux session starting with "orcha-" that's not in the instance registry
 * - A tmux session where the Orcha process (PID) is no longer running
 * - A tmux session containing only bash shells (no active AI agents)
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
 * Check if a process is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    execSync(`ps -p ${pid}`, { stdio: 'ignore' })
    return true
  } catch {
    return false
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
 * Get the PID of the first pane in a tmux session
 */
function getTmuxSessionPanePid(sessionName: string): number | null {
  try {
    const output = execSync(
      `tmux list-panes -t "${sessionName}" -F "#{pane_pid}" | head -1`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'] }
    )
    const pid = parseInt(output.trim(), 10)
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

/**
 * Get the command running in a pane by PID
 */
function getProcessCommand(pid: number): string | null {
  try {
    const output = execSync(`ps -p ${pid} -o comm=`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    return output.trim()
  } catch {
    return null
  }
}

/**
 * Check if a tmux session is only running bash (no AI agents)
 */
function isSessionOnlyBash(sessionName: string): boolean {
  const pid = getTmuxSessionPanePid(sessionName)
  if (!pid) return false

  const command = getProcessCommand(pid)
  return command === 'bash' || command === 'sh' || command === 'zsh'
}

/**
 * Detect all dead sessions
 */
export async function detectDeadSessions(): Promise<DeadSession[]> {
  const registry = await loadRegistry()
  const tmuxSessions = listOrchaTmuxSessions()
  const deadSessions: DeadSession[] = []

  const validInstanceSessions = new Set(
    Object.values(registry.instances).map((inst) => inst.tmuxSession)
  )

  for (const { name, created } of tmuxSessions) {
    // Check if it's a registered instance session
    if (validInstanceSessions.has(name)) {
      // Check if the process is still running
      const instance = Object.values(registry.instances).find((inst) => inst.tmuxSession === name)
      if (instance && !isProcessRunning(instance.pid)) {
        deadSessions.push({
          name,
          reason: `Orcha process (PID ${instance.pid}) no longer running`,
          created,
        })
      }
    } else {
      // Check if it's a UI session with only bash
      if (name.startsWith('orcha-ui-session-') || name.match(/^orcha-ui-[a-f0-9-]+$/)) {
        if (isSessionOnlyBash(name)) {
          deadSessions.push({
            name,
            reason: 'UI session with only bash shell (no AI agent)',
            created,
          })
        }
      } else {
        // Unknown orcha session not in registry
        deadSessions.push({
          name,
          reason: 'Not registered in instance registry',
          created,
        })
      }
    }
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
 * Clean up dead sessions
 */
export async function cleanupDeadSessions(dryRun: boolean = false): Promise<CleanupResult> {
  const deadSessions = await detectDeadSessions()
  const cleanedInstances: string[] = []
  const cleanedTempDirs: string[] = []

  if (!dryRun) {
    // Kill dead tmux sessions
    for (const session of deadSessions) {
      killTmuxSession(session.name)
    }

    // Clean up instance registry entries for dead sessions
    const registry = await loadRegistry()
    let registryChanged = false

    for (const [instanceId, instance] of Object.entries(registry.instances)) {
      if (!tmuxSessionExists(instance.tmuxSession)) {
        delete registry.instances[instanceId]
        cleanedInstances.push(instanceId)
        registryChanged = true

        // Clean up session store directory
        const sessionDir = process.env.HOME ? join(process.env.HOME, '.orcha', instanceId) : `/tmp/orcha/${instanceId}`
        if (existsSync(sessionDir)) {
          try {
            await rm(sessionDir, { recursive: true, force: true })
            cleanedTempDirs.push(sessionDir)
          } catch {
            // Ignore cleanup errors
          }
        }
      }
    }

    if (registryChanged) {
      await saveRegistry(registry)
    }
  }

  return {
    deadSessions,
    cleanedInstances,
    cleanedTempDirs,
  }
}

/**
 * Clean up stale instances from registry (tmux sessions no longer running)
 * This is similar to the existing cleanupStaleInstances but more comprehensive
 */
export async function cleanupInstanceRegistry(): Promise<string[]> {
  const registry = await loadRegistry()
  const removed: string[] = []

  for (const [instanceId, instance] of Object.entries(registry.instances)) {
    if (!tmuxSessionExists(instance.tmuxSession)) {
      delete registry.instances[instanceId]
      removed.push(instanceId)
    }
  }

  if (removed.length > 0) {
    await saveRegistry(registry)
  }

  return removed
}
