/**
 * Dev Stage
 *
 * Takes the approved blueprint and implements changes in the pipeline worktree.
 * Supports competing mode: run N dev agents in parallel with separate worktrees.
 *
 * Single mode (default):
 * 1. Load the blueprint from disk
 * 2. Build the dev prompt with blueprint + work item context
 * 3. Run Claude session via stage-runner (full tool access, autonomous mode)
 * 4. Auto-commit all changes in the worktree after session completes
 * 5. Save dev results (diff, metadata) to pipeline directory
 * 6. Transition state: dev → gate
 *
 * Competing mode (--competing N):
 * 1. Create N worktrees branching from the pipeline worktree
 * 2. Run N dev agents in parallel
 * 3. Auto-commit each worktree
 * 4. Save per-agent results
 * 5. Transition state: dev → gate (gate evaluates all competitors)
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { execSync } from 'child_process'
import type { PipelineRun, StageResult, CompetingResult } from '../types.js'
import { transition, recordStageResult, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { savePipelineRun } from '../pipeline-store.js'
import { runStage } from '../stage-runner.js'
import { buildDevPrompt } from '../prompt-builder.js'
import type { WorkItemContext, CodebaseContext } from '../prompt-builder.js'
import { appendProgress } from '../progress.js'

// ============================================================================
// Types
// ============================================================================

export interface DevOptions {
  /** Override model for the dev stage. */
  modelOverride?: string
  /** Override budget for the dev stage. */
  budgetOverride?: number
  /** Number of competing agents (overrides config). */
  competing?: number
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
  const competing = opts?.competing ?? run.config.competingAgents ?? 1

  if (competing > 1) {
    return runCompetingDevStage(run, competing, opts)
  }
  return runSingleDevStage(run, opts)
}

// ============================================================================
// Single Dev Agent
// ============================================================================

async function runSingleDevStage(
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
    await appendProgress(run.id, {
      type: 'stage-error',
      stage: 'dev',
      title: 'Dev stage error',
      detail: errorMsg,
    }).catch(() => { /* best-effort */ })
    try {
      return await transitionToError(run, errorMsg)
    } catch {
      return { ...run, state: 'error', error: errorMsg }
    }
  }
}

// ============================================================================
// Competing Dev Agents
// ============================================================================

async function runCompetingDevStage(
  run: PipelineRun,
  count: number,
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

    // Emit progress for competing dev start
    await appendProgress(run.id, {
      type: 'competing-start',
      stage: 'dev',
      title: `Starting ${count} competing dev agents`,
      data: { count },
    }).catch(() => { /* best-effort */ })

    // Create N worktrees and run N agents in parallel
    const competingResults: CompetingResult[] = []
    const agentPromises: Promise<void>[] = []

    for (let i = 0; i < count; i++) {
      agentPromises.push(
        runCompetingAgent(run, i, blueprintJson, workItem, opts).then(
          (result) => { competingResults.push(result) },
          (err) => {
            // Record failed agent but don't abort the whole stage
            console.error(`Competing agent ${i} failed:`, (err as Error).message)
            competingResults.push({
              agentIndex: i,
              branch: `pipeline/${run.id}-dev-${i}`,
              worktreePath: '',
              diff: '',
              commitSha: '',
              gateScore: -1,
              winner: false,
            })
          },
        ),
      )
    }

    // Wait for all agents to complete
    await Promise.all(agentPromises)

    // Sort by agent index for consistent ordering
    competingResults.sort((a, b) => a.agentIndex - b.agentIndex)

    // Filter out failed agents (empty commitSha) — gate cannot evaluate stubs
    const successfulResults = competingResults.filter((r) => r.commitSha !== '')

    // Save competing results to pipeline run (only successful ones)
    run = {
      ...run,
      competingResults: successfulResults,
      updatedAt: new Date().toISOString(),
    }
    await savePipelineRun(run)

    // Save per-agent results to pipeline directory
    const devResultsDir = join(getPipelineDir(run.id), 'dev-results')
    await mkdir(devResultsDir, { recursive: true })

    for (const result of competingResults) {
      if (result.diff) {
        await writeFile(
          join(devResultsDir, `dev-${result.agentIndex}.diff`),
          result.diff,
          'utf-8',
        )
      }
      await writeFile(
        join(devResultsDir, `dev-${result.agentIndex}.meta.json`),
        JSON.stringify({
          agentIndex: result.agentIndex,
          branch: result.branch,
          commitSha: result.commitSha,
          worktreePath: result.worktreePath,
          completedAt: new Date().toISOString(),
        }, null, 2),
        'utf-8',
      )
    }

    // Emit progress for competing dev result
    await appendProgress(run.id, {
      type: 'competing-result',
      stage: 'dev',
      title: `${successfulResults.length}/${count} competing dev agents completed`,
      data: {
        total: count,
        successful: successfulResults.length,
        agents: competingResults.map((r) => ({
          agentIndex: r.agentIndex,
          commitSha: r.commitSha,
          success: r.commitSha !== '',
        })),
      },
    }).catch(() => { /* best-effort */ })

    // Check if we have at least one successful agent
    if (successfulResults.length === 0) {
      return await transitionToError(run, 'All competing dev agents failed')
    }

    // Record stage result
    const completedAt = new Date().toISOString()
    const stageResult: StageResult = {
      stage: 'dev',
      startedAt,
      completedAt,
      output: `${successfulResults.length}/${count} competing agents completed successfully`,
    }
    run = await recordStageResult(run, stageResult)

    // Transition: dev → gate
    run = await transition(run, 'gate')

    return run
  } catch (err) {
    const errorMsg = `Competing dev stage error: ${(err as Error).message}`
    await appendProgress(run.id, {
      type: 'stage-error',
      stage: 'dev',
      title: 'Competing dev stage error',
      detail: errorMsg,
    }).catch(() => { /* best-effort */ })
    try {
      return await transitionToError(run, errorMsg)
    } catch {
      return { ...run, state: 'error', error: errorMsg }
    }
  }
}

