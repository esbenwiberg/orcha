/**
 * Learning Store
 *
 * Append-only JSON store of pipeline outcomes at:
 *   ~/.orcha/pipelines/learning.json
 *
 * Records how each pipeline run went (gate scores, fix loops, final outcome)
 * and provides relevant hints to the architect for future pipeline runs.
 */

import { readFile, writeFile, rename, mkdir, unlink, stat } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { getPipelinesRoot } from './pipeline-store.js'
import type { PipelineRun, PipelineState } from './types.js'

// ============================================================================
// Types
// ============================================================================

export interface PipelineOutcomeRecord {
  /** Pipeline run ID. */
  pipelineId: string
  /** Short description of the work item. */
  description: string
  /** Acceptance criteria (for similarity matching). */
  acceptanceCriteria: string[]
  /** Architect approach summary (first 500 chars of blueprint output). */
  approach: string
  /** Per-check gate scores from the final gate run. */
  gateScores: Record<string, 'pass' | 'fail' | 'skip'>
  /** Number of fix-loop iterations that were needed. */
  fixLoops: number
  /** Terminal state the pipeline ended in. */
  outcome: PipelineState
  /** Whether competing agents were used. */
  competing: boolean
  /** Number of competing agents (1 = standard). */
  competingCount: number
  /** Source branch. */
  sourceBranch: string
  /** ISO 8601 timestamp. */
  timestamp: string
}

export interface LearningHint {
  /** A short insight to include in the architect prompt. */
  hint: string
  /** How relevant this hint is (higher = more relevant). */
  relevance: number
}

// ============================================================================
// Persistence
// ============================================================================

function learningFilePath(): string {
  return join(getPipelinesRoot(), 'learning.json')
}

/**
 * Load all pipeline outcome records from disk.
 * Returns an empty array if the file doesn't exist yet.
 */
export async function loadLearnings(): Promise<PipelineOutcomeRecord[]> {
  try {
    const raw = await readFile(learningFilePath(), 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed as PipelineOutcomeRecord[]
    return []
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') return []
    throw err
  }
}

/** Stale lock threshold in milliseconds (30 seconds). */
const LOCK_STALE_MS = 30_000
/** Maximum attempts to acquire the lock. */
const LOCK_MAX_RETRIES = 20
/** Base delay between lock retries in milliseconds. */
const LOCK_RETRY_DELAY_MS = 150

function lockFilePath(): string {
  return `${learningFilePath()}.lock`
}

/**
 * Acquire an exclusive lockfile. Uses `wx` flag which fails atomically if
 * the file already exists. Retries with jittered backoff. Stale locks
 * (older than LOCK_STALE_MS) are force-removed.
 *
 * Returns a release function that must be called when done.
 */
async function acquireLock(): Promise<() => Promise<void>> {
  const lockPath = lockFilePath()

  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      await writeFile(lockPath, `${process.pid}:${Date.now()}`, { flag: 'wx' })
      return async () => {
        try {
          await unlink(lockPath)
        } catch {
          // Lock already removed — not a problem
        }
      }
    } catch (err: unknown) {
      if (!isNodeError(err) || err.code !== 'EEXIST') throw err

      // Lock exists — check if it's stale
      try {
        const info = await stat(lockPath)
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await unlink(lockPath)
          continue // Retry immediately after removing stale lock
        }
      } catch {
        // Lock disappeared between our check — retry immediately
        continue
      }

      // Wait with jitter before retrying
      const jitter = Math.random() * LOCK_RETRY_DELAY_MS
      await new Promise((r) => setTimeout(r, LOCK_RETRY_DELAY_MS + jitter))
    }
  }

  throw new Error(`Failed to acquire learning store lock after ${LOCK_MAX_RETRIES} attempts`)
}

/**
 * Append a pipeline outcome record to the learning store.
 * Uses file-level locking to prevent lost updates from concurrent pipelines,
 * and atomic write (write to temp, then rename) to prevent corruption.
 */
export async function appendLearning(record: PipelineOutcomeRecord): Promise<void> {
  const filePath = learningFilePath()
  const dir = getPipelinesRoot()
  await mkdir(dir, { recursive: true })

  const releaseLock = await acquireLock()
  try {
    const existing = await loadLearnings()
    existing.push(record)

    const data = JSON.stringify(existing, null, 2)
    const tmpFile = `${filePath}.tmp.${randomBytes(4).toString('hex')}`
    await writeFile(tmpFile, data, 'utf-8')
    await rename(tmpFile, filePath)
  } finally {
    await releaseLock()
  }
}

// ============================================================================
// Recording outcomes from a completed pipeline run
// ============================================================================

