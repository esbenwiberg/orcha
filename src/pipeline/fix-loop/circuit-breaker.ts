/**
 * Circuit Breaker
 *
 * Detects repeated failures in the fix loop and prevents infinite retries.
 * Uses a simple signature-based approach: if the same failure pattern appears
 * multiple times (threshold = 2), the circuit breaker triggers escalation.
 *
 * Signature computation:
 * - Hash of "${checkName}:${firstLineOfSummary}" for each failing gate check
 * - Combined into a single signature hash for the entire gate result set
 */

import { createHash } from 'crypto'
import type { GateResult, FailureSignature, CircuitBreakerState } from '../types.js'

// ============================================================================
// Constants
// ============================================================================

/** Number of times a failure signature must repeat before escalating. */
const ESCALATION_THRESHOLD = 2

// ============================================================================
// Circuit Breaker Class
// ============================================================================

export class CircuitBreaker {
  private state: CircuitBreakerState

  constructor(initialState?: CircuitBreakerState) {
    this.state = initialState ?? {
      failureCounts: {},
      lastUpdated: new Date().toISOString(),
    }
  }

  /**
   * Record a failure signature and check if escalation threshold is reached.
   * Returns true if the circuit breaker has tripped (should escalate).
   */
  recordFailure(signature: FailureSignature): boolean {
    const count = (this.state.failureCounts[signature.hash] ?? 0) + 1
    this.state.failureCounts[signature.hash] = count
    this.state.lastUpdated = new Date().toISOString()

    return count >= ESCALATION_THRESHOLD
  }

  /**
   * Check if a failure signature has been seen before (without incrementing count).
   */
  isRepeatedFailure(signature: FailureSignature): boolean {
    const count = this.state.failureCounts[signature.hash] ?? 0
    return count >= ESCALATION_THRESHOLD
  }

  /**
   * Compute a failure signature from gate results.
   * Only includes FAILED checks (ignores passing/skipped checks).
   */
  computeSignature(gateResults: GateResult[]): FailureSignature {
    const failures = gateResults.filter((r) => r.verdict === 'fail')

    if (failures.length === 0) {
      // No failures — this shouldn't happen in fix-loop, but handle gracefully
      return {
        hash: 'no-failures',
        description: 'No failures (unexpected in fix-loop)',
      }
    }

    // Build a signature from each failing check
    const checkSignatures = failures.map((f) => {
      const firstLine = f.summary.split('\n')[0].trim()
      return `${f.checkName}:${firstLine}`
    })

    // Sort to ensure consistent hashing regardless of check order
    checkSignatures.sort()

    // Hash the combined signature
    const combinedSignature = checkSignatures.join('||')
    const hash = createHash('sha256').update(combinedSignature).digest('hex').slice(0, 16)

    // Build human-readable description
    const description = failures.map((f) => f.checkName).join(', ')

    return {
      hash,
      description: `Failed checks: ${description}`,
    }
  }

  /**
   * Get the current circuit breaker state (for persistence).
   */
  getState(): CircuitBreakerState {
    return { ...this.state }
  }

  /**
   * Reset the circuit breaker state (useful for retry-escalated).
   */
  reset(): void {
    this.state = {
      failureCounts: {},
      lastUpdated: new Date().toISOString(),
    }
  }
}
