/**
 * Pipeline Store
 *
 * CRUD operations for pipeline run state persisted at:
 *   ~/.orcha/pipelines/{pipelineId}/state.json
 *
 * Uses atomic writes (write to temp file, then rename) to prevent corruption
 * from concurrent access or mid-write crashes.
 */

import { readFile, writeFile, mkdir, rename, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import { WorktreeManager } from '../core/worktree-manager.js'
import type { PipelineRun } from './types.js'

// ============================================================================
// Paths
// ============================================================================

const ORCHA_DIR = join(homedir(), '.orcha')
const PIPELINES_DIR = join(ORCHA_DIR, 'pipelines')

function pipelineDir(pipelineId: string): string {
  return join(PIPELINES_DIR, pipelineId)
}

function stateFilePath(pipelineId: string): string {
  return join(pipelineDir(pipelineId), 'state.json')
}

// ============================================================================
// ID Generation
// ============================================================================

/**
 * Generate a unique pipeline ID that includes a timestamp for natural ordering.
 * Format: `pl-{YYYYMMDD-HHmmss}-{random}`
 */
export function generatePipelineId(): string {
  const now = new Date()
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 15) // YYYYMMDDHHmmssS
  const rand = randomBytes(4).toString('hex') // 8 hex chars
  return `pl-${ts}-${rand}`
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Save (create or update) a pipeline run to disk using atomic write.
 */
export async function savePipelineRun(run: PipelineRun): Promise<void> {
  const dir = pipelineDir(run.id)
  await mkdir(dir, { recursive: true })

  const data = JSON.stringify(run, null, 2)
  const tmpFile = join(dir, `state.json.tmp.${randomBytes(4).toString('hex')}`)

  // Atomic write: write to temp file, then rename into place.
  await writeFile(tmpFile, data, 'utf-8')
  await rename(tmpFile, stateFilePath(run.id))
}

/**
 * Load a pipeline run by ID. Returns null if not found.
 */
export async function loadPipelineRun(pipelineId: string): Promise<PipelineRun | null> {
  try {
    const raw = await readFile(stateFilePath(pipelineId), 'utf-8')
    return JSON.parse(raw) as PipelineRun
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return null
    }
    throw err
  }
}

/**
 * List all pipeline IDs found on disk, sorted newest-first (by directory name
 * which contains a timestamp).
 */
export async function listPipelineIds(): Promise<string[]> {
  try {
    const entries = await readdir(PIPELINES_DIR, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && e.name.startsWith('pl-'))
      .map((e) => e.name)
      .sort()
      .reverse()
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return []
    }
    throw err
  }
}

/**
 * List all pipeline runs on disk (loads each state.json).
 * Skips any entries that fail to parse.
 */
export async function listPipelineRuns(): Promise<PipelineRun[]> {
  const ids = await listPipelineIds()
  const results = await Promise.all(ids.map((id) => loadPipelineRun(id)))
  return results.filter((run): run is PipelineRun => run !== null)
}

/**
 * Delete a pipeline run directory entirely.
 * If the pipeline had a managed worktree, removes it first (non-fatal on error).
 */
export async function deletePipelineRun(pipelineId: string): Promise<boolean> {
  try {
    // Load state before deletion to check for managed worktree
    const run = await loadPipelineRun(pipelineId)
    if (run?.worktreeManaged && run.repoPath) {
      try {
        const wm = new WorktreeManager(run.repoPath)
        await wm.remove(pipelineId)
        await wm.prune()
      } catch (err) {
        console.error(`[pipeline-store] Non-fatal: failed to remove worktree for ${pipelineId}:`, (err as Error).message)
      }
    }

    await rm(pipelineDir(pipelineId), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Return the base directory for a pipeline (useful for storing artefacts
 * alongside state.json, e.g. blueprints, logs).
 */
export function getPipelineDir(pipelineId: string): string {
  return pipelineDir(pipelineId)
}

/**
 * Return the root pipelines directory (~/.orcha/pipelines).
 */
export function getPipelinesRoot(): string {
  return PIPELINES_DIR
}

// ============================================================================
// Internal Helpers
// ============================================================================

interface NodeError extends Error {
  code?: string
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && 'code' in err
}
