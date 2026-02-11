/**
 * User Actions for Escalated Pipelines
 *
 * Handles user-initiated actions on escalated pipelines:
 * - Skip gate checks
 * - Override severity thresholds
 * - Retry with feedback
 * - Abort pipeline
 * - Force ship
 */

import type { PipelineRun, UserAction, Severity } from '../types.js'
import { loadPipelineRun, savePipelineRun } from '../pipeline-store.js'
import { transition } from '../pipeline-engine.js'
import { retryEscalatedPipeline } from '../checkpoint.js'
import { AuditLogger } from './audit-log.js'

// ============================================================================
// User Action Processor
// ============================================================================

/**
 * Process a user action on an escalated pipeline.
 * Returns the updated pipeline run.
 */
export async function processUserAction(
  pipelineId: string,
  action: UserAction,
): Promise<PipelineRun> {
  const auditLogger = new AuditLogger(pipelineId)

  try {
    let run = await loadPipelineRun(pipelineId)
    if (!run) {
      throw new Error(`Pipeline ${pipelineId} not found`)
    }

    // Verify pipeline is escalated
    if (run.state !== 'escalated') {
      throw new Error(`Pipeline ${pipelineId} is not escalated (current state: ${run.state})`)
    }

    // Route to appropriate handler
    switch (action.type) {
      case 'skip-gate':
        run = await handleSkipGate(run, action.gateName!)
        break
      case 'override-severity':
        run = await handleOverrideSeverity(run, action.severityThreshold!)
        break
      case 'retry-with-feedback':
        run = await handleRetryWithFeedback(run, action.feedback!)
        break
      case 'abort':
        run = await handleAbort(run)
        break
      case 'force-ship':
        run = await handleForceShip(run)
        break
      default:
        throw new Error(`Unknown action type: ${(action as UserAction).type}`)
    }

    // Log successful action
    await auditLogger.logAction(action, 'success', { newState: run.state })

    return run
  } catch (err) {
    // Log failed action
    await auditLogger.logAction(action, 'error', { error: (err as Error).message })
    throw err
  }
}

// ============================================================================
// Action Handlers
// ============================================================================

/**
 * Skip a specific gate check.
 * Adds the gate name to skipChecks and transitions to 'gate' for re-run.
 */
async function handleSkipGate(run: PipelineRun, gateName: string): Promise<PipelineRun> {
  if (!gateName) {
    throw new Error('Gate name is required for skip-gate action')
  }

  // Add to skipChecks (avoid duplicates)
  const skipChecks = run.skipChecks ?? []
  if (!skipChecks.includes(gateName)) {
    skipChecks.push(gateName)
  }

  // Update run with skipChecks
  const updatedRun: PipelineRun = {
    ...run,
    skipChecks,
    updatedAt: new Date().toISOString(),
  }
  await savePipelineRun(updatedRun)

  // Transition to 'gate' for re-run
  return await transition(updatedRun, 'gate')
}

/**
 * Override the severity threshold.
 * Updates the config and transitions to 'gate' for re-run.
 */
async function handleOverrideSeverity(run: PipelineRun, threshold: Severity): Promise<PipelineRun> {
  if (!threshold) {
    throw new Error('Severity threshold is required for override-severity action')
  }

  // Update severity threshold in config
  const updatedRun: PipelineRun = {
    ...run,
    config: {
      ...run.config,
      severityThreshold: threshold,
    },
    updatedAt: new Date().toISOString(),
  }
  await savePipelineRun(updatedRun)

  // Transition to 'gate' for re-run
  return await transition(updatedRun, 'gate')
}

/**
 * Retry with user feedback.
 * Delegates to retryEscalatedPipeline which bumps maxFixLoops,
 * resets circuit breaker, and transitions to 'fix-loop'.
 */
async function handleRetryWithFeedback(run: PipelineRun, feedback: string): Promise<PipelineRun> {
  if (!feedback) {
    throw new Error('Feedback is required for retry-with-feedback action')
  }

  // Reset circuit breaker so repeated failure patterns don't trip immediately
  const cleared: PipelineRun = {
    ...run,
    circuitBreakerState: undefined,
    updatedAt: new Date().toISOString(),
  }
  await savePipelineRun(cleared)

  // Delegate to retryEscalatedPipeline which bumps maxFixLoops and transitions
  return await retryEscalatedPipeline(cleared, {
    additionalRetries: 1,
    instructions: feedback,
  })
}

/**
 * Abort the pipeline.
 * Transitions to 'cancelled'.
 */
async function handleAbort(run: PipelineRun): Promise<PipelineRun> {
  // Transition to 'cancelled'
  return await transition(run, 'cancelled')
}

/**
 * Force ship the pipeline.
 * Skips remaining gates and transitions to 'ship'.
 */
async function handleForceShip(run: PipelineRun): Promise<PipelineRun> {
  // Clear gate results (to bypass gate checks)
  const updatedRun: PipelineRun = {
    ...run,
    gateResults: [],
    updatedAt: new Date().toISOString(),
  }
  await savePipelineRun(updatedRun)

  // Transition to 'ship' for deployment
  return await transition(updatedRun, 'ship')
}
