/**
 * Pipeline Engine — State Machine
 *
 * Owns the transition table and validates every state change.
 * No stage execution logic lives here — this is purely the skeleton
 * state machine that future milestones will drive.
 *
 * Transition table (from the architecture doc):
 *
 *   created        -> architect
 *   architect      -> checkpoint:arch
 *   checkpoint:arch -> dev | cancelled | architect   (approve / reject / feedback)
 *   dev            -> gate
 *   gate           -> fix-loop | checkpoint:ship
 *   fix-loop       -> gate | escalated
 *   checkpoint:ship -> ship | cancelled
 *   ship           -> completed
 *
 *   Any ACTIVE state -> paused             (via orcha stop)
 *   paused          -> (previous active)   (via resume)
 *   Any state        -> error              (on unrecoverable failure)
 */

import type { PipelineRun, PipelineState, PipelineConfig, StageResult } from './types.js'
import { ACTIVE_STATES, TERMINAL_STATES } from './types.js'
import { savePipelineRun, generatePipelineId } from './pipeline-store.js'
import { runArchitectStage } from './stages/architect.js'
import type { ArchitectOptions } from './stages/architect.js'
import { runDevStage } from './stages/dev.js'
import type { DevOptions } from './stages/dev.js'
import { runGateStage } from './stages/gate.js'
import type { GateOptions } from './stages/gate.js'
import { runFixLoopStage } from './stages/fix-loop.js'
import type { FixLoopOptions } from './stages/fix-loop.js'
import { runShipStage } from './stages/ship.js'
import type { ShipOptions } from './stages/ship.js'

// ============================================================================
// Transition Table
// ============================================================================

/**
 * Map from a source state to the set of states it can transition to.
 * "paused" and "error" are handled as special cases (see below).
 */
const TRANSITION_TABLE: ReadonlyMap<PipelineState, ReadonlySet<PipelineState>> = new Map([
  ['created', new Set<PipelineState>(['architect'])],
  ['architect', new Set<PipelineState>(['checkpoint:arch'])],
  ['checkpoint:arch', new Set<PipelineState>(['dev', 'cancelled', 'architect'])],
  ['dev', new Set<PipelineState>(['gate'])],
  ['gate', new Set<PipelineState>(['fix-loop', 'checkpoint:ship'])],
  ['fix-loop', new Set<PipelineState>(['gate', 'escalated'])],
  ['checkpoint:ship', new Set<PipelineState>(['ship', 'cancelled'])],
  ['ship', new Set<PipelineState>(['completed'])],
])

// ============================================================================
// Validation
// ============================================================================

export class InvalidTransitionError extends Error {
  constructor(
    public readonly from: PipelineState,
    public readonly to: PipelineState,
    message?: string,
  ) {
    super(message ?? `Invalid pipeline transition: ${from} -> ${to}`)
    this.name = 'InvalidTransitionError'
  }
}

/**
 * Check whether a transition from `from` to `to` is valid.
 *
 * Special rules:
 * - Any ACTIVE state can transition to "paused".
 * - "paused" can transition back to its saved `pausedStage` only.
 * - Any non-terminal state can transition to "error".
 * - Terminal states (completed, cancelled, escalated) cannot transition anywhere.
 */
export function isValidTransition(
  from: PipelineState,
  to: PipelineState,
  pausedStage?: PipelineState,
): boolean {
  // Cannot leave terminal states.
  if (TERMINAL_STATES.has(from)) {
    return false
  }

  // Any non-terminal state -> error
  if (to === 'error') {
    return true
  }

  // Any active state -> paused
  if (to === 'paused' && ACTIVE_STATES.has(from)) {
    return true
  }

  // paused -> previous active state (resume)
  if (from === 'paused') {
    if (pausedStage && to === pausedStage) {
      return true
    }
    return false
  }

  // error -> nowhere (error is terminal-like unless we add recovery later)
  if (from === 'error') {
    return false
  }

  // Check the explicit transition table.
  const allowed = TRANSITION_TABLE.get(from)
  return allowed?.has(to) ?? false
}

/**
 * Assert a transition is valid, throwing InvalidTransitionError if not.
 */
