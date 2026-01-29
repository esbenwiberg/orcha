/**
 * Instance Registry - Track running orcha instances across repositories
 *
 * Manages ~/.orcha/instances.json to enable:
 * - Running separate orcha instances for different repos
 * - Listing all active instances
 * - Auto-detecting which instance to control based on cwd
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'
import type { InstanceInfo, InstanceRegistry } from './types.js'
import { generateInstanceId, generateInstanceIdWithHash } from './instance-id.js'

const ORCHA_DIR = join(homedir(), '.orcha')
const REGISTRY_FILE = join(ORCHA_DIR, 'instances.json')
const REGISTRY_VERSION = 1

/**
 * Load the instance registry from disk
 */
export async function loadRegistry(): Promise<InstanceRegistry> {
  try {
    if (!existsSync(REGISTRY_FILE)) {
      return { version: REGISTRY_VERSION, instances: {} }
    }

    const content = await readFile(REGISTRY_FILE, 'utf-8')
    const registry = JSON.parse(content) as InstanceRegistry

    // Handle version migrations if needed in future
    if (!registry.version) {
      registry.version = REGISTRY_VERSION
    }

    return registry
  } catch {
    // If file is corrupted, start fresh
    return { version: REGISTRY_VERSION, instances: {} }
  }
}

/**
 * Save the instance registry to disk
 */
export async function saveRegistry(registry: InstanceRegistry): Promise<void> {
  await mkdir(ORCHA_DIR, { recursive: true })
  await writeFile(REGISTRY_FILE, JSON.stringify(registry, null, 2))
}

/**
 * Register a new orcha instance
 *
 * @param repoPath - Path to the repository
 * @param sessionCount - Number of AI sessions
 * @returns The registered instance info
 */
export async function registerInstance(
  repoPath: string,
  sessionCount: number
): Promise<InstanceInfo> {
  const registry = await loadRegistry()
  const absolutePath = resolve(repoPath)

  // Generate instance ID, handling collisions
  let instanceId = generateInstanceId(repoPath)

  // Check for collision (same name, different path)
  const existing = registry.instances[instanceId]
  if (existing && existing.repoPath !== absolutePath) {
    // Use hash suffix to differentiate
    instanceId = generateInstanceIdWithHash(repoPath)
  }

  const instance: InstanceInfo = {
    instanceId,
    repoPath: absolutePath,
    tmuxSession: instanceId,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    sessionCount,
  }

  registry.instances[instanceId] = instance
  await saveRegistry(registry)

  return instance
}

/**
 * Unregister an orcha instance
 */
export async function unregisterInstance(instanceId: string): Promise<boolean> {
  const registry = await loadRegistry()

  if (!registry.instances[instanceId]) {
    return false
  }

  delete registry.instances[instanceId]
  await saveRegistry(registry)

  return true
}

/**
 * Update instance session count
 */
export async function updateInstanceSessionCount(
  instanceId: string,
  sessionCount: number
): Promise<void> {
  const registry = await loadRegistry()

  if (registry.instances[instanceId]) {
    registry.instances[instanceId].sessionCount = sessionCount
    await saveRegistry(registry)
  }
}

/**
 * Get instance by ID
 */
export async function getInstance(instanceId: string): Promise<InstanceInfo | null> {
  const registry = await loadRegistry()
  return registry.instances[instanceId] || null
}

/**
 * Get instance for a repository path
 */
export async function getInstanceByPath(repoPath: string): Promise<InstanceInfo | null> {
  const registry = await loadRegistry()
  const absolutePath = resolve(repoPath)

  for (const instance of Object.values(registry.instances)) {
    if (instance.repoPath === absolutePath) {
      return instance
    }
  }

  return null
}

/**
 * Find instance from current working directory
 *
 * Walks up the directory tree to find a registered repo
 */
export async function findInstanceFromCwd(cwd: string = process.cwd()): Promise<InstanceInfo | null> {
  const registry = await loadRegistry()
  let currentPath = resolve(cwd)

  // Walk up directory tree
  while (currentPath !== '/') {
    for (const instance of Object.values(registry.instances)) {
      if (instance.repoPath === currentPath) {
        return instance
      }
    }

    // Move up one directory
    const parent = join(currentPath, '..')
    if (parent === currentPath) break
    currentPath = parent
  }

  return null
}

/**
 * List all registered instances
 */
export async function listInstances(): Promise<InstanceInfo[]> {
  const registry = await loadRegistry()
  return Object.values(registry.instances)
}

/**
 * Clean up stale instances (tmux sessions no longer running)
 */
export async function cleanupStaleInstances(): Promise<string[]> {
  const registry = await loadRegistry()
  const removed: string[] = []

  for (const [instanceId, instance] of Object.entries(registry.instances)) {
    if (!isTmuxSessionRunning(instance.tmuxSession)) {
      delete registry.instances[instanceId]
      removed.push(instanceId)
    }
  }

  if (removed.length > 0) {
    await saveRegistry(registry)
  }

  return removed
}

/**
 * Check if a tmux session exists
 */
function isTmuxSessionRunning(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${sessionName} 2>/dev/null`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

/**
 * Get the status directory for an instance
 */
export function getInstanceStatusDir(instanceId: string): string {
  return `/tmp/orcha/${instanceId}/agents`
}

/**
 * Get the orcha home directory
 */
export function getOrchaDir(): string {
  return ORCHA_DIR
}
