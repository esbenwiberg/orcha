/**
 * SessionStore - Persist session metadata across CLI invocations
 *
 * Stores session info (branch, mode, worktreePath) separately from
 * status files so it survives agent status updates.
 */

import { readFile, writeFile, mkdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import type { SessionMode } from './types.js'

export interface SessionMetadata {
  id: string
  displayId: number
  branch: string | null
  mode: SessionMode
  worktreePath: string | null
  createdAt: string // ISO 8601
}

export interface SessionStoreData {
  version: number
  sessions: SessionMetadata[]
}

const STORE_VERSION = 1

/**
 * Get the session store file path for an instance
 */
function getStorePath(instanceId: string): string {
  return `/tmp/orcha/${instanceId}/sessions.json`
}

/**
 * Load session metadata for an instance
 */
export async function loadSessionStore(instanceId: string): Promise<SessionMetadata[]> {
  const storePath = getStorePath(instanceId)

  try {
    if (!existsSync(storePath)) {
      return []
    }

    const content = await readFile(storePath, 'utf-8')
    const data = JSON.parse(content) as SessionStoreData

    return data.sessions || []
  } catch {
    return []
  }
}

/**
 * Save session metadata for an instance
 */
export async function saveSessionStore(
  instanceId: string,
  sessions: SessionMetadata[]
): Promise<void> {
  const storePath = getStorePath(instanceId)
  const dir = join(storePath, '..')

  await mkdir(dir, { recursive: true })

  const data: SessionStoreData = {
    version: STORE_VERSION,
    sessions,
  }

  await writeFile(storePath, JSON.stringify(data, null, 2))
}

/**
 * Add a session to the store
 */
export async function addSession(
  instanceId: string,
  session: SessionMetadata
): Promise<void> {
  const sessions = await loadSessionStore(instanceId)
  sessions.push(session)
  await saveSessionStore(instanceId, sessions)
}

/**
 * Remove a session from the store
 */
export async function removeSession(
  instanceId: string,
  sessionId: string
): Promise<void> {
  const sessions = await loadSessionStore(instanceId)
  const filtered = sessions.filter((s) => s.id !== sessionId)
  await saveSessionStore(instanceId, filtered)
}

/**
 * Clear the session store for an instance
 */
export async function clearSessionStore(instanceId: string): Promise<void> {
  const storePath = getStorePath(instanceId)

  if (existsSync(storePath)) {
    await unlink(storePath)
  }
}

/**
 * Get session metadata by ID
 */
export async function getSessionMetadata(
  instanceId: string,
  sessionId: string
): Promise<SessionMetadata | null> {
  const sessions = await loadSessionStore(instanceId)
  return sessions.find((s) => s.id === sessionId) || null
}

/**
 * Get session metadata by display ID (#1, #2, etc.)
 */
export async function getSessionByDisplayId(
  instanceId: string,
  displayId: number
): Promise<SessionMetadata | null> {
  const sessions = await loadSessionStore(instanceId)
  return sessions.find((s) => s.displayId === displayId) || null
}