export function assertValidTransition(
  from: PipelineState,
  to: PipelineState,
  pausedStage?: PipelineState,
): void {
  if (!isValidTransition(from, to, pausedStage)) {
    throw new InvalidTransitionError(from, to)
  }
}

// ============================================================================
// State Machine Operations
// ============================================================================

/**
 * Transition a pipeline run to a new state, persisting the change.
 *
 * Returns the updated PipelineRun (the input object is not mutated).
 * Throws InvalidTransitionError if the transition is not allowed.
 */
export async function transition(
  run: PipelineRun,
  to: PipelineState,
): Promise<PipelineRun> {
  assertValidTransition(run.state, to, run.pausedStage)

  const now = new Date().toISOString()
  let updated: PipelineRun = { ...run, updatedAt: now }

  // --- Handle pause ---
  if (to === 'paused') {
    updated = {
      ...updated,
      state: 'paused',
      pausedAt: now,
      pausedStage: run.state,
      currentStage: null,
    }
  }
  // --- Handle resume from paused ---
  else if (run.state === 'paused') {
    updated = {
      ...updated,
      state: to,
      pausedAt: undefined,
      pausedStage: undefined,
      currentStage: to,
    }
  }
  // --- Handle terminal / error ---
  else if (TERMINAL_STATES.has(to) || to === 'error') {
    updated = {
      ...updated,
      state: to,
      currentStage: null,
    }
  }
  // --- Normal forward transition ---
  else {
    updated = {
      ...updated,
      state: to,
      currentStage: to,
    }
  }

  await savePipelineRun(updated)
  return updated
}

/**
 * Record a completed stage result and persist.
 * This does NOT change the pipeline state -- call `transition()` for that.
 */
export async function recordStageResult(
  run: PipelineRun,
  result: StageResult,
): Promise<PipelineRun> {
  const updated: PipelineRun = {
    ...run,
    stageHistory: [...run.stageHistory, result],
    updatedAt: new Date().toISOString(),
  }
  await savePipelineRun(updated)
  return updated
}

/**
 * Increment the fix-loop counter and persist.
 */
export async function incrementFixLoop(run: PipelineRun): Promise<PipelineRun> {
  const updated: PipelineRun = {
    ...run,
    fixLoopCount: run.fixLoopCount + 1,
    updatedAt: new Date().toISOString(),
  }
  await savePipelineRun(updated)
  return updated
}

/**
 * Set an error message on the pipeline (typically used alongside transition to 'error').
 */
export async function setError(
  run: PipelineRun,
  errorMessage: string,
): Promise<PipelineRun> {
  const updated: PipelineRun = {
    ...run,
    error: errorMessage,
    updatedAt: new Date().toISOString(),
  }
  await savePipelineRun(updated)
  return updated
}

/**
 * Convenience: transition to 'error' and record the error message in one step.
 */
export async function transitionToError(
  run: PipelineRun,
  errorMessage: string,
): Promise<PipelineRun> {
  assertValidTransition(run.state, 'error', run.pausedStage)

  const now = new Date().toISOString()
  const updated: PipelineRun = {
    ...run,
    state: 'error',
    currentStage: null,
    error: errorMessage,
    updatedAt: now,
  }
  await savePipelineRun(updated)
  return updated
}

/**
 * Return all states reachable from the current state (useful for UI hints).
 */
export function getAvailableTransitions(
  run: PipelineRun,
): PipelineState[] {
  const { state, pausedStage } = run
  const result: PipelineState[] = []

  // Check each possible target state.
  const allStates: PipelineState[] = [
    'created', 'architect', 'checkpoint:arch', 'dev', 'gate',
    'fix-loop', 'checkpoint:ship', 'ship', 'completed',
    'cancelled', 'escalated', 'paused', 'error',
  ]

  for (const target of allStates) {
    if (target === state) continue
    if (isValidTransition(state, target, pausedStage)) {
      result.push(target)
    }
  }
  return result
}

// ============================================================================
// Pipeline Run Factory
// ============================================================================

export interface CreatePipelineRunOptions {
  config: PipelineConfig
  description: string
  acceptanceCriteria: string[]
  sourceBranch: string
  worktreePath: string
  workItemId?: string
}

/**
 * Create a new PipelineRun in the 'created' state and persist it.
 */