/**
 * Build a PipelineOutcomeRecord from a finished pipeline run and append it
 * to the learning store.
 *
 * Should be called when a pipeline reaches a terminal state
 * (completed, cancelled, escalated).
 */
export async function recordPipelineOutcome(run: PipelineRun): Promise<void> {
  // Extract gate scores from the most recent gate results
  const gateScores: Record<string, 'pass' | 'fail' | 'skip'> = {}
  for (const gr of run.gateResults) {
    gateScores[gr.checkName] = gr.verdict
  }

  // Extract approach from stage history (architect output, truncated)
  const architectResult = run.stageHistory.find((s) => s.stage === 'architect')
  const approach = architectResult?.output?.slice(0, 500) ?? ''

  const record: PipelineOutcomeRecord = {
    pipelineId: run.id,
    description: run.description,
    acceptanceCriteria: run.acceptanceCriteria,
    approach,
    gateScores,
    fixLoops: run.fixLoopCount,
    outcome: run.state,
    competing: (run.config.competingAgents ?? 1) > 1,
    competingCount: run.config.competingAgents ?? 1,
    sourceBranch: run.sourceBranch,
    timestamp: new Date().toISOString(),
  }

  await appendLearning(record)
}

// ============================================================================
// Hint Generation
// ============================================================================

/**
 * Query the learning store for hints relevant to a new pipeline run.
 *
 * Heuristics for relevance:
 * 1. Pipelines that failed or needed fix loops → warn about common pitfalls
 * 2. Pipelines on the same source branch → share context
 * 3. Recent pipelines weighted higher than old ones
 *
 * Returns up to `maxHints` hints sorted by relevance (highest first).
 */
export async function getRelevantHints(
  description: string,
  sourceBranch: string,
  maxHints: number = 5,
): Promise<LearningHint[]> {
  const records = await loadLearnings()
  if (records.length === 0) return []

  const hints: LearningHint[] = []
  const descWords = new Set(description.toLowerCase().split(/\s+/))

  for (const record of records) {
    let relevance = 0

    // Same source branch boosts relevance
    if (record.sourceBranch === sourceBranch) {
      relevance += 2
    }

    // Word overlap between descriptions boosts relevance
    const recWords = record.description.toLowerCase().split(/\s+/)
    const overlap = recWords.filter((w) => descWords.has(w) && w.length > 3).length
    relevance += Math.min(overlap, 3) // Cap at 3 points for word overlap

    // Recency bonus (records less than 7 days old get a boost)
    const ageMs = Date.now() - new Date(record.timestamp).getTime()
    const ageDays = ageMs / (1000 * 60 * 60 * 24)
    if (ageDays < 7) relevance += 1

    // Only generate hints from records that have something useful to say
    if (relevance < 1) continue

    // Generate hints based on outcome
    if (record.outcome === 'completed' && record.fixLoops === 0) {
      hints.push({
        hint: `A similar task ("${record.description.slice(0, 80)}") succeeded on the first gate pass. Approach: ${record.approach.slice(0, 200)}`,
        relevance,
      })
    } else if (record.outcome === 'completed' && record.fixLoops > 0) {
      const failedChecks = Object.entries(record.gateScores)
        .filter(([, v]) => v === 'fail')
        .map(([k]) => k)
        .join(', ')
      hints.push({
        hint: `A similar task ("${record.description.slice(0, 80)}") needed ${record.fixLoops} fix loop(s) due to gate failures in: ${failedChecks || 'unknown'}. Pay extra attention to those areas.`,
        relevance: relevance + 1, // Failures are more useful as hints
      })
    } else if (record.outcome === 'escalated') {
      const failedChecks = Object.entries(record.gateScores)
        .filter(([, v]) => v === 'fail')
        .map(([k]) => k)
        .join(', ')
      hints.push({
        hint: `WARNING: A similar task ("${record.description.slice(0, 80)}") was escalated after exhausting fix loops. Failed checks: ${failedChecks || 'unknown'}. Design the blueprint to avoid these issues.`,
        relevance: relevance + 2, // Escalations are most important
      })
    } else if (record.outcome === 'cancelled') {
      hints.push({
        hint: `A similar task ("${record.description.slice(0, 80)}") was cancelled. Consider whether the blueprint needs a different approach.`,
        relevance,
      })
    }
  }

  // Sort by relevance (highest first) and take top N
  hints.sort((a, b) => b.relevance - a.relevance)
  return hints.slice(0, maxHints)
}

// ============================================================================
// Internal
// ============================================================================

interface NodeError extends Error {
  code?: string
}

function isNodeError(err: unknown): err is NodeError {
  return err instanceof Error && 'code' in err
}
