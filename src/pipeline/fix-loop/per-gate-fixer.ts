/**
 * Per-Gate Fixer
 *
 * Spawns one fix agent per failed gate check, running sequentially
 * in priority order. Each fix agent gets a focused prompt with only
 * the raw output and findings for that specific check.
 *
 * Priority order ensures the most impactful fixes (test, build) run
 * first, so later checks benefit from already-fixed code.
 */

import type { PipelineRun, GateResult } from '../types.js'
import { execAsync } from '../exec-utils.js'
import { runStage } from '../stage-runner.js'
import { resolveModel, resolveBudget } from '../pipeline-config.js'
import { buildPerGateFixPrompt } from '../prompt-builder.js'
import { getDiff } from '../git-utils.js'
import { appendProgress } from '../progress.js'
import { CircuitBreaker } from './circuit-breaker.js'

// ============================================================================
// Constants
// ============================================================================

/**
 * Priority order for fixing gate checks.
 * Tests and builds come first because they produce concrete errors;
 * AI-based checks (code-review, security) come later.
 */
const FIX_PRIORITY = [
  'test',
  'build',
  'lint',
  'code-review',
  'security',
  'adversary',
  'ac-validator',
]

// ============================================================================
// Types
// ============================================================================

export interface FixOptions {
  /** Which fix-loop attempt this is (1-based). */
  attempt: number
  /** Override model for fix stages. */
  modelOverride?: string
  /** Override budget for fix stages. */
  budgetOverride?: number
}

export interface PerGateFixResult {
  /** Check names that received a fix attempt. */
  fixedChecks: string[]
  /** Check names that were skipped (circuit breaker or unknown priority). */
  skippedChecks: string[]
}

// ============================================================================
// Per-Gate Fix Runner
// ============================================================================

/**
 * Run per-gate fixes for each failed gate result, sequentially in priority order.
 *
 * For each failed check:
 * 1. Check circuit breaker -- skip if same pattern has failed twice
 * 2. Get current diff from worktree
 * 3. Build a focused per-gate fix prompt
 * 4. Spawn a Claude session to fix that specific check
 * 5. Auto-commit after the session completes
 * 6. Emit progress events
 */
export async function runPerGateFixes(
  run: PipelineRun,
  failedResults: GateResult[],
  opts: FixOptions,
): Promise<PerGateFixResult> {
  const fixedChecks: string[] = []
  const skippedChecks: string[] = []

  // Sort failed results by priority order
  const sorted = sortByPriority(failedResults)

  // Initialize circuit breaker from existing state
  const circuitBreaker = new CircuitBreaker(run.circuitBreakerState)

  for (const gateResult of sorted) {
    const checkName = gateResult.checkName

    // Check circuit breaker for this individual check
    const checkSignature = circuitBreaker.computeSignature([gateResult])
    if (circuitBreaker.isRepeatedFailure(checkSignature)) {
      await appendProgress(run.id, {
        type: 'info',
        stage: 'fix-loop',
        title: `Skipping ${checkName}: circuit breaker (repeated failure pattern)`,
        detail: checkSignature.description,
      }).catch(() => { /* best-effort */ })

      skippedChecks.push(checkName)
      continue
    }

    // Get the current diff from worktree
    const diff = (await getDiff(run.worktreePath, run.sourceBranch, run.baseCommit)) ?? '(no diff available)'

    // Build the per-gate fix prompt
    const { systemPrompt, userPrompt: baseUserPrompt } = await buildPerGateFixPrompt(
      checkName,
      gateResult.rawOutput,
      gateResult.findings,
      diff,
      run.description,
      run.acceptanceCriteria,
    )

    // Inject user instructions if provided (from retry-escalated)
    const userPrompt = run.userInstructions
      ? `${baseUserPrompt}\n\n# Additional Instructions from User\n${run.userInstructions}`
      : baseUserPrompt

    const stageKey = `fix-${checkName}-${opts.attempt}`

    // Emit progress for this check's fix start
    await appendProgress(run.id, {
      type: 'fix-loop',
      stage: 'fix-loop',
      title: `Fixing ${checkName} (attempt ${opts.attempt})`,
      data: { checkName, attempt: opts.attempt },
    }).catch(() => { /* best-effort */ })

    // Spawn the fix agent
    const result = await runStage({
      pipelineId: run.id,
      stageKey,
      config: run.config,
      cwd: run.worktreePath,
      prompt: userPrompt,
      systemPrompt,
      modelOverride: opts.modelOverride ?? resolveModel(run.config, 'fix'),
      budgetOverride: opts.budgetOverride ?? resolveBudget(run.config, 'fix'),
    })

    if (!result.success) {
      // Log the failure but continue to next check (best-effort per-gate fixing)
      await appendProgress(run.id, {
        type: 'stage-error',
        stage: 'fix-loop',
        title: `Fix for ${checkName} failed (exit code ${result.exitCode})`,
        detail: result.stderr.slice(0, 500),
        data: { checkName, exitCode: result.exitCode },
      }).catch(() => { /* best-effort */ })

      skippedChecks.push(checkName)
      continue
    }

    // Auto-commit after this check's fix
    const commitResult = await autoCommitPerGateFix(run.worktreePath, checkName, opts.attempt)

    // Emit progress for this check's fix completion
    await appendProgress(run.id, {
      type: 'fix-loop',
      stage: 'fix-loop',
      title: `Fixed ${checkName} (attempt ${opts.attempt})`,
      detail: `Committed ${commitResult.commitSha}`,
      data: { checkName, attempt: opts.attempt, commitSha: commitResult.commitSha, model: result.model },
    }).catch(() => { /* best-effort */ })

    fixedChecks.push(checkName)
  }

  return { fixedChecks, skippedChecks }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Sort gate results by FIX_PRIORITY order.
 * Checks not in the priority list are appended at the end.
 */
function sortByPriority(results: GateResult[]): GateResult[] {
  return [...results].sort((a, b) => {
    const aIdx = FIX_PRIORITY.indexOf(a.checkName)
    const bIdx = FIX_PRIORITY.indexOf(b.checkName)
    // Unknown checks get pushed to the end
    const aOrder = aIdx === -1 ? FIX_PRIORITY.length : aIdx
    const bOrder = bIdx === -1 ? FIX_PRIORITY.length : bIdx
    return aOrder - bOrder
  })
}

/**
 * Stage and commit fix changes for a specific gate check.
 */
async function autoCommitPerGateFix(
  worktreePath: string,
  checkName: string,
  attempt: number,
): Promise<{ commitSha: string }> {
  const execOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

  // Stage all changes
  await execAsync('git add -A', execOpts)

  // Check if there's anything to commit
  const { stdout: statusOut } = await execAsync('git status --porcelain', execOpts)
  const status = statusOut.trim()

  if (status) {
    await execAsync(
      `git commit -m "fix: ${checkName} issues (attempt ${attempt})"`,
      execOpts,
    )
  }

  const { stdout: shaOut } = await execAsync('git rev-parse HEAD', execOpts)
  const commitSha = shaOut.trim()
  return { commitSha }
}
