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
import { ACTIVE_STATES, SOFT_TERMINAL_STATES } from './types.js'
import { transition, executeArchitectStage, getRecoveryTarget, isValidTransition, transitionToError } from './pipeline-engine.js'
import { loadPipelineRun, savePipelineRun } from './pipeline-store.js'
import { pipelineEvents } from './events.js'
import { appendProgress } from './progress.js'
import { killPipelineProcesses } from './stage-runner.js'

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
  await appendProgress(run.id, {
    type: 'checkpoint',
    stage: 'checkpoint:arch',
    title: 'Architect blueprint approved',
  }).catch(() => { /* best-effort */ })
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
  await appendProgress(run.id, {
    type: 'checkpoint',
    stage: 'checkpoint:arch',
    title: 'Architect blueprint rejected',
  }).catch(() => { /* best-effort */ })
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

  await appendProgress(run.id, {
    type: 'checkpoint',
    stage: 'checkpoint:arch',
    title: 'Architect blueprint feedback — re-running architect',
    detail: feedback,
  }).catch(() => { /* best-effort */ })

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
  await appendProgress(run.id, {
    type: 'checkpoint',
    stage: 'checkpoint:ship',
    title: 'Ship checkpoint approved',
  }).catch(() => { /* best-effort */ })
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
  await appendProgress(run.id, {
    type: 'checkpoint',
    stage: 'checkpoint:ship',
    title: 'Ship checkpoint rejected',
  }).catch(() => { /* best-effort */ })
  return await transition(run, 'cancelled')
}

/**
 * Provide feedback on the ship checkpoint and re-run dev → gate → checkpoint:ship.
 *
 * Expects pipeline in 'checkpoint:ship' state.
 * Transitions checkpoint:ship → dev with reviewer feedback injected as context.
 * Resets fixLoopCount and increments reviewRounds.
 */
export async function feedbackShipCheckpoint(
  run: PipelineRun,
  feedback: string,
): Promise<PipelineRun> {
  if (run.state !== 'checkpoint:ship') {
    throw new Error(`Cannot give ship feedback: pipeline is in '${run.state}', expected 'checkpoint:ship'`)
  }

  await appendProgress(run.id, {
    type: 'checkpoint',
    stage: 'checkpoint:ship',
    title: 'Ship review feedback — re-running dev',
    detail: feedback,
  }).catch(() => { /* best-effort */ })

  // Reset fix loop count and increment review rounds
  const updated: PipelineRun = {
    ...run,
    fixLoopCount: 0,
    reviewRounds: (run.reviewRounds ?? 0) + 1,
    userInstructions: feedback,
    updatedAt: new Date().toISOString(),
  }
  await savePipelineRun(updated)

  // Transition checkpoint:ship → dev
  return await transition(updated, 'dev')
}

/**
 * Submit post-ship review points to re-open a completed pipeline.
 *
 * Expects pipeline in 'completed' state.
 * Transitions completed → dev with review comments injected as context.
 * Resets fixLoopCount and increments reviewRounds.
 */
export async function submitReviewPoints(
  run: PipelineRun,
  reviewPoints: string,
): Promise<PipelineRun> {
  if (run.state !== 'completed') {
    throw new Error(`Cannot submit review points: pipeline is in '${run.state}', expected 'completed'`)
  }

  await appendProgress(run.id, {
    type: 'checkpoint',
    stage: 'completed',
    title: 'PR review points received — re-running dev',
    detail: reviewPoints,
  }).catch(() => { /* best-effort */ })

  // Reset fix loop count and increment review rounds
  const updated: PipelineRun = {
    ...run,
    fixLoopCount: 0,
    reviewRounds: (run.reviewRounds ?? 0) + 1,
    userInstructions: reviewPoints,
    updatedAt: new Date().toISOString(),
  }
  await savePipelineRun(updated)

  // Transition completed → dev
  return await transition(updated, 'dev')
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
  await appendProgress(run.id, {
    type: 'info',
    stage: run.state,
    title: `Pipeline paused (was in ${run.state})`,
  }).catch(() => { /* best-effort */ })
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
  await appendProgress(run.id, {
    type: 'info',
    stage: run.pausedStage,
    title: `Pipeline resumed (returning to ${run.pausedStage})`,
  }).catch(() => { /* best-effort */ })
  return await transition(run, run.pausedStage)
}

// ============================================================================
// Stop (user-initiated kill)
// ============================================================================

/**
 * Stop a running pipeline by killing its subprocess(es) and transitioning to error.
 *
 * The existing "Retry" button (which calls recoverPipeline) handles resume after stop.
 */
export async function stopPipeline(run: PipelineRun): Promise<PipelineRun> {
  if (!ACTIVE_STATES.has(run.state)) {
    throw new Error(`Cannot stop: pipeline is in '${run.state}', expected an active state`)
  }

  // Kill subprocess(es) — may be a no-op if nothing is running (e.g. checkpoint states)
  killPipelineProcesses(run.id)

  await appendProgress(run.id, {
    type: 'info',
    stage: run.state,
    title: 'Pipeline stopped by user',
  }).catch(() => { /* best-effort */ })

  return await transitionToError(run, 'Stopped by user')
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

  await appendProgress(run.id, {
    type: 'info',
    stage: target,
    title: `Pipeline recovered (re-entering ${target})`,
  }).catch(() => { /* best-effort */ })

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
// Retry Escalated
// ============================================================================

export interface RetryEscalatedOptions {
  /** Additional fix-loop attempts to add (default: 3). */
  additionalRetries?: number
  /** Gate check names to skip on retry (e.g. ['lint', 'security']). */
  skipChecks?: string[]
  /** Extra instructions for the fix-loop agent. */
  instructions?: string
}

/**
 * Retry a pipeline stuck in 'escalated' state.
 *
 * Bumps maxFixLoops, optionally stores skipChecks and userInstructions,
 * and transitions back to 'fix-loop' for another round of fixes.
 */
export async function retryEscalatedPipeline(
  run: PipelineRun,
  opts?: RetryEscalatedOptions,
): Promise<PipelineRun> {
  if (run.state !== 'escalated') {
    throw new Error(`Cannot retry: pipeline is in '${run.state}', expected 'escalated'`)
  }

  const additionalRetries = opts?.additionalRetries ?? 3

  // Bump maxFixLoops so fix-loop won't immediately re-escalate
  const currentMax = run.config.maxFixLoops ?? 3
  const newMax = currentMax + additionalRetries
  const updatedConfig = { ...run.config, maxFixLoops: newMax }

  // Store skip checks and user instructions on the run
  const now = new Date().toISOString()
  // Preserve gateResults so the fix agent knows what failed.
  // Clearing them would leave the fix agent blind to gate failures.
  let updated: PipelineRun = {
    ...run,
    config: updatedConfig,
    skipChecks: opts?.skipChecks?.length ? opts.skipChecks : run.skipChecks,
    userInstructions: opts?.instructions || run.userInstructions,
    updatedAt: now,
  }
  await savePipelineRun(updated)

  await appendProgress(updated.id, {
    type: 'info',
    stage: 'fix-loop',
    title: `Escalated pipeline retried — ${additionalRetries} more fix loops (max now ${newMax})`,
    detail: [
      opts?.skipChecks?.length ? `Skipping checks: ${opts.skipChecks.join(', ')}` : '',
      opts?.instructions ? `Instructions: ${opts.instructions.slice(0, 200)}` : '',
    ].filter(Boolean).join('. ') || undefined,
  }).catch(() => { /* best-effort */ })

  // Transition escalated → fix-loop
  updated = await transition(updated, 'fix-loop')

  return updated
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
