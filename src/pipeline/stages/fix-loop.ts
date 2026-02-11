/**
 * Fix Loop Stage
 *
 * On gate failure, delegates to the per-gate fixer which spawns one
 * focused fix agent per failed gate check, running sequentially in
 * priority order (test -> build -> lint -> code-review -> security ->
 * adversary -> ac-validator).
 *
 * After all per-gate fixes complete, increments the fix loop counter
 * and transitions back to 'gate' for re-evaluation. If max retries
 * are exceeded or all checks are skipped by the circuit breaker,
 * transitions to 'escalated'.
 */

import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { PipelineRun, StageResult } from '../types.js'
import { transition, recordStageResult, incrementFixLoop, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { appendProgress } from '../progress.js'
import { CircuitBreaker } from '../fix-loop/circuit-breaker.js'
import { savePipelineRun, loadPipelineRun } from '../pipeline-store.js'
import { EscalationManager } from '../escalation/escalation-manager.js'
import { runPerGateFixes } from '../fix-loop/per-gate-fixer.js'

// ============================================================================
// Types
// ============================================================================

export interface FixLoopOptions {
  /** Override model for the fix stage. */
  modelOverride?: string
  /** Override budget for the fix stage. */
  budgetOverride?: number
}

// ============================================================================
// Fix Loop Stage Runner
// ============================================================================

/**
 * Execute a single fix-loop iteration.
 *
 * Expects the pipeline to be in 'fix-loop' state with failed gateResults.
 * On success: transitions to 'gate' for re-evaluation.
 * On max retries exceeded: transitions to 'escalated'.
 * On all checks skipped (circuit breaker): transitions to 'escalated'.
 * On error: transitions to 'error'.
 */
export async function runFixLoopStage(
  run: PipelineRun,
  opts?: FixLoopOptions,
): Promise<PipelineRun> {
  const startedAt = new Date().toISOString()
  const maxFixLoops = run.config.maxFixLoops ?? 3

  try {
    // -----------------------------------------------------------------------
    // 1. Circuit breaker: check for repeated overall failure pattern
    // -----------------------------------------------------------------------
    const circuitBreaker = new CircuitBreaker(run.circuitBreakerState)
    const failureSignature = circuitBreaker.computeSignature(run.gateResults)

    if (circuitBreaker.isRepeatedFailure(failureSignature)) {
      await appendProgress(run.id, {
        type: 'info',
        stage: 'fix-loop',
        title: 'Circuit breaker triggered: repeated failure pattern detected',
        detail: failureSignature.description,
      }).catch(() => { /* best-effort */ })

      const escalationManager = new EscalationManager()
      await escalationManager.escalate(run.id, `Circuit breaker: ${failureSignature.description}`)

      run = (await loadPipelineRun(run.id))!
      run = await transition(run, 'escalated')
      return run
    }

    // Record this failure (increments count internally)
    const shouldEscalate = circuitBreaker.recordFailure(failureSignature)

    // Persist circuit breaker state
    const updatedRun: PipelineRun = {
      ...run,
      circuitBreakerState: circuitBreaker.getState(),
      updatedAt: new Date().toISOString(),
    }
    await savePipelineRun(updatedRun)
    run = updatedRun

    if (shouldEscalate) {
      await appendProgress(run.id, {
        type: 'info',
        stage: 'fix-loop',
        title: 'Circuit breaker triggered: escalating due to repeated failures',
        detail: failureSignature.description,
      }).catch(() => { /* best-effort */ })

      const escalationManager = new EscalationManager()
      await escalationManager.escalate(run.id, `Circuit breaker: ${failureSignature.description}`)

      run = (await loadPipelineRun(run.id))!
      run = await transition(run, 'escalated')
      return run
    }

    // -----------------------------------------------------------------------
    // 2. Max retries check
    // -----------------------------------------------------------------------
    if (run.fixLoopCount >= maxFixLoops) {
      const escalationManager = new EscalationManager()
      await escalationManager.escalate(run.id, `Max fix loops exceeded (${maxFixLoops})`)

      run = (await loadPipelineRun(run.id))!
      run = await transition(run, 'escalated')
      return run
    }

    // -----------------------------------------------------------------------
    // 3. Determine attempt number
    // -----------------------------------------------------------------------
    const attempt = run.fixLoopCount + 1

    // Emit progress for fix-loop iteration start
    await appendProgress(run.id, {
      type: 'fix-loop',
      stage: 'fix-loop',
      title: `Fix loop attempt ${attempt}/${maxFixLoops}`,
      data: { attempt, maxAttempts: maxFixLoops },
    }).catch(() => { /* best-effort */ })

    // -----------------------------------------------------------------------
    // 4. Get failed checks and run per-gate fixes
    // -----------------------------------------------------------------------
    const failed = run.gateResults.filter((r) => r.verdict === 'fail')

    const { fixedChecks, skippedChecks } = await runPerGateFixes(run, failed, {
      attempt,
      modelOverride: opts?.modelOverride,
      budgetOverride: opts?.budgetOverride,
    })

    // -----------------------------------------------------------------------
    // 5. If all checks were skipped (circuit breaker), escalate
    // -----------------------------------------------------------------------
    if (fixedChecks.length === 0) {
      await appendProgress(run.id, {
        type: 'info',
        stage: 'fix-loop',
        title: 'All failed checks skipped — escalating',
        detail: `Skipped: ${skippedChecks.join(', ')}`,
      }).catch(() => { /* best-effort */ })

      const escalationManager = new EscalationManager()
      await escalationManager.escalate(run.id, `All failed checks skipped by circuit breaker or fix errors: ${skippedChecks.join(', ')}`)

      run = (await loadPipelineRun(run.id))!
      run = await transition(run, 'escalated')
      return run
    }

    // -----------------------------------------------------------------------
    // 6. Increment fix loop counter
    // -----------------------------------------------------------------------
    run = await incrementFixLoop(run)

    // -----------------------------------------------------------------------
    // 7. Save fix loop artifacts
    // -----------------------------------------------------------------------
    const fixDir = join(getPipelineDir(run.id), 'fix-loops', `attempt-${attempt}`)
    await mkdir(fixDir, { recursive: true })

    const attemptMeta = {
      attempt,
      fixedChecks,
      skippedChecks,
      startedAt,
      completedAt: new Date().toISOString(),
    }

    await writeFile(
      join(fixDir, 'meta.json'),
      JSON.stringify(attemptMeta, null, 2),
      'utf-8',
    )

    // Emit progress for fix-loop completion
    await appendProgress(run.id, {
      type: 'fix-loop',
      stage: 'fix-loop',
      title: `Fix loop attempt ${attempt} completed`,
      detail: `Fixed: ${fixedChecks.join(', ')}${skippedChecks.length > 0 ? ` | Skipped: ${skippedChecks.join(', ')}` : ''}`,
      data: { attempt, fixedChecks, skippedChecks },
    }).catch(() => { /* best-effort */ })

    // -----------------------------------------------------------------------
    // 8. Record stage result and transition back to gate
    // -----------------------------------------------------------------------
    const completedAt = new Date().toISOString()
    const stageResult: StageResult = {
      stage: 'fix-loop',
      startedAt,
      completedAt,
      output: `Fix attempt ${attempt}: fixed [${fixedChecks.join(', ')}]${skippedChecks.length > 0 ? `, skipped [${skippedChecks.join(', ')}]` : ''}`,
    }
    run = await recordStageResult(run, stageResult)

    run = await transition(run, 'gate')

    return run
  } catch (err) {
    const errorMsg = `Fix loop error: ${(err as Error).message}`
    try {
      return await transitionToError(run, errorMsg)
    } catch {
      return { ...run, state: 'error', error: errorMsg }
    }
  }
}
