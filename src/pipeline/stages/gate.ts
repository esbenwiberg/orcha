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
 * Competing mode:
 * When competingResults are present on the pipeline run, the gate runs
 * on each competing agent's worktree, scores them, and selects the best.
 * The winner's worktree becomes the pipeline worktree, losers are cleaned up.
 *
 * State transitions:
 * - All pass → checkpoint:ship
 * - Any fail → fix-loop (if fix loops remain) or escalated
 */

import { writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { execAsync } from '../exec-utils.js'
import type { PipelineRun, GateResult, StageResult, CompetingResult, Severity } from '../types.js'
import { transition, recordStageResult, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { savePipelineRun } from '../pipeline-store.js'
import { detectTechStacks } from '../tech-scanner.js'
import { runTestRunner } from '../gate-agents/test-runner.js'
import { runLintRunner } from '../gate-agents/lint-runner.js'
import { runBuildRunner } from '../gate-agents/build-runner.js'
import { runAcValidator } from '../gate-agents/ac-validator.js'
import { runAdversary } from '../gate-agents/adversary.js'
import { runSecurityReview } from '../gate-agents/security-review.js'
import { runCodeReview } from '../gate-agents/code-review.js'
import { appendProgress } from '../progress.js'

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
 *
 * In competing mode, runs gate on all competitors and selects the best.
 */
export async function runGateStage(
  run: PipelineRun,
  opts?: GateOptions,
): Promise<PipelineRun> {
  // Check if we're in competing mode
  const competitors = run.competingResults?.filter((r) => r.commitSha !== '')
  if (competitors && competitors.length > 1) {
    return runCompetingGateStage(run, competitors, opts)
  }

  return runSingleGateStage(run, opts)
}

// ============================================================================
// Single Gate (standard mode)
// ============================================================================

async function runSingleGateStage(
  run: PipelineRun,
  opts?: GateOptions,
): Promise<PipelineRun> {
  const startedAt = new Date().toISOString()

  try {
    // Detect tech stacks for multi-tech runners
    const techStacks = detectTechStacks(run.worktreePath)

    // Run all gate agents in parallel (respecting skipChecks)
    const agentOpts = {
      modelOverride: opts?.modelOverride,
      budgetOverride: opts?.budgetOverride,
      techStacks,
    }
    const skip = new Set(run.skipChecks ?? [])

    const [testResult, lintResult, buildResult, acResult, adversaryResult, securityResult, codeReviewResult] = await Promise.all([
      skip.has('test') ? makeSkippedResult('test') : runTestRunner(run.worktreePath, techStacks, run.dependencyFailures),
      skip.has('lint') ? makeSkippedResult('lint') : runLintRunner(run.worktreePath, run.sourceBranch, run.baseCommit, techStacks, run.dependencyFailures),
      skip.has('build') ? makeSkippedResult('build') : runBuildRunner(run.worktreePath, techStacks, run.dependencyFailures),
      skip.has('ac-validator') ? makeSkippedResult('ac-validator') : runAcValidator(run, agentOpts),
      skip.has('adversary') ? makeSkippedResult('adversary') : runAdversary(run, agentOpts),
      skip.has('security') ? makeSkippedResult('security') : runSecurityReview(run, agentOpts),
      skip.has('code-review') ? makeSkippedResult('code-review') : runCodeReview(run, agentOpts),
    ])

    const results: GateResult[] = [testResult, lintResult, buildResult, acResult, adversaryResult, securityResult, codeReviewResult]

    // Save individual results to disk (before filtering)
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

    // Apply severity filtering
    const severityThreshold = run.config.severityThreshold ?? 'critical'
    const filteredResults = filterBySeverity(results, severityThreshold)

    // Aggregate verdict (on filtered results)
    const gateOutcome = aggregateVerdicts(filteredResults)

    // Write aggregated verdict
    await writeFile(
      join(gateResultsDir, 'verdict.json'),
      JSON.stringify({
        passed: gateOutcome.passed,
        summary: gateOutcome.summary,
        severityThreshold,
        results: filteredResults.map((r) => ({
          checkName: r.checkName,
          verdict: r.verdict,
          summary: r.summary,
        })),
        timestamp: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    )

    // Emit progress for gate result
    await appendProgress(run.id, {
      type: 'gate-result',
      stage: 'gate',
      title: gateOutcome.passed ? 'Gate PASSED' : 'Gate FAILED',
      detail: gateOutcome.summary,
      data: {
        passed: gateOutcome.passed,
        severityThreshold,
        results: filteredResults.map((r) => ({
          checkName: r.checkName,
          verdict: r.verdict,
          summary: r.summary,
        })),
      },
    }).catch(() => { /* best-effort */ })

    // Update gate results on the pipeline run (store filtered results)
    run = {
      ...run,
      gateResults: filteredResults,
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
      // Clear retry hints — they were one-shot for the fix-loop cycle
      if (run.skipChecks || run.userInstructions) {
        run = { ...run, skipChecks: undefined, userInstructions: undefined }
        await savePipelineRun(run)
      }
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
// Competing Gate — evaluate all competitors and pick the best
// ============================================================================

async function runCompetingGateStage(
  run: PipelineRun,
  competitors: CompetingResult[],
  opts?: GateOptions,
): Promise<PipelineRun> {
  const startedAt = new Date().toISOString()

  try {
    // Run gate on each competitor in parallel
    const evaluations = await Promise.all(
      competitors.map((competitor) => evaluateCompetitor(run, competitor, opts)),
    )

    // Score each competitor: count of passed checks
    for (const evaluation of evaluations) {
      const competitor = competitors.find((c) => c.agentIndex === evaluation.agentIndex)
      if (competitor) {
        competitor.gateScore = evaluation.score
        competitor.gateResults = evaluation.results
      }
    }

    // Save per-competitor gate results
    const gateResultsDir = join(getPipelineDir(run.id), 'gate-results')
    await mkdir(gateResultsDir, { recursive: true })

    for (const evaluation of evaluations) {
      const competitorDir = join(gateResultsDir, `competitor-${evaluation.agentIndex}`)
      await mkdir(competitorDir, { recursive: true })

      await Promise.all(
        evaluation.results.map((r) =>
          writeFile(
            join(competitorDir, `${r.checkName}.json`),
            JSON.stringify(r, null, 2),
            'utf-8',
          ),
        ),
      )

      await writeFile(
        join(competitorDir, 'verdict.json'),
        JSON.stringify({
          agentIndex: evaluation.agentIndex,
          passed: evaluation.passed,
          score: evaluation.score,
          summary: evaluation.summary,
          results: evaluation.results.map((r) => ({
            checkName: r.checkName,
            verdict: r.verdict,
            summary: r.summary,
          })),
          timestamp: new Date().toISOString(),
        }, null, 2),
        'utf-8',
      )
    }

    // Select winner: highest score, among those with all-pass; fallback to highest score overall
    const sortedByScore = [...evaluations].sort((a, b) => b.score - a.score)
    const passingEvals = sortedByScore.filter((e) => e.passed)
    const winner = passingEvals[0] ?? sortedByScore[0]

    // Mark winner in competing results
    const updatedCompetingResults = competitors.map((c) => ({
      ...c,
      winner: c.agentIndex === winner.agentIndex,
    }))

    // Update the pipeline run's worktree to the winner's worktree
    const winnerCompetitor = competitors.find((c) => c.agentIndex === winner.agentIndex)!

    // Write overall verdict
    const severityThreshold = run.config.severityThreshold ?? 'critical'
    await writeFile(
      join(gateResultsDir, 'verdict.json'),
      JSON.stringify({
        competing: true,
        severityThreshold,
        winnerAgent: winner.agentIndex,
        winnerScore: winner.score,
        winnerPassed: winner.passed,
        evaluations: evaluations.map((e) => ({
          agentIndex: e.agentIndex,
          score: e.score,
          passed: e.passed,
          summary: e.summary,
        })),
        timestamp: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    )

    // Emit progress for competing gate result
    await appendProgress(run.id, {
      type: 'gate-result',
      stage: 'gate',
      title: `Competing gate: agent #${winner.agentIndex} won (score ${winner.score}/${winner.results.length})`,
      detail: winner.passed ? 'Winner PASSED all checks' : 'Winner did NOT pass all checks',
      data: {
        competing: true,
        winnerAgent: winner.agentIndex,
        winnerScore: winner.score,
        winnerPassed: winner.passed,
        evaluations: evaluations.map((e) => ({
          agentIndex: e.agentIndex,
          score: e.score,
          passed: e.passed,
        })),
      },
    }).catch(() => { /* best-effort */ })

    // Update pipeline run with gate results from winner and competing results
    run = {
      ...run,
      worktreePath: winnerCompetitor.worktreePath,
      gateResults: winner.results,
      competingResults: updatedCompetingResults,
      updatedAt: new Date().toISOString(),
    }
    await savePipelineRun(run)

    // Clean up losing worktrees
    await cleanupLosingWorktrees(run, updatedCompetingResults)

    // Record stage result
    const completedAt = new Date().toISOString()
    const stageResult: StageResult = {
      stage: 'gate',
      startedAt,
      completedAt,
      output: `Competing gate: agent #${winner.agentIndex} won (score ${winner.score}/${winner.results.length}). ${winner.passed ? 'PASSED' : 'FAILED'}`,
    }
    run = await recordStageResult(run, stageResult)

    // Transition based on winner's verdict
    if (winner.passed) {
      run = await transition(run, 'checkpoint:ship')
    } else {
      run = await transition(run, 'fix-loop')
    }

    return run
  } catch (err) {
    const errorMsg = `Competing gate stage error: ${(err as Error).message}`
    try {
      return await transitionToError(run, errorMsg)
    } catch {
      return { ...run, state: 'error', error: errorMsg }
    }
  }
}

interface CompetitorEvaluation {
  agentIndex: number
  results: GateResult[]
  passed: boolean
  score: number
  summary: string
}

/**
 * Run all gate agents against a single competitor's worktree.
 */
async function evaluateCompetitor(
  run: PipelineRun,
  competitor: CompetingResult,
  opts?: GateOptions,
): Promise<CompetitorEvaluation> {
  // Detect tech stacks for competitor's worktree
  const techStacks = detectTechStacks(competitor.worktreePath)

  const agentOpts = {
    modelOverride: opts?.modelOverride,
    budgetOverride: opts?.budgetOverride,
    techStacks,
  }

  // Create a temporary PipelineRun pointing to competitor's worktree
  const competitorRun: PipelineRun = {
    ...run,
    worktreePath: competitor.worktreePath,
  }
  const skip = new Set(run.skipChecks ?? [])

  const [testResult, lintResult, buildResult, acResult, adversaryResult, securityResult, codeReviewResult] = await Promise.all([
    skip.has('test') ? makeSkippedResult('test') : runTestRunner(competitor.worktreePath, techStacks, run.dependencyFailures),
    skip.has('lint') ? makeSkippedResult('lint') : runLintRunner(competitor.worktreePath, run.sourceBranch, run.baseCommit, techStacks, run.dependencyFailures),
    skip.has('build') ? makeSkippedResult('build') : runBuildRunner(competitor.worktreePath, techStacks, run.dependencyFailures),
    skip.has('ac-validator') ? makeSkippedResult('ac-validator') : runAcValidator(competitorRun, agentOpts),
    skip.has('adversary') ? makeSkippedResult('adversary') : runAdversary(competitorRun, agentOpts),
    skip.has('security') ? makeSkippedResult('security') : runSecurityReview(competitorRun, agentOpts),
    skip.has('code-review') ? makeSkippedResult('code-review') : runCodeReview(competitorRun, agentOpts),
  ])

  const results: GateResult[] = [testResult, lintResult, buildResult, acResult, adversaryResult, securityResult, codeReviewResult]

  // Apply severity filtering
  const severityThreshold = run.config.severityThreshold ?? 'critical'
  const filteredResults = filterBySeverity(results, severityThreshold)

  const { passed, summary } = aggregateVerdicts(filteredResults)
  const score = filteredResults.filter((r) => r.verdict === 'pass').length

  return { agentIndex: competitor.agentIndex, results: filteredResults, passed, score, summary }
}

/**
 * Remove worktrees for losing competitors.
 */
async function cleanupLosingWorktrees(
  run: PipelineRun,
  competingResults: CompetingResult[],
): Promise<void> {
  const losers = competingResults.filter((c) => !c.winner && c.worktreePath)
  for (const loser of losers) {
    try {
      await execAsync(`git worktree remove --force "${loser.worktreePath}"`, {
        cwd: run.worktreePath,
        timeout: 15000,
      })
    } catch {
      // Best effort cleanup — worktree may already be gone
    }
  }
}

// ============================================================================
// Skip Checks Helper
// ============================================================================

/**
 * Create a skipped GateResult for a check the user chose to bypass.
 */
function makeSkippedResult(checkName: string): GateResult {
  return {
    verdict: 'skip',
    checkName,
    summary: `Skipped by user override`,
    findings: [],
    rawOutput: '',
    timestamp: new Date().toISOString(),
  }
}

/**
 * Gate check name mapping (friendly name → agent function key).
 */
const GATE_CHECK_NAMES = ['test', 'lint', 'build', 'ac-validator', 'adversary', 'security', 'code-review'] as const

// ============================================================================
// Severity Filtering
// ============================================================================

/**
 * Severity ranking for filtering (lower is more severe).
 */
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
}

/**
 * Filter gate results by severity threshold.
 *
 * For security and code-review checks:
 * - Filters findings in details.findings array by severity
 * - Converts fail to pass if all remaining findings are below threshold
 *
 * For other checks (test, lint, build, etc):
 * - No filtering, returns results unchanged
 *
 * @param results - Array of gate results to filter
 * @param threshold - Minimum severity to block on (default: 'critical')
 * @returns Filtered gate results
 */
function filterBySeverity(results: GateResult[], threshold: Severity = 'critical'): GateResult[] {
  const thresholdRank = SEVERITY_RANK[threshold]

  return results.map((result) => {
    // Only filter security and code-review checks (they have severity in findings)
    if (result.checkName !== 'security' && result.checkName !== 'code-review') {
      return result
    }

    // If check passed or was skipped, no filtering needed
    if (result.verdict !== 'fail') {
      return result
    }

    // Filter findings by severity
    const findings = (result.details?.findings as Array<{ severity: string }> | undefined) ?? []
    const blockingFindings = findings.filter((f) => {
      const severity = f.severity as Severity
      return SEVERITY_RANK[severity] <= thresholdRank
    })

    // If no blocking findings remain, convert fail to pass
    if (blockingFindings.length === 0) {
      const totalFindings = findings.length
      return {
        ...result,
        verdict: 'pass',
        summary: `${result.summary} (${totalFindings} non-blocking finding(s) below '${threshold}' threshold)`,
        details: {
          ...result.details,
          findings,
          blockingFindings: 0,
          filteredByThreshold: threshold,
        },
      }
    }

    // Otherwise keep as fail with updated details
    return {
      ...result,
      details: {
        ...result.details,
        findings,
        blockingFindings: blockingFindings.length,
        filteredByThreshold: threshold,
      },
    }
  })
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
