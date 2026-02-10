/**
 * Fix Success Rate Tracker
 *
 * Tracks fix-loop metrics to provide observability into the fix process:
 * - Success rate by pattern type
 * - Attempts distribution (1, 2, 3, escalated)
 * - Circuit breaker trigger rate
 * - Average time per fix attempt
 *
 * Stored in: ~/.orcha/learning/fix-metrics.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'

// ============================================================================
// Constants
// ============================================================================

const LEARNING_DIR = join(homedir(), '.orcha', 'learning')
const METRICS_FILE = join(LEARNING_DIR, 'fix-metrics.json')

// ============================================================================
// Types
// ============================================================================

/**
 * Outcome of a fix-loop attempt.
 */
export type FixOutcome = 'success' | 'failed' | 'escalated' | 'circuit-breaker'

/**
 * Record of a single fix attempt.
 */
export interface FixAttemptRecord {
  /** Pipeline ID this attempt belongs to. */
  pipelineId: string
  /** Attempt number (1-indexed). */
  attempt: number
  /** Outcome of this attempt. */
  outcome: FixOutcome
  /** Pattern type that was being fixed (e.g. 'command-injection', 'test-failure'). */
  patternType?: string
  /** Time spent on this attempt in milliseconds. */
  durationMs?: number
  /** ISO 8601 timestamp. */
  timestamp: string
}

/**
 * Aggregated fix-loop metrics.
 */
export interface FixLoopMetrics {
  /** Total number of fix attempts across all pipelines. */
  totalAttempts: number
  /** Attempts distribution: { 1: count, 2: count, 3: count, escalated: count } */
  attemptsDistribution: Record<string, number>
  /** Success rate by pattern type: { 'pattern-type': { attempts: number, successes: number, rate: number } } */
  successRateByPattern: Record<string, { attempts: number; successes: number; rate: number }>
  /** Number of times circuit breaker triggered. */
  circuitBreakerTriggers: number
  /** Average time per fix attempt in milliseconds. */
  averageTimePerAttemptMs: number
  /** Total pipelines tracked. */
  totalPipelines: number
  /** Last updated timestamp. */
  updatedAt: string
}

/**
 * Raw metrics storage format.
 */
interface MetricsStorage {
  /** All recorded fix attempts. */
  attempts: FixAttemptRecord[]
  /** Last updated timestamp. */
  updatedAt: string
}

// ============================================================================
// Fix Success Rate Store
// ============================================================================

export class FixSuccessRateStore {
  private attempts: FixAttemptRecord[] = []

  /**
   * Load metrics from disk.
   */
  async load(): Promise<void> {
    if (!existsSync(METRICS_FILE)) {
      this.attempts = []
      return
    }

    try {
      const content = await readFile(METRICS_FILE, 'utf-8')
      const data: MetricsStorage = JSON.parse(content)
      this.attempts = Array.isArray(data.attempts) ? data.attempts : []
    } catch {
      // Corrupted or invalid JSON — reset
      this.attempts = []
    }
  }

  /**
   * Save metrics to disk.
   */
  async save(): Promise<void> {
    await mkdir(LEARNING_DIR, { recursive: true })
    const data: MetricsStorage = {
      attempts: this.attempts,
      updatedAt: new Date().toISOString(),
    }
    await writeFile(METRICS_FILE, JSON.stringify(data, null, 2), 'utf-8')
  }

