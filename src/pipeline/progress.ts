/**
 * Progress File System
 *
 * Append-only JSONL log for pipeline progress events.
 * Each pipeline run stores its progress at:
 *   ~/.orcha/pipelines/{pipelineId}/progress.jsonl
 *
 * Data flow:
 *   stage-runner / pipeline-engine / gate / dev / fix-loop / checkpoint
 *       |
 *       v
 *   appendProgress(pipelineId, entry)  -->  progress.jsonl
 *       |
 *       v
 *   pipelineEvents.emitProgress(entry) -->  WebSocket broadcast
 */

import { appendFile, readFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { getPipelineDir } from './pipeline-store.js'
import { pipelineEvents } from './events.js'

// ============================================================================
// Types
// ============================================================================

export type ProgressType =
  | 'stage-start'
  | 'stage-complete'
  | 'stage-error'
  | 'stage-activity'
  | 'gate-result'
  | 'checkpoint'
  | 'fix-loop'
  | 'info'
  | 'competing-start'
  | 'competing-result'

export interface ProgressEntry {
  /** ISO 8601 timestamp. */
  timestamp: string
  /** Type of progress event. */
  type: ProgressType
  /** Stage name (e.g. "architect", "dev", "gate"). */
  stage?: string
  /** Human-readable headline. */
  title: string
  /** Extended info (gate summary, error message, etc.). */
  detail?: string
  /** Structured payload (gate results, usage, etc.). */
  data?: Record<string, unknown>
}

// ============================================================================
// Append / Read
// ============================================================================

/**
 * Append a progress entry to the pipeline's progress.jsonl file
 * and emit it via the event system for real-time consumers.
 *
 * Uses `fs.appendFile` with the 'a' flag for atomic appends on Linux.
 */
export async function appendProgress(
  pipelineId: string,
  entry: Omit<ProgressEntry, 'timestamp'> & { timestamp?: string },
): Promise<void> {
  const full: ProgressEntry = {
    timestamp: entry.timestamp ?? new Date().toISOString(),
    type: entry.type,
    stage: entry.stage,
    title: entry.title,
    detail: entry.detail,
    data: entry.data,
  }

  // Ensure pipeline directory exists
  const dir = getPipelineDir(pipelineId)
  await mkdir(dir, { recursive: true })

  const filePath = join(dir, 'progress.jsonl')
  const line = JSON.stringify(full) + '\n'
  await appendFile(filePath, line, { encoding: 'utf-8', flag: 'a' })

  // Broadcast to real-time consumers (e.g. web dashboard)
  pipelineEvents.emitProgress({ pipelineId, entry: full })
}

/**
 * Read all progress entries from a pipeline's progress.jsonl file.
 *
 * Returns an empty array if the file does not exist.
 * Silently skips malformed lines.
 */
export async function readProgress(pipelineId: string): Promise<ProgressEntry[]> {
  const filePath = join(getPipelineDir(pipelineId), 'progress.jsonl')

  let raw: string
  try {
    raw = await readFile(filePath, 'utf-8')
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return []
    }
    throw err
  }

  const entries: ProgressEntry[] = []
  const lines = raw.split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      entries.push(JSON.parse(trimmed) as ProgressEntry)
    } catch {
      // Skip malformed lines
    }
  }
  return entries
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