export async function createPipelineRun(
  opts: CreatePipelineRunOptions,
): Promise<PipelineRun> {
  const now = new Date().toISOString()
  const run: PipelineRun = {
    id: generatePipelineId(),
    state: 'created',
    config: opts.config,
    workItemId: opts.workItemId,
    description: opts.description,
    acceptanceCriteria: opts.acceptanceCriteria,
    sourceBranch: opts.sourceBranch,
    worktreePath: opts.worktreePath,
    stageHistory: [],
    currentStage: null,
    gateResults: [],
    fixLoopCount: 0,
    createdAt: now,
    updatedAt: now,
  }
  await savePipelineRun(run)
  return run
}

// ============================================================================
// Architect Stage Orchestration
// ============================================================================

/**
 * Transition from 'created' to 'architect' and execute the architect stage.
 *
 * Returns the updated PipelineRun (which will be in 'checkpoint:arch' on
 * success, or 'error' on failure).
 */
export async function executeArchitectStage(
  run: PipelineRun,
  opts?: ArchitectOptions,
): Promise<PipelineRun> {
  // Transition: created -> architect
  run = await transition(run, 'architect')

  // Run the architect stage (handles checkpoint:arch transition internally)
  run = await runArchitectStage(run, opts)

  return run
}

// ============================================================================
// Dev Stage Orchestration
// ============================================================================

/**
 * Transition from 'checkpoint:arch' to 'dev' and execute the dev stage.
 *
 * Expects the pipeline to be in 'checkpoint:arch' (i.e. architect approved).
 * Returns the updated PipelineRun (which will be in 'gate' on success,
 * or 'error' on failure).
 */
export async function executeDevStage(
  run: PipelineRun,
  opts?: DevOptions,
): Promise<PipelineRun> {
  // Transition: checkpoint:arch -> dev
  run = await transition(run, 'dev')

  // Run the dev stage (handles gate transition internally)
  run = await runDevStage(run, opts)

  return run
}

// ============================================================================
// Gate Stage Orchestration
// ============================================================================

/**
 * Execute the gate stage (runs immediately after dev completes).
 *
 * Expects the pipeline to already be in 'gate' state (the dev stage
 * transitions to 'gate' on completion). Returns the updated PipelineRun
 * (which will be in 'checkpoint:ship' if gate passes, 'fix-loop' if
 * it fails, or 'error' on unrecoverable failure).
 */
export async function executeGateStage(
  run: PipelineRun,
  opts?: GateOptions,
): Promise<PipelineRun> {
  // The pipeline should already be in 'gate' state (set by dev stage).
  // Run the gate stage (handles checkpoint:ship / fix-loop transition internally)
  run = await runGateStage(run, opts)

  return run
}

// ============================================================================
// Fix Loop Orchestration
// ============================================================================

/**
 * Execute a fix-loop iteration: fix the code, then re-run gate.
 *
 * Expects the pipeline to be in 'fix-loop' state.
 * The fix stage handles:
 * - Checking if max retries exceeded → escalated
 * - Running the fix agent
 * - Auto-committing
 * - Transitioning to 'gate' for re-evaluation
 *
 * After fix completes (if it transitions to 'gate'), this method
 * automatically re-runs the gate stage.
 */
export async function executeFixLoopStage(
  run: PipelineRun,
  fixOpts?: FixLoopOptions,
  gateOpts?: GateOptions,
): Promise<PipelineRun> {
  // Run the fix loop (handles gate/escalated transition internally)
  run = await runFixLoopStage(run, fixOpts)

  // If fix loop transitioned to gate, run gate automatically
  if (run.state === 'gate') {
    run = await executeGateStage(run, gateOpts)
  }

  return run
}

// ============================================================================
// Ship Stage Orchestration
// ============================================================================

/**
 * Execute the ship stage: push branch and create PR.
 *
 * Expects the pipeline to be in 'ship' state (after checkpoint:ship approval).
 * Returns the updated PipelineRun (which will be in 'completed' on success,
 * or 'error' on failure).
 */
export async function executeShipStage(
  run: PipelineRun,
  opts?: ShipOptions,
): Promise<PipelineRun> {
  // The pipeline should already be in 'ship' state (set by checkpoint approval).
  // Run the ship stage (handles completed transition internally)
  run = await runShipStage(run, opts)

  return run
}
