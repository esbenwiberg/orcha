/**
 * Fix Loop Stage
 *
 * On gate failure, spawns a fresh Claude session with:
 * - The original blueprint
 * - The current diff (committed code)
 * - A detailed failure report from the gate
 *
 * After the fix agent completes, auto-commits and transitions
 * back to 'gate' for re-evaluation. If max retries are exceeded,
 * transitions to 'escalated'.
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { execSync } from 'child_process'
import type { PipelineRun, GateResult, StageResult } from '../types.js'
import { transition, recordStageResult, incrementFixLoop, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { runStage } from '../stage-runner.js'
import { resolveModel, resolveBudget } from '../pipeline-config.js'
import { buildFixLoopPrompt } from '../prompt-builder.js'
import type { WorkItemContext, CodebaseContext } from '../prompt-builder.js'
import { getDiff } from '../git-utils.js'

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
 * On error: transitions to 'error'.
 */
export async function runFixLoopStage(
  run: PipelineRun,
  opts?: FixLoopOptions,
): Promise<PipelineRun> {
  const startedAt = new Date().toISOString()
  const maxFixLoops = run.config.maxFixLoops ?? 3

  try {
    // Check if we've exceeded max fix loops
    if (run.fixLoopCount >= maxFixLoops) {
      run = await transition(run, 'escalated')
      return run
    }

    // Increment the fix loop counter
    run = await incrementFixLoop(run)
    const attempt = run.fixLoopCount

    // Load the blueprint
    const blueprintPath = run.blueprintPath || join(getPipelineDir(run.id), 'blueprint.json')
    const blueprintJson = await readFile(blueprintPath, 'utf-8')

    // Get the current diff
    const diff = getDiff(run.worktreePath, run.sourceBranch) ?? '(unable to generate diff)'

    // Build failure report from gate results
    const failureReport = buildFailureReport(run.gateResults)

    // Build work item context
    const workItem: WorkItemContext = {
      workItemId: run.workItemId,
      description: run.description,
      acceptanceCriteria: run.acceptanceCriteria,
    }

    // Build codebase context
    const codebase: CodebaseContext = {
      worktreePath: run.worktreePath,
      sourceBranch: run.sourceBranch,
    }

    // Build the fix prompt
    const { systemPrompt, userPrompt } = buildFixLoopPrompt(workItem, codebase, {
      blueprintJson,
      diff,
      failureReport,
      attempt,
      maxAttempts: maxFixLoops,
    })

    // Use fix-{n} for log file naming, but resolve model/budget from 'fix' key
    const stageKey = `fix-${attempt}`

    // Run the fix stage (full tool access, autonomous mode)
    const result = await runStage({
      pipelineId: run.id,
      stageKey,
      config: run.config,
      cwd: run.worktreePath,
      prompt: userPrompt,
      systemPrompt,
      modelOverride: opts?.modelOverride ?? resolveModel(run.config, 'fix'),
      budgetOverride: opts?.budgetOverride ?? resolveBudget(run.config, 'fix'),
    })

    if (!result.success) {
      const errorMsg = `Fix loop attempt ${attempt} failed (exit code ${result.exitCode}): ${result.stderr.slice(0, 500)}`
      return await transitionToError(run, errorMsg)
    }

    // Auto-commit fix changes
    const commitResult = await autoCommitFix(run.worktreePath, attempt)

    // Save fix loop artifacts
    const fixDir = join(getPipelineDir(run.id), 'fix-loops', `attempt-${attempt}`)
    await mkdir(fixDir, { recursive: true })

    await writeFile(
      join(fixDir, 'meta.json'),
      JSON.stringify({
        attempt,
        commitSha: commitResult.commitSha,
        model: result.model,
        budget: result.budget,
        failureReport,
        completedAt: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    )

    // Record stage result
    const completedAt = new Date().toISOString()
    const stageResult: StageResult = {
      stage: 'fix-loop',
      startedAt,
      completedAt,
      model: result.model,
      output: `Fix attempt ${attempt}: committed ${commitResult.commitSha}`,
    }
    run = await recordStageResult(run, stageResult)

    // Transition back to gate for re-evaluation
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

// ============================================================================
// Helpers
// ============================================================================

/**
 * Build a human-readable failure report from gate results.
 */
function buildFailureReport(gateResults: GateResult[]): string {
  const failures = gateResults.filter((r) => r.verdict === 'fail')

  if (failures.length === 0) {
    return 'No failures reported (this should not happen in fix-loop).'
  }

  const sections = failures.map((f) => {
    const lines = [
      `## ${f.checkName} — FAILED`,
      f.summary,
    ]
    if (f.details) {
      lines.push('')
      lines.push('Details:')
      lines.push('```json')
      lines.push(JSON.stringify(f.details, null, 2))
      lines.push('```')
    }
    return lines.join('\n')
  })

  return [
    `# Gate Failures (${failures.length} check(s) failed)`,
    '',
    ...sections,
  ].join('\n\n')
}

/**
 * Stage and commit fix changes.
 */
async function autoCommitFix(
  worktreePath: string,
  attempt: number,
): Promise<{ commitSha: string }> {
  const execOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

  // Stage all changes
  execSync('git add -A', execOpts)

  // Check if there's anything to commit
  const status = execSync('git status --porcelain', execOpts).trim()

  if (status) {
    execSync(
      `git commit -m "pipeline: fix-loop attempt ${attempt}"`,
      execOpts,
    )
  }

  const commitSha = execSync('git rev-parse HEAD', execOpts).trim()
  return { commitSha }
}
