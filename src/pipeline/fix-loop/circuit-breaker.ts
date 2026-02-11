/**
 * Per-Check Circuit Breaker
 *
 * Tracks failures per gate check independently. If a specific check
 * (e.g. "test") fails with the same output pattern twice in a row,
 * that check is "circuit-broken" — its fix is skipped and it's marked
 * for escalation. Other checks' fixes still run normally.
 *
 * Hashing uses the first 2000 chars of rawOutput for stability,
 * so minor output differences (timestamps, PIDs) don't break the hash.
 */

import { createHash } from 'crypto'
import type { PerCheckBreakerState } from '../types.js'

// ============================================================================
// Constants
// ============================================================================

/** Number of consecutive same-hash failures before a check is circuit-broken. */
const BREAKER_THRESHOLD = 2

/** Max chars of rawOutput to hash (for stability against minor output diffs). */
const HASH_INPUT_LIMIT = 2000

// ============================================================================
// Per-Check Circuit Breaker
// ============================================================================

export class PerCheckCircuitBreaker {
  private state: PerCheckBreakerState

  constructor(state?: PerCheckBreakerState) {
    this.state = {
      lastFailureHash: state?.lastFailureHash ?? {},
      consecutiveCount: state?.consecutiveCount ?? {},
    }
  }

  /**
   * Check if a specific gate check should be skipped (circuit broken).
   *
   * Hashes the rawOutput and compares to the last recorded failure hash
   * for this check. If the hash matches and the consecutive count is
   * already at the threshold, the check is broken.
   */
  isCheckBroken(checkName: string, rawOutput: string): boolean {
    const hash = hashOutput(rawOutput)
    const lastHash = this.state.lastFailureHash[checkName]
    const count = this.state.consecutiveCount[checkName] ?? 0

    return hash === lastHash && count >= BREAKER_THRESHOLD
  }

  /**
   * Record a failure for a specific check.
   *
   * If the hash matches the previous failure for this check, increments
   * the consecutive count. If it's a new hash, resets the count to 1.
   *
   * Returns true if the check is now circuit-broken (count >= threshold).
   */
  recordCheckFailure(checkName: string, rawOutput: string): boolean {
    const hash = hashOutput(rawOutput)
    const lastHash = this.state.lastFailureHash[checkName]

    if (hash === lastHash) {
      // Same failure pattern — increment
      this.state.consecutiveCount[checkName] = (this.state.consecutiveCount[checkName] ?? 0) + 1
    } else {
      // New failure pattern — reset
      this.state.lastFailureHash[checkName] = hash
      this.state.consecutiveCount[checkName] = 1
    }

    return this.state.consecutiveCount[checkName] >= BREAKER_THRESHOLD
  }

  /**
   * Get serializable state for persistence on PipelineRun.
   */
  getState(): PerCheckBreakerState {
    return {
      lastFailureHash: { ...this.state.lastFailureHash },
      consecutiveCount: { ...this.state.consecutiveCount },
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Hash the first HASH_INPUT_LIMIT chars of rawOutput using SHA-256.
 * Truncating stabilizes the hash against minor output variations
 * (timestamps, process IDs, etc.) that appear later in the output.
 */
function hashOutput(rawOutput: string): string {
  const truncated = (rawOutput ?? '').slice(0, HASH_INPUT_LIMIT)
  return createHash('sha256').update(truncated).digest('hex').slice(0, 16)
}
