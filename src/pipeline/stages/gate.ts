/**
 * Gate Stage
 *
 * Runs gate agents in parallel and aggregates their verdicts:
 * - test-runner: Runs test command (shell, no AI)
 * - lint-runner: Runs lint on changed files (shell, no AI)
 * - ac-validator: Compares diff to ACs (AI session)
 * - adversary: Writes adversarial tests to expose bugs (AI session)
 * - security: Reviews diff for security vulnerabilities (AI session)
 * - code-review: Reviews diff for correctness and quality (AI session)
 *
 * Each agent produces a GateResult. The gate passes only if ALL
 * non-skipped agents pass. Results are written to:
 *   ~/.orcha/pipelines/{id}/gate-results/{checkName}.json
 *   ~/.orcha/pipelines/{id}/gate-results/verdict.json
 *
 * State transitions:
 * - All pass → checkpoint:ship
 * - Any fail → fix-loop (if fix loops remain) or escalated
 */

import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import type { PipelineRun, GateResult, StageResult } from '../types.js'
import { transition, recordStageResult, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { savePipelineRun } from '../pipeline-store.js'
import { runTestRunner } from '../gate-agents/test-runner.js'
import { runLintRunner } from '../gate-agents/lint-runner.js'
import { runAcValidator } from '../gate-agents/ac-validator.js'
import type { AcValidatorOptions } from '../gate-agents/ac-validator.js'
import { runAdversary } from '../gate-agents/adversary.js'
import { runSecurityReview } from '../gate-agents/security-review.js'
import { runCodeReview } from '../gate-agents/code-review.js'

// ============================================================================
// Types
// ============================================================================

export interface GateOptions {
  /** Override model for AI gate agents. */
  modelOverride?: string
  /** Override budget for AI gate agents. */
  budgetOverride?: number
}

export interface GateStageResult {
  /** Individual results from each gate agent. */
  results: GateResult[]
  /** Aggregated verdict. */
  passed: boolean
  /** Summary of the overall gate outcome. */
  summary: string
}

// ============================================================================
// Gate Stage Runner
// ============================================================================

/**
 * Execute the gate stage for a pipeline run.
 *
 * Expects the pipeline to be in 'gate' state.
 * On all-pass: transitions to 'checkpoint:ship'.
 * On any fail: transitions to 'fix-loop'.
 * On error: transitions to 'error'.
 */
export async function runGateStage(
  run: PipelineRun,
  opts?: GateOptions,
): Promise<PipelineRun> {
  const startedAt = new Date().toISOString()

  try {
    // Run all gate agents in parallel
    const agentOpts = {
      modelOverride: opts?.modelOverride,
      budgetOverride: opts?.budgetOverride,
    }

    const [testResult, lintResult, acResult, adversaryResult, securityResult, codeReviewResult] = await Promise.all([
      runTestRunner(run.worktreePath),
      runLintRunner(run.worktreePath, run.sourceBranch),
      runAcValidator(run, agentOpts),
      runAdversary(run, agentOpts),
      runSecurityReview(run, agentOpts),
      runCodeReview(run, agentOpts),
    ])

    const results: GateResult[] = [testResult, lintResult, acResult, adversaryResult, securityResult, codeReviewResult]

    // Save individual results to disk
    const gateResultsDir = join(getPipelineDir(run.id), 'gate-results')
    await mkdir(gateResultsDir, { recursive: true })

    await Promise.all(
      results.map((r) =>
        writeFile(
          join(gateResultsDir, `${r.checkName}.json`),
          JSON.stringify(r, null, 2),
          'utf-8',
        ),
      ),
    )

    // Aggregate verdict
    const gateOutcome = aggregateVerdicts(results)

    // Write aggregated verdict
    await writeFile(
      join(gateResultsDir, 'verdict.json'),
      JSON.stringify({
        passed: gateOutcome.passed,
        summary: gateOutcome.summary,
        results: results.map((r) => ({
          checkName: r.checkName,
          verdict: r.verdict,
          summary: r.summary,
        })),
        timestamp: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    )

    // Update gate results on the pipeline run
    run = {
      ...run,
      gateResults: results,
      updatedAt: new Date().toISOString(),
    }
    await savePipelineRun(run)

    // Record stage result
    const completedAt = new Date().toISOString()
    const stageResult: StageResult = {
      stage: 'gate',
      startedAt,
      completedAt,
      output: gateOutcome.summary,
    }
    run = await recordStageResult(run, stageResult)

    // Transition based on verdict
    if (gateOutcome.passed) {
      run = await transition(run, 'checkpoint:ship')
    } else {
      run = await transition(run, 'fix-loop')
    }

    return run
  } catch (err) {
    const errorMsg = `Gate stage error: ${(err as Error).message}`
    try {
      return await transitionToError(run, errorMsg)
    } catch {
      return { ...run, state: 'error', error: errorMsg }
    }
  }
}

// ============================================================================
// Verdict Aggregation
// ============================================================================

/**
 * Aggregate individual gate results into an overall pass/fail verdict.
 *
 * Rules:
 * - If ANY non-skipped result is 'fail', the gate fails.
 * - If ALL results are 'pass' or 'skip', the gate passes.
 * - 'skip' verdicts do not affect the outcome.
 */
function aggregateVerdicts(results: GateResult[]): { passed: boolean; summary: string } {
  const failures = results.filter((r) => r.verdict === 'fail')
  const passes = results.filter((r) => r.verdict === 'pass')
  const skips = results.filter((r) => r.verdict === 'skip')

  if (failures.length > 0) {
    const failNames = failures.map((f) => f.checkName).join(', ')
    return {
      passed: false,
      summary: `Gate FAILED: ${failures.length} check(s) failed (${failNames}). ${passes.length} passed, ${skips.length} skipped.`,
    }
  }

  return {
    passed: true,
    summary: `Gate PASSED: ${passes.length} check(s) passed, ${skips.length} skipped.`,
  }
}