  /**
   * Track a fix attempt.
   *
   * @param pipelineId - Pipeline ID
   * @param attempt - Attempt number (1-indexed)
   * @param outcome - Outcome of the attempt
   * @param patternType - Optional pattern type being fixed
   * @param durationMs - Optional duration in milliseconds
   */
  trackFixSuccess(
    pipelineId: string,
    attempt: number,
    outcome: FixOutcome,
    patternType?: string,
    durationMs?: number,
  ): void {
    this.attempts.push({
      pipelineId,
      attempt,
      outcome,
      patternType,
      durationMs,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Get success rate for a specific pattern type.
   *
   * @param patternType - Pattern type to query
   * @returns Success rate and attempt counts
   */
  getSuccessRate(patternType: string): { attempts: number[]; successRate: number } {
    const records = this.attempts.filter((a) => a.patternType === patternType)
    const attempts = records.map((r) => r.attempt)
    const successes = records.filter((r) => r.outcome === 'success').length
    const successRate = records.length > 0 ? successes / records.length : 0

    return { attempts, successRate }
  }

  /**
   * Get comprehensive fix-loop metrics.
   *
   * @returns Aggregated metrics
   */
  getMetrics(): FixLoopMetrics {
    const totalAttempts = this.attempts.length
    const uniquePipelines = new Set(this.attempts.map((a) => a.pipelineId)).size

    // Attempts distribution
    const attemptsDistribution: Record<string, number> = {
      '1': 0,
      '2': 0,
      '3': 0,
      'escalated': 0,
    }

    // Group by pipeline to get max attempt per pipeline
    const pipelineGroups = new Map<string, FixAttemptRecord[]>()
    for (const attempt of this.attempts) {
      if (!pipelineGroups.has(attempt.pipelineId)) {
        pipelineGroups.set(attempt.pipelineId, [])
      }
      pipelineGroups.get(attempt.pipelineId)!.push(attempt)
    }

    // Count distribution
    for (const [, records] of pipelineGroups) {
      const maxAttempt = Math.max(...records.map((r) => r.attempt))
      const escalated = records.some((r) => r.outcome === 'escalated')

      if (escalated) {
        attemptsDistribution['escalated']++
      } else if (maxAttempt <= 3) {
        attemptsDistribution[maxAttempt.toString()]++
      } else {
        attemptsDistribution['escalated']++
      }
    }

    // Success rate by pattern
    const successRateByPattern: Record<
      string,
      { attempts: number; successes: number; rate: number }
    > = {}

    const patternGroups = new Map<string, FixAttemptRecord[]>()
    for (const attempt of this.attempts) {
      if (!attempt.patternType) continue
      if (!patternGroups.has(attempt.patternType)) {
        patternGroups.set(attempt.patternType, [])
      }
      patternGroups.get(attempt.patternType)!.push(attempt)
    }

    for (const [pattern, records] of patternGroups) {
      const attempts = records.length
      const successes = records.filter((r) => r.outcome === 'success').length
      const rate = attempts > 0 ? successes / attempts : 0

      successRateByPattern[pattern] = { attempts, successes, rate }
    }

    // Circuit breaker triggers
    const circuitBreakerTriggers = this.attempts.filter(
      (a) => a.outcome === 'circuit-breaker',
    ).length

    // Average time per attempt
    const attemptsWithDuration = this.attempts.filter((a) => a.durationMs !== undefined)
    const averageTimePerAttemptMs =
      attemptsWithDuration.length > 0
        ? attemptsWithDuration.reduce((sum, a) => sum + (a.durationMs ?? 0), 0) /
          attemptsWithDuration.length
        : 0

    return {
      totalAttempts,
      attemptsDistribution,
      successRateByPattern,
      circuitBreakerTriggers,
      averageTimePerAttemptMs,
      totalPipelines: uniquePipelines,
      updatedAt: new Date().toISOString(),
    }
  }

  /**
   * Clear all metrics (for testing).
   */
  clear(): void {
    this.attempts = []
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let storeInstance: FixSuccessRateStore | null = null

/**
 * Get the singleton store instance.
 * Automatically loads from disk on first access.
 */
export async function getFixSuccessRateStore(): Promise<FixSuccessRateStore> {
  if (!storeInstance) {
    storeInstance = new FixSuccessRateStore()
    await storeInstance.load()
  }
  return storeInstance
}

/**
 * Track a fix attempt (convenience function).
 */
export async function trackFixSuccess(
  pipelineId: string,
  attempt: number,
  outcome: FixOutcome,
  patternType?: string,
  durationMs?: number,
): Promise<void> {
  const store = await getFixSuccessRateStore()
  store.trackFixSuccess(pipelineId, attempt, outcome, patternType, durationMs)
  await store.save()
}

/**
 * Get success rate for a pattern (convenience function).
 */
export async function getSuccessRate(
  patternType: string,
): Promise<{ attempts: number[]; successRate: number }> {
  const store = await getFixSuccessRateStore()
  return store.getSuccessRate(patternType)
}

/**
 * Get comprehensive metrics (convenience function).
 */
export async function getMetrics(): Promise<FixLoopMetrics> {
  const store = await getFixSuccessRateStore()
  return store.getMetrics()
}