/**
 * Run a single competing agent in its own worktree.
 */
async function runCompetingAgent(
  run: PipelineRun,
  agentIndex: number,
  blueprintJson: string,
  workItem: WorkItemContext,
  opts?: DevOptions,
): Promise<CompetingResult> {
  // Create a unique branch for this competing agent
  const branchName = `pipeline/${run.id}-dev-${agentIndex}`

  // Create worktree for this agent from the pipeline worktree's current state
  const worktreePath = `${run.worktreePath}-dev-${agentIndex}`

  const execOpts = { cwd: run.worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

  // Create a new branch from the current pipeline branch and add worktree
  execSync(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, execOpts)

  try {
    // Build codebase context for this agent's worktree
    const codebase: CodebaseContext = {
      worktreePath,
      sourceBranch: run.sourceBranch,
    }

    // Build the dev prompt with agent identity info
    const { systemPrompt, userPrompt } = buildDevPrompt(workItem, codebase, {
      blueprintJson,
    })

    const agentSystemPrompt = `${systemPrompt}\n\nYou are competing dev agent #${agentIndex + 1} of ${run.config.competingAgents ?? 1}. Produce your best implementation — the gate stage will evaluate all agents and select the best one.`

    // Run the dev stage in the agent's worktree
    const result = await runStage({
      pipelineId: run.id,
      stageKey: `dev-${agentIndex}`,
      config: run.config,
      cwd: worktreePath,
      prompt: userPrompt,
      systemPrompt: agentSystemPrompt,
      modelOverride: opts?.modelOverride,
      budgetOverride: opts?.budgetOverride,
    })

    if (!result.success) {
      throw new Error(`Agent ${agentIndex} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
    }

    // Auto-commit in the agent's worktree
    const devResult = await autoCommit(worktreePath, run.sourceBranch)

    return {
      agentIndex,
      branch: devResult.branch,
      worktreePath,
      diff: devResult.diff,
      commitSha: devResult.commitSha,
      gateScore: -1, // Will be set by gate stage
      winner: false,
    }
  } catch (err) {
    // Clean up worktree on failure
    try {
      execSync(`git worktree remove --force "${worktreePath}"`, execOpts)
    } catch {
      // Best effort cleanup
    }
    throw err
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
  }

  commitSha = execSync('git rev-parse HEAD', execOpts).trim()

  // Capture diff after commit (consistent: always use three-dot syntax)
  let diff: string
  try {
    diff = execSync(`git diff ${sourceBranch}...HEAD`, execOpts).trim()
  } catch {
    try {
      diff = execSync(`git diff origin/${sourceBranch}...HEAD`, execOpts).trim()
    } catch {
      diff = execSync('git diff HEAD~1', execOpts).trim()
    }
  }

  return { diff, branch, commitSha }
}
