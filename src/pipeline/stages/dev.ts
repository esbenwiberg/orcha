/**
 * Dev Stage
 *
 * Takes the approved blueprint and implements changes in the pipeline worktree.
 *
 * Steps:
 * 1. Load the blueprint from disk
 * 2. Build the dev prompt with blueprint + work item context
 * 3. Run Claude session via stage-runner (full tool access, autonomous mode)
 * 4. Auto-commit all changes in the worktree after session completes
 * 5. Save dev results (diff, metadata) to pipeline directory
 * 6. Transition state: dev → gate (on success) or dev → error (on failure)
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { execSync } from 'child_process'
import type { PipelineRun, StageResult } from '../types.js'
import { transition, recordStageResult, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { runStage } from '../stage-runner.js'
import { buildDevPrompt } from '../prompt-builder.js'
import type { WorkItemContext, CodebaseContext } from '../prompt-builder.js'

// ============================================================================
// Types
// ============================================================================

export interface DevOptions {
  /** Override model for the dev stage. */
  modelOverride?: string
  /** Override budget for the dev stage. */
  budgetOverride?: number
}

export interface DevResult {
  /** The git diff produced by the dev agent. */
  diff: string
  /** Branch name. */
  branch: string
  /** Commit SHA of the auto-commit. */
  commitSha: string
}

// ============================================================================
// Dev Stage Runner
// ============================================================================

/**
 * Execute the dev stage for a pipeline run.
 *
 * Expects the pipeline to be in 'dev' state with a valid blueprintPath.
 * On success, transitions to 'gate'. On failure, transitions to 'error'.
 */
export async function runDevStage(
  run: PipelineRun,
  opts?: DevOptions,
): Promise<PipelineRun> {
  const startedAt = new Date().toISOString()

  try {
    // Load the blueprint
    const blueprintPath = run.blueprintPath || join(getPipelineDir(run.id), 'blueprint.json')
    const blueprintJson = await readFile(blueprintPath, 'utf-8')

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

    // Build the dev prompt
    const { systemPrompt, userPrompt } = buildDevPrompt(workItem, codebase, {
      blueprintJson,
    })

    // Run the dev stage (full tool access, no restriction)
    const result = await runStage({
      pipelineId: run.id,
      stageKey: 'dev',
      config: run.config,
      cwd: run.worktreePath,
      prompt: userPrompt,
      systemPrompt,
      modelOverride: opts?.modelOverride,
      budgetOverride: opts?.budgetOverride,
    })

    if (!result.success) {
      const errorMsg = `Dev stage failed (exit code ${result.exitCode}): ${result.stderr.slice(0, 500)}`
      return await transitionToError(run, errorMsg)
    }

    // Auto-commit all changes in the worktree
    const devResult = await autoCommit(run.worktreePath, run.sourceBranch)

    // Save dev results to pipeline directory
    const devResultsDir = join(getPipelineDir(run.id), 'dev-results')
    await mkdir(devResultsDir, { recursive: true })

    await writeFile(
      join(devResultsDir, 'dev.diff'),
      devResult.diff,
      'utf-8',
    )

    await writeFile(
      join(devResultsDir, 'dev.meta.json'),
      JSON.stringify({
        branch: devResult.branch,
        commitSha: devResult.commitSha,
        worktreePath: run.worktreePath,
        model: result.model,
        budget: result.budget,
        completedAt: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    )

    // Record stage result
    const completedAt = new Date().toISOString()
    const stageResult: StageResult = {
      stage: 'dev',
      startedAt,
      completedAt,
      model: result.model,
      output: `Committed: ${devResult.commitSha} on ${devResult.branch}`,
    }
    run = await recordStageResult(run, stageResult)

    // Transition: dev → gate
    run = await transition(run, 'gate')

    return run
  } catch (err) {
    const errorMsg = `Dev stage error: ${(err as Error).message}`
    try {
      return await transitionToError(run, errorMsg)
    } catch {
      return { ...run, state: 'error', error: errorMsg }
    }
  }
}

// ============================================================================
// Auto-Commit
// ============================================================================

/**
 * Stage all changes and commit in the worktree.
 * Returns the diff and commit SHA.
 */
async function autoCommit(worktreePath: string, sourceBranch: string): Promise<DevResult> {
  const execOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

  // Get the current branch name
  const branch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).trim()

  // Get the diff before committing (for recording purposes)
  let diff: string
  try {
    diff = execSync(`git diff ${sourceBranch}...HEAD`, execOpts).trim()
  } catch {
    // If the source branch doesn't exist locally, diff against HEAD
    diff = execSync('git diff HEAD', execOpts).trim()
  }

  // Stage all changes
  execSync('git add -A', execOpts)

  // Check if there's anything to commit
  const status = execSync('git status --porcelain', execOpts).trim()
  let commitSha: string

  if (status) {
    // Commit the changes
    execSync(
      'git commit -m "pipeline: dev agent implementation"',
      execOpts,
    )
    commitSha = execSync('git rev-parse HEAD', execOpts).trim()

    // Re-capture diff after commit (now includes the commit)
    try {
      diff = execSync(`git diff ${sourceBranch}...HEAD`, execOpts).trim()
    } catch {
      diff = execSync('git diff HEAD~1', execOpts).trim()
    }
  } else {
    // No changes to commit (unusual but possible)
    commitSha = execSync('git rev-parse HEAD', execOpts).trim()
  }

  return { diff, branch, commitSha }
}
