/**
 * Fix Loop Stage
 *
 * On gate failure, delegates to the per-gate fixer which spawns one
 * focused fix agent per failed gate check, running sequentially in
 * priority order (test -> build -> lint -> code-review -> security ->
 * adversary -> ac-validator).
 *
 * The per-check circuit breaker tracks each check independently:
 * if a check fails with the same output pattern twice, its fix is
 * skipped and escalated — but other checks' fixes still run.
 *
 * After all per-gate fixes complete, increments the fix loop counter
 * and transitions back to 'gate' for re-evaluation. If max retries
 * are exceeded or all checks are circuit-broken, transitions to 'escalated'.
 */

import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { PipelineRun, StageResult } from '../types.js'
import { transition, recordStageResult, incrementFixLoop, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { appendProgress } from '../progress.js'
import { PerCheckCircuitBreaker } from '../fix-loop/circuit-breaker.js'
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
    // 1. Max retries check
    // -----------------------------------------------------------------------
    if (run.fixLoopCount >= maxFixLoops) {
      const escalationManager = new EscalationManager()
      await escalationManager.escalate(run.id, `Max fix loops exceeded (${maxFixLoops})`)

      run = (await loadPipelineRun(run.id))!
      run = await transition(run, 'escalated')
      return run
    }

    // -----------------------------------------------------------------------
    // 2. Determine attempt number
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
    // 3. Initialize per-check circuit breaker from persisted state
    // -----------------------------------------------------------------------
    const circuitBreaker = new PerCheckCircuitBreaker(run.circuitBreakerState)

    // -----------------------------------------------------------------------
    // 4. Get failed checks and run per-gate fixes
    // -----------------------------------------------------------------------
    const failed = run.gateResults.filter((r) => r.verdict === 'fail')

    const { fixedChecks, skippedChecks, circuitBrokenChecks } = await runPerGateFixes(run, failed, {
      attempt,
      modelOverride: opts?.modelOverride,
      budgetOverride: opts?.budgetOverride,
      circuitBreaker,
    })

    // -----------------------------------------------------------------------
    // 5. Persist circuit breaker state after per-gate fixes
    // -----------------------------------------------------------------------
    const updatedRun: PipelineRun = {
      ...run,
      circuitBreakerState: circuitBreaker.getState(),
      updatedAt: new Date().toISOString(),
    }
    await savePipelineRun(updatedRun)
    run = updatedRun

    // -----------------------------------------------------------------------
    // 6. If ALL checks are circuit-broken, escalate (no point retrying)
    //    If checks just failed (exit code 1), still go to gate — the agent
    //    may have made partial fixes even when exiting non-zero.
    // -----------------------------------------------------------------------
    if (fixedChecks.length === 0 && circuitBrokenChecks.length === failed.length) {
      const reason = `Circuit breaker: all failed checks have repeated failure patterns (${circuitBrokenChecks.join(', ')})`

      await appendProgress(run.id, {
        type: 'info',
        stage: 'fix-loop',
        title: 'All checks circuit-broken — escalating',
        detail: `Circuit-broken: ${circuitBrokenChecks.join(', ')}`,
      }).catch(() => { /* best-effort */ })

      const escalationManager = new EscalationManager()
      await escalationManager.escalate(run.id, reason)

      run = (await loadPipelineRun(run.id))!
      run = await transition(run, 'escalated')
      return run
    }

    if (fixedChecks.length === 0) {
      // Fix agents ran but none succeeded — still go to gate.
      // The agents may have made partial progress.
      await appendProgress(run.id, {
        type: 'info',
        stage: 'fix-loop',
        title: `Fix agents exited non-zero — retrying via gate`,
        detail: `Skipped: ${skippedChecks.join(', ')}`,
      }).catch(() => { /* best-effort */ })
    }

    // -----------------------------------------------------------------------
    // 7. Increment fix loop counter
    // -----------------------------------------------------------------------
    run = await incrementFixLoop(run)

    // -----------------------------------------------------------------------
    // 8. Save fix loop artifacts
    // -----------------------------------------------------------------------
    const fixDir = join(getPipelineDir(run.id), 'fix-loops', `attempt-${attempt}`)
    await mkdir(fixDir, { recursive: true })

    const attemptMeta = {
      attempt,
      fixedChecks,
      skippedChecks,
      circuitBrokenChecks,
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
      data: { attempt, fixedChecks, skippedChecks, circuitBrokenChecks },
    }).catch(() => { /* best-effort */ })

    // -----------------------------------------------------------------------
    // 9. Record stage result and transition back to gate
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
