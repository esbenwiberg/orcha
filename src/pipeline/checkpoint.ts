/**
 * Checkpoint Module
 *
 * Manages human approval checkpoints in the pipeline:
 * - checkpoint:arch — approve/reject/feedback on the architect blueprint
 * - checkpoint:ship — approve/reject before shipping
 *
 * Also handles pause/resume for `orcha stop` during active stages.
 */

import type { PipelineRun } from './types.js'
import { transition, executeArchitectStage, getRecoveryTarget, isValidTransition } from './pipeline-engine.js'
import { loadPipelineRun, savePipelineRun } from './pipeline-store.js'
import { pipelineEvents } from './events.js'

// ============================================================================
// Checkpoint: Architect
// ============================================================================

/**
 * Approve the architect blueprint and advance to dev stage.
 *
 * Expects pipeline in 'checkpoint:arch' state.
 * Transitions to 'dev' (caller should then execute the dev stage).
 */
export async function approveArchitectCheckpoint(
  run: PipelineRun,
): Promise<PipelineRun> {
  if (run.state !== 'checkpoint:arch') {
    throw new Error(`Cannot approve: pipeline is in '${run.state}', expected 'checkpoint:arch'`)
  }
  return await transition(run, 'dev')
}

/**
 * Reject the architect blueprint and cancel the pipeline.
 *
 * Expects pipeline in 'checkpoint:arch' state.
 * Transitions to 'cancelled'.
 */
export async function rejectArchitectCheckpoint(
  run: PipelineRun,
): Promise<PipelineRun> {
  if (run.state !== 'checkpoint:arch') {
    throw new Error(`Cannot reject: pipeline is in '${run.state}', expected 'checkpoint:arch'`)
  }
  return await transition(run, 'cancelled')
}

/**
 * Provide feedback on the architect blueprint and re-run the architect stage.
 *
 * Expects pipeline in 'checkpoint:arch' state.
 * Transitions checkpoint:arch → architect, then re-runs architect with
 * original prompt + user feedback appended. The new blueprint replaces
 * the previous one.
 */
export async function feedbackArchitectCheckpoint(
  run: PipelineRun,
  feedback: string,
): Promise<PipelineRun> {
  if (run.state !== 'checkpoint:arch') {
    throw new Error(`Cannot give feedback: pipeline is in '${run.state}', expected 'checkpoint:arch'`)
  }

  // Transition back to architect
  run = await transition(run, 'architect')

  // Re-run architect with feedback appended to the description
  const originalDescription = run.description
  const augmentedRun: PipelineRun = {
    ...run,
    description: `${originalDescription}\n\n## Feedback from reviewer\n${feedback}`,
  }

  // Execute architect (it handles checkpoint:arch transition internally)
  run = await executeArchitectStage(augmentedRun)

  // Restore original description (feedback was one-shot context) and persist
  if (run.state === 'checkpoint:arch') {
    run = { ...run, description: originalDescription }
    await savePipelineRun(run)
  }

  return run
}

// ============================================================================
// Checkpoint: Ship
// ============================================================================

/**
 * Approve the ship checkpoint and advance to ship stage.
 *
 * Expects pipeline in 'checkpoint:ship' state.
 * Transitions to 'ship' (caller should then execute the ship stage).
 */
export async function approveShipCheckpoint(
  run: PipelineRun,
): Promise<PipelineRun> {
  if (run.state !== 'checkpoint:ship') {
    throw new Error(`Cannot approve: pipeline is in '${run.state}', expected 'checkpoint:ship'`)
  }
  return await transition(run, 'ship')
}

/**
 * Reject the ship checkpoint and cancel the pipeline.
 *
 * Expects pipeline in 'checkpoint:ship' state.
 * Transitions to 'cancelled'.
 */
export async function rejectShipCheckpoint(
  run: PipelineRun,
): Promise<PipelineRun> {
  if (run.state !== 'checkpoint:ship') {
    throw new Error(`Cannot reject: pipeline is in '${run.state}', expected 'checkpoint:ship'`)
  }
  return await transition(run, 'cancelled')
}

// ============================================================================
// Pause / Resume
// ============================================================================

/**
 * Pause a running pipeline.
 *
 * Transitions any active state to 'paused', recording which stage was active.
 */
export async function pausePipeline(run: PipelineRun): Promise<PipelineRun> {
  return await transition(run, 'paused')
}

/**
 * Resume a paused pipeline.
 *
 * Transitions from 'paused' back to the stage that was active when paused.
 * Returns the updated run — caller must re-execute the resumed stage.
 */
export async function resumePipeline(run: PipelineRun): Promise<PipelineRun> {
  if (run.state !== 'paused') {
    throw new Error(`Cannot resume: pipeline is in '${run.state}', expected 'paused'`)
  }
  if (!run.pausedStage) {
    throw new Error('Cannot resume: no pausedStage recorded')
  }
  return await transition(run, run.pausedStage)
}

// ============================================================================
// Recovery
// ============================================================================

/**
 * Recover a pipeline stuck in 'error' state.
 *
 * Determines the recovery target (the last active stage from stageHistory),
 * validates the transition, clears the error, and transitions to that stage.
 * The stage will be re-run from scratch when the caller continues execution.
 */
export async function recoverPipeline(run: PipelineRun): Promise<PipelineRun> {
  if (run.state !== 'error') {
    throw new Error(`Cannot recover: pipeline is in '${run.state}', expected 'error'`)
  }

  const target = getRecoveryTarget(run)
  if (!target) {
    throw new Error('Cannot recover: unable to determine recovery target from stage history')
  }

  if (!isValidTransition('error', target, undefined, target)) {
    throw new Error(`Cannot recover: transition error → ${target} is not valid`)
  }

  // Clear error and transition to recovery target
  const now = new Date().toISOString()
  const recovered: PipelineRun = {
    ...run,
    state: target,
    currentStage: target,
    error: undefined,
    updatedAt: now,
  }
  await savePipelineRun(recovered)

  // Emit state-change event for real-time consumers (e.g. web dashboard)
  pipelineEvents.emitStateChange({
    pipelineId: recovered.id,
    from: 'error',
    to: target,
    updatedAt: now,
  })

  return recovered
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Load a pipeline and verify it exists.
 * Convenience for CLI commands that take a pipeline ID.
 */
export async function loadPipelineOrThrow(pipelineId: string): Promise<PipelineRun> {
  const run = await loadPipelineRun(pipelineId)
  if (!run) {
    throw new Error(`Pipeline not found: ${pipelineId}`)
  }
  return run
}

/**
 * Approve the current checkpoint (auto-detects which one).
 */
export async function approveCheckpoint(run: PipelineRun): Promise<PipelineRun> {
  if (run.state === 'checkpoint:arch') {
    return approveArchitectCheckpoint(run)
  }
  if (run.state === 'checkpoint:ship') {
    return approveShipCheckpoint(run)
  }
  throw new Error(`Cannot approve: pipeline is in '${run.state}', not at a checkpoint`)
}

/**
 * Reject the current checkpoint (auto-detects which one).
 */
export async function rejectCheckpoint(run: PipelineRun): Promise<PipelineRun> {
  if (run.state === 'checkpoint:arch') {
    return rejectArchitectCheckpoint(run)
  }
  if (run.state === 'checkpoint:ship') {
    return rejectShipCheckpoint(run)
  }
  throw new Error(`Cannot reject: pipeline is in '${run.state}', not at a checkpoint`)
}
