/**
 * ActionsManager - Manage custom action buttons
 *
 * Handles CRUD operations for user-defined action buttons.
 * Actions are stored globally in ~/.orcha/actions.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { randomUUID } from 'crypto'
import type { Action, ActionsStore } from './types.js'
import { loadSessionStore, saveSessionStore, type SessionMetadata } from './session-store.js'
import { loadRegistry, saveRegistry } from './instance-registry.js'
import type { InstanceInfo } from './types.js'

const ORCHA_DIR = join(homedir(), '.orcha')
const ACTIONS_FILE = join(ORCHA_DIR, 'actions.json')
const ACTIONS_VERSION = 1
const ACTIONS_INSTANCE_ID = 'orcha-actions'

/**
 * Load actions from disk
 */
export async function loadActions(): Promise<Action[]> {
  try {
    if (!existsSync(ACTIONS_FILE)) {
      return []
    }

    const content = await readFile(ACTIONS_FILE, 'utf-8')
    const store = JSON.parse(content) as ActionsStore

    // Handle version migrations if needed in future
    if (!store.version) {
      store.version = ACTIONS_VERSION
    }

    return store.actions || []
  } catch (err) {
    console.error('[ActionsManager] Failed to load actions:', err)
    // If file is corrupted, start fresh
    return []
  }
}

/**
 * Save actions to disk
 */
export async function saveActions(actions: Action[]): Promise<void> {
  await mkdir(ORCHA_DIR, { recursive: true })

  const store: ActionsStore = {
    version: ACTIONS_VERSION,
    actions,
  }

  await writeFile(ACTIONS_FILE, JSON.stringify(store, null, 2))
}

/**
 * Get all actions
 */
export async function getActions(): Promise<Action[]> {
  return await loadActions()
}

/**
 * Get a single action by ID
 */
export async function getAction(id: string): Promise<Action | null> {
  const actions = await loadActions()
  return actions.find(a => a.id === id) || null
}

/**
 * Create a new action
 */
export async function createAction(
  name: string,
  icon: string,
  script: string
): Promise<Action> {
  const actions = await loadActions()

  const now = new Date().toISOString()
  const action: Action = {
    id: randomUUID(),
    name: name.trim(),
    icon: icon.trim(),
    script: script.trim(),
    createdAt: now,
    updatedAt: now,
  }

  actions.push(action)
  await saveActions(actions)

  return action
}

/**
 * Update an existing action
 */
export async function updateAction(
  id: string,
  updates: Partial<Pick<Action, 'name' | 'icon' | 'script'>>
): Promise<Action | null> {
  const actions = await loadActions()
  const index = actions.findIndex(a => a.id === id)

  if (index === -1) {
    return null
  }

  const action = actions[index]

  // Apply updates
  if (updates.name !== undefined) action.name = updates.name.trim()
  if (updates.icon !== undefined) action.icon = updates.icon.trim()
  if (updates.script !== undefined) action.script = updates.script.trim()
  action.updatedAt = new Date().toISOString()

  await saveActions(actions)

  return action
}

/**
 * Delete an action
 */
export async function deleteAction(id: string): Promise<boolean> {
  const actions = await loadActions()
  const initialLength = actions.length
  const filtered = actions.filter(a => a.id !== id)

  if (filtered.length === initialLength) {
    // Action not found
    return false
  }

  await saveActions(filtered)
  return true
}

/**
 * Ensure the global actions instance exists in the registry
 */
async function ensureActionsInstance(): Promise<InstanceInfo> {
  const registry = await loadRegistry()

  // Check if actions instance already exists
  if (registry.instances[ACTIONS_INSTANCE_ID]) {
    return registry.instances[ACTIONS_INSTANCE_ID]
  }

  // Create actions instance
  const instance: InstanceInfo = {
    instanceId: ACTIONS_INSTANCE_ID,
    repoPath: homedir(), // Use home directory as placeholder
    tmuxSession: ACTIONS_INSTANCE_ID,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    sessionCount: 0,
    providerType: 'generic',
  }

  registry.instances[ACTIONS_INSTANCE_ID] = instance
  await saveRegistry(registry)

  return instance
}

/**
 * Execute an action in a new tmux session
 * Returns session info for dashboard integration
 */
export async function executeAction(id: string): Promise<{
  sessionId: string
  instanceId: string
  tmuxSession: string
  displayId: number
}> {
  const action = await getAction(id)

  if (!action) {
    throw new Error(`Action not found: ${id}`)
  }

  const { execSync } = await import('child_process')

  // Ensure actions instance exists
  await ensureActionsInstance()

  // Load existing sessions to get next display ID
  const existingSessions = await loadSessionStore(ACTIONS_INSTANCE_ID)
  const displayId = existingSessions.length > 0
    ? Math.max(...existingSessions.map(s => s.displayId)) + 1
    : 1

  // Generate unique session ID and tmux session name
  const sessionId = randomUUID()
  const timestamp = Date.now()
  const sessionName = `orcha-ui-${sessionId}`

  // Create detached tmux session and run script
  try {
    execSync(`tmux new-session -d -s "${sessionName}" -x 200 -y 50`, {
      stdio: 'pipe',
    })

    // Send script to session
    const script = action.script.replace(/'/g, "'\\''") // Escape single quotes
    execSync(`tmux send-keys -t "${sessionName}" '${script}' C-m`, {
      stdio: 'pipe',
    })

    // Create session metadata
    const metadata: SessionMetadata = {
      id: sessionId,
      displayId,
      paneIndex: 0, // Always 0 for dedicated tmux sessions
      branch: null,
      mode: 'shell',
      worktreePath: null,
      createdAt: new Date().toISOString(),
      tmuxSession: sessionName,
      customName: `${action.icon} ${action.name}`,
    }

    // Save to session store
    existingSessions.push(metadata)
    await saveSessionStore(ACTIONS_INSTANCE_ID, existingSessions)

    // Create status file so session appears in dashboard
    const statusDir = `/tmp/orcha/${ACTIONS_INSTANCE_ID}/agents`
    await mkdir(statusDir, { recursive: true })
    const statusFile = join(statusDir, `${sessionId}.json`)
    const statusContent = {
      agentId: sessionId,
      state: 'idle',
      message: 'Running action',
      timestamp: new Date().toISOString(),
    }
    await writeFile(statusFile, JSON.stringify(statusContent, null, 2))

    return {
      sessionId,
      instanceId: ACTIONS_INSTANCE_ID,
      tmuxSession: sessionName,
      displayId,
    }
  } catch (err) {
    throw new Error(`Failed to execute action: ${(err as Error).message}`)
  }
}
