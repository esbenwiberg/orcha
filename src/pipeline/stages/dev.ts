/**
 * Dev Stage
 *
 * Takes the approved blueprint and implements changes in the pipeline worktree.
 * Supports milestone-based execution (fresh context per milestone) and
 * competing mode (parallel agents per milestone).
 *
 * DESIGN DECISION: Milestones execute SEQUENTIALLY, not in parallel.
 * Rationale:
 * 1. Milestones typically have sequential dependencies (M2 builds on M1 changes)
 * 2. Parallel execution would require complex merge conflict resolution
 * 3. The competing agents feature already provides parallelism for the same work unit
 *    (use --competing N to run parallel agents on each milestone)
 *
 * Milestone-based execution (default for multi-milestone blueprints):
 * For EACH milestone:
 *   1. Build a milestone-specific prompt with only that milestone's context
 *   2. Spawn a FRESH Claude session (clean context = no pollution from previous milestones)
 *   3. Auto-commit after completion
 *   4. Update milestoneHistory in PipelineRun
 * This addresses context pollution and cost concerns for large blueprints.
 *
 * Competing mode (--competing N):
 * For EACH milestone:
 *   1. Create N worktrees branching from the current state
 *   2. Run N dev agents in parallel on the CURRENT milestone
 *   3. Gate evaluates all competitors, selects winner
 *   4. Winner's changes are merged, proceed to next milestone with fresh agents
 *
 * Single mode (single-milestone blueprints):
 * 1. Load the blueprint from disk
 * 2. Build the dev prompt with blueprint + work item context
 * 3. Run Claude session via stage-runner (full tool access, autonomous mode)
 * 4. Auto-commit all changes in the worktree after session completes
 * 5. Save dev results (diff, metadata) to pipeline directory
 * 6. Transition state: dev → gate
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { execSync } from 'child_process'
import type { PipelineRun, StageResult, CompetingResult, MilestoneProgress, BlueprintOutput } from '../types.js'
import { getBlueprintMilestones } from '../types.js'
import { transition, recordStageResult, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { savePipelineRun } from '../pipeline-store.js'
import { runStage } from '../stage-runner.js'
import { buildDevPrompt, buildMilestoneDevPrompt } from '../prompt-builder.js'
import type { WorkItemContext, CodebaseContext, MilestoneContext } from '../prompt-builder.js'
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
// Single Dev Agent (with milestone support)
// ============================================================================

/**
 * Execute the dev stage with milestone-based context isolation.
 *
 * DESIGN DECISION: Each milestone is implemented with a FRESH Claude session.
 * This prevents context pollution between milestones and reduces per-session
 * token costs. Milestones execute SEQUENTIALLY (not in parallel) because:
 * 1. Milestones typically have sequential dependencies (M2 builds on M1 changes)
 * 2. Parallel execution would require complex merge conflict resolution
 * 3. The competing agents feature provides parallelism when needed
 */
async function runSingleDevStage(
  run: PipelineRun,
  opts?: DevOptions,
): Promise<PipelineRun> {
  const startedAt = new Date().toISOString()

  try {
    // Load the blueprint
    const blueprintPath = run.blueprintPath || join(getPipelineDir(run.id), 'blueprint.json')
    const blueprintJson = await readFile(blueprintPath, 'utf-8')
    const blueprint: BlueprintOutput = JSON.parse(blueprintJson)

    // Get milestones from blueprint (supports both 'milestones' and 'steps')
    const milestones = getBlueprintMilestones(blueprint)

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

    // Initialize milestone tracking if not already present
    if (!run.milestoneHistory) {
      run = { ...run, milestoneHistory: [] }
    }

    // Determine starting milestone (support recovery from failed milestone)
    const startingMilestoneIndex = run.currentMilestoneIndex ?? 0

    // If only one milestone, use the simpler single-prompt approach
    if (milestones.length <= 1) {
      return await runSingleMilestoneDevStage(run, workItem, codebase, blueprintJson, opts, startedAt)
    }

    // Multi-milestone execution: each milestone gets a FRESH Claude session
    await appendProgress(run.id, {
      type: 'info',
      stage: 'dev',
      title: `Starting milestone-based dev execution (${milestones.length} milestones)`,
      data: { totalMilestones: milestones.length, startingFrom: startingMilestoneIndex },
    }).catch(() => { /* best-effort */ })

    for (let i = startingMilestoneIndex; i < milestones.length; i++) {
      const milestone = milestones[i]

      // Update current milestone index
      run = {
        ...run,
        currentMilestoneIndex: i,
        updatedAt: new Date().toISOString(),
      }
      await savePipelineRun(run)

      // Record milestone start
      const milestoneStartedAt = new Date().toISOString()
      const milestoneProgress: MilestoneProgress = {
        index: i,
        startedAt: milestoneStartedAt,
      }

      await appendProgress(run.id, {
        type: 'info',
        stage: 'dev',
        title: `Starting milestone ${i + 1}/${milestones.length}: ${milestone.description}`,
        data: { milestoneIndex: i, description: milestone.description },
      }).catch(() => { /* best-effort */ })

      // Build milestone-specific prompt (FRESH context for each milestone)
      const milestoneContext: MilestoneContext = {
        blueprintJson,
        milestoneIndex: i,
        totalMilestones: milestones.length,
        milestoneDescription: milestone.description,
        milestoneDetails: milestone.details,
        milestoneFilesToTouch: milestone.filesToTouch,
      }

      const { systemPrompt, userPrompt } = buildMilestoneDevPrompt(workItem, codebase, milestoneContext)

      // Run the milestone with a FRESH Claude session (this is the key for context isolation)
      const result = await runStage({
        pipelineId: run.id,
        stageKey: `dev-milestone-${i}`,
        config: run.config,
        cwd: run.worktreePath,
        prompt: userPrompt,
        systemPrompt,
        modelOverride: opts?.modelOverride,
        budgetOverride: opts?.budgetOverride,
      })

      if (!result.success) {
        // Record milestone failure
        milestoneProgress.error = `Milestone ${i + 1} failed (exit code ${result.exitCode}): ${result.stderr.slice(0, 300)}`
        run = {
          ...run,
          milestoneHistory: [...(run.milestoneHistory || []), milestoneProgress],
        }
        await savePipelineRun(run)

        const errorMsg = `Dev stage failed at milestone ${i + 1}/${milestones.length}: ${result.stderr.slice(0, 500)}`
        return await transitionToError(run, errorMsg)
      }

      // Auto-commit this milestone's changes
      const milestoneResult = await autoCommit(run.worktreePath, run.sourceBranch, `milestone ${i + 1}: ${milestone.description}`)

      // Record milestone completion
      milestoneProgress.completedAt = new Date().toISOString()
      milestoneProgress.commitSha = milestoneResult.commitSha

      run = {
        ...run,
        milestoneHistory: [...(run.milestoneHistory || []), milestoneProgress],
        updatedAt: new Date().toISOString(),
      }
      await savePipelineRun(run)

      await appendProgress(run.id, {
        type: 'stage-complete',
        stage: 'dev',
        title: `Completed milestone ${i + 1}/${milestones.length}: ${milestone.description}`,
        data: { milestoneIndex: i, commitSha: milestoneResult.commitSha },
      }).catch(() => { /* best-effort */ })
    }

    // All milestones completed - capture final diff
    const finalDiff = await getFinalDiff(run.worktreePath, run.sourceBranch)

    // Save dev results to pipeline directory
    const devResultsDir = join(getPipelineDir(run.id), 'dev-results')
    await mkdir(devResultsDir, { recursive: true })

    await writeFile(
      join(devResultsDir, 'dev.diff'),
      finalDiff,
      'utf-8',
    )

    await writeFile(
      join(devResultsDir, 'dev.meta.json'),
      JSON.stringify({
        branch: run.sourceBranch,
        totalMilestones: milestones.length,
        milestoneHistory: run.milestoneHistory,
        worktreePath: run.worktreePath,
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
      output: `Completed ${milestones.length} milestones`,
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

/**
 * Execute a single-milestone dev stage (simpler path for small blueprints).
 * Used when the blueprint has only one milestone/step.
 */
async function runSingleMilestoneDevStage(
  run: PipelineRun,
  workItem: WorkItemContext,
  codebase: CodebaseContext,
  blueprintJson: string,
  opts: DevOptions | undefined,
  startedAt: string,
): Promise<PipelineRun> {
  // Build the dev prompt (full blueprint approach for single milestone)
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
}

// ============================================================================
// Helper: Get Final Diff
// ============================================================================

/**
 * Get the cumulative diff from source branch to current HEAD.
 */
async function getFinalDiff(worktreePath: string, sourceBranch: string): Promise<string> {
  const execOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

  try {
    return execSync(`git diff ${sourceBranch}...HEAD`, execOpts).trim()
  } catch {
    try {
      return execSync(`git diff origin/${sourceBranch}...HEAD`, execOpts).trim()
    } catch {
      // Fallback: diff from initial commit on this branch
      return execSync('git diff HEAD~1', execOpts).trim()
    }
  }
}

// ============================================================================
// Competing Dev Agents (per-milestone)
// ============================================================================

/**
 * DESIGN DECISION: Competing agents work on the CURRENT milestone only.
 *
 * When --competing N is specified:
 * - For EACH milestone, N agents compete in parallel
 * - Gate evaluates all N implementations of that milestone
 * - Winner's changes are selected (or best scored one if running without gate)
 * - Proceed to next milestone with fresh agents
 *
 * This ensures:
 * 1. Competition is fair (all agents start from same state)
 * 2. Context is fresh for each milestone (no pollution)
 * 3. Parallelism happens within milestones, not across them
 */
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
    const blueprint: BlueprintOutput = JSON.parse(blueprintJson)

    // Get milestones from blueprint
    const milestones = getBlueprintMilestones(blueprint)

    // Build work item context
    const workItem: WorkItemContext = {
      workItemId: run.workItemId,
      description: run.description,
      acceptanceCriteria: run.acceptanceCriteria,
    }

    // Build codebase context (for the main worktree)
    const codebase: CodebaseContext = {
      worktreePath: run.worktreePath,
      sourceBranch: run.sourceBranch,
    }

    // Initialize milestone tracking if not already present
    if (!run.milestoneHistory) {
      run = { ...run, milestoneHistory: [] }
    }

    // Determine starting milestone (support recovery)
    const startingMilestoneIndex = run.currentMilestoneIndex ?? 0

    // If only one milestone, run all agents on it (original competing behavior)
    if (milestones.length <= 1) {
      return await runCompetingAgentsOnMilestone(
        run, count, blueprintJson, workItem, codebase, opts, startedAt, null
      )
    }

    // Multi-milestone competing: for EACH milestone, run N competing agents
    await appendProgress(run.id, {
      type: 'info',
      stage: 'dev',
      title: `Starting per-milestone competing dev (${milestones.length} milestones, ${count} agents each)`,
      data: { totalMilestones: milestones.length, agentsPerMilestone: count },
    }).catch(() => { /* best-effort */ })

    for (let milestoneIdx = startingMilestoneIndex; milestoneIdx < milestones.length; milestoneIdx++) {
      const milestone = milestones[milestoneIdx]

      // Update current milestone index
      run = {
        ...run,
        currentMilestoneIndex: milestoneIdx,
        updatedAt: new Date().toISOString(),
      }
      await savePipelineRun(run)

      await appendProgress(run.id, {
        type: 'competing-start',
        stage: 'dev',
        title: `Starting ${count} competing agents for milestone ${milestoneIdx + 1}/${milestones.length}`,
        data: { milestoneIndex: milestoneIdx, count, description: milestone.description },
      }).catch(() => { /* best-effort */ })

      // Build milestone context for this iteration
      const milestoneContext: MilestoneContext = {
        blueprintJson,
        milestoneIndex: milestoneIdx,
        totalMilestones: milestones.length,
        milestoneDescription: milestone.description,
        milestoneDetails: milestone.details,
        milestoneFilesToTouch: milestone.filesToTouch,
      }

      // Run competing agents on this milestone
      run = await runCompetingAgentsOnMilestone(
        run, count, blueprintJson, workItem, codebase, opts, startedAt, milestoneContext
      )

      // If we hit an error, stop
      if (run.state === 'error') {
        return run
      }

      // Record milestone completion
      const milestoneProgress: MilestoneProgress = {
        index: milestoneIdx,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        // Note: commitSha will be from the winning agent, stored in competingResults
      }
      run = {
        ...run,
        milestoneHistory: [...(run.milestoneHistory || []), milestoneProgress],
      }
      await savePipelineRun(run)

      // If this isn't the last milestone, we need gate to pick a winner
      // The gate stage will evaluate competing results and select winner
      // For now, transition to gate after all milestones are done
    }

    // All milestones completed with competing agents
    // Transition: dev → gate (gate will evaluate the final competing results)
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
 * Run N competing agents on a single milestone (or full blueprint if milestoneContext is null).
 */
async function runCompetingAgentsOnMilestone(
  run: PipelineRun,
  count: number,
  blueprintJson: string,
  workItem: WorkItemContext,
  codebase: CodebaseContext,
  opts: DevOptions | undefined,
  startedAt: string,
  milestoneContext: MilestoneContext | null,
): Promise<PipelineRun> {
  // Create N worktrees and run N agents in parallel
  const competingResults: CompetingResult[] = []
  const agentPromises: Promise<void>[] = []

  const milestoneLabel = milestoneContext
    ? `milestone-${milestoneContext.milestoneIndex}`
    : 'full'

  for (let i = 0; i < count; i++) {
    agentPromises.push(
      runCompetingAgent(run, i, blueprintJson, workItem, opts, milestoneContext).then(
        (result) => { competingResults.push(result) },
        (err) => {
          // Record failed agent but don't abort the whole stage
          console.error(`Competing agent ${i} (${milestoneLabel}) failed:`, (err as Error).message)
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
    const suffix = milestoneContext ? `-m${milestoneContext.milestoneIndex}` : ''
    if (result.diff) {
      await writeFile(
        join(devResultsDir, `dev-${result.agentIndex}${suffix}.diff`),
        result.diff,
        'utf-8',
      )
    }
    await writeFile(
      join(devResultsDir, `dev-${result.agentIndex}${suffix}.meta.json`),
      JSON.stringify({
        agentIndex: result.agentIndex,
        branch: result.branch,
        commitSha: result.commitSha,
        worktreePath: result.worktreePath,
        milestoneIndex: milestoneContext?.milestoneIndex,
        completedAt: new Date().toISOString(),
      }, null, 2),
      'utf-8',
    )
  }

  // Emit progress for competing dev result
  await appendProgress(run.id, {
    type: 'competing-result',
    stage: 'dev',
    title: `${successfulResults.length}/${count} competing agents completed${milestoneContext ? ` (milestone ${milestoneContext.milestoneIndex + 1})` : ''}`,
    data: {
      total: count,
      successful: successfulResults.length,
      milestoneIndex: milestoneContext?.milestoneIndex,
      agents: competingResults.map((r) => ({
        agentIndex: r.agentIndex,
        commitSha: r.commitSha,
        success: r.commitSha !== '',
      })),
    },
  }).catch(() => { /* best-effort */ })

  // Check if we have at least one successful agent
  if (successfulResults.length === 0) {
    const errorContext = milestoneContext
      ? ` for milestone ${milestoneContext.milestoneIndex + 1}`
      : ''
    return await transitionToError(run, `All competing dev agents failed${errorContext}`)
  }

  // Record stage result (for single milestone or final)
  if (!milestoneContext) {
    const completedAt = new Date().toISOString()
    const stageResult: StageResult = {
      stage: 'dev',
      startedAt,
      completedAt,
      output: `${successfulResults.length}/${count} competing agents completed successfully`,
    }
    run = await recordStageResult(run, stageResult)
  }

  return run
}

/**
 * Run a single competing agent in its own worktree.
 *
 * @param milestoneContext - If provided, agent works on a specific milestone only.
 *                           If null, agent implements the full blueprint.
 */
async function runCompetingAgent(
  run: PipelineRun,
  agentIndex: number,
  blueprintJson: string,
  workItem: WorkItemContext,
  opts: DevOptions | undefined,
  milestoneContext: MilestoneContext | null,
): Promise<CompetingResult> {
  // Create a unique branch for this competing agent (include milestone index if applicable)
  const milestoneSuffix = milestoneContext ? `-m${milestoneContext.milestoneIndex}` : ''
  const branchName = `pipeline/${run.id}-dev-${agentIndex}${milestoneSuffix}`

  // Create worktree for this agent from the pipeline worktree's current state
  const worktreePath = `${run.worktreePath}-dev-${agentIndex}${milestoneSuffix}`

  const execOpts = { cwd: run.worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

  // Create a new branch from the current pipeline branch and add worktree
  execSync(`git worktree add -b "${branchName}" "${worktreePath}" HEAD`, execOpts)

  try {
    // Build codebase context for this agent's worktree
    const codebase: CodebaseContext = {
      worktreePath,
      sourceBranch: run.sourceBranch,
    }

    // Build prompt based on whether we have milestone context
    let systemPrompt: string
    let userPrompt: string

    if (milestoneContext) {
      // Milestone-specific prompt (FRESH context per milestone)
      const prompts = buildMilestoneDevPrompt(workItem, codebase, milestoneContext)
      systemPrompt = prompts.systemPrompt
      userPrompt = prompts.userPrompt
    } else {
      // Full blueprint prompt (single milestone or legacy mode)
      const prompts = buildDevPrompt(workItem, codebase, { blueprintJson })
      systemPrompt = prompts.systemPrompt
      userPrompt = prompts.userPrompt
    }

    // Add competing agent identity
    const competitionInfo = milestoneContext
      ? `You are competing dev agent #${agentIndex + 1} of ${run.config.competingAgents ?? 1} for milestone ${milestoneContext.milestoneIndex + 1}. Produce your best implementation — the gate stage will evaluate all agents and select the best one.`
      : `You are competing dev agent #${agentIndex + 1} of ${run.config.competingAgents ?? 1}. Produce your best implementation — the gate stage will evaluate all agents and select the best one.`

    const agentSystemPrompt = `${systemPrompt}\n\n${competitionInfo}`

    // Build stage key with milestone info
    const stageKey = milestoneContext
      ? `dev-${agentIndex}-m${milestoneContext.milestoneIndex}`
      : `dev-${agentIndex}`

    // Run the dev stage in the agent's worktree (FRESH session)
    const result = await runStage({
      pipelineId: run.id,
      stageKey,
      config: run.config,
      cwd: worktreePath,
      prompt: userPrompt,
      systemPrompt: agentSystemPrompt,
      modelOverride: opts?.modelOverride,
      budgetOverride: opts?.budgetOverride,
    })

    if (!result.success) {
      const context = milestoneContext ? ` (milestone ${milestoneContext.milestoneIndex + 1})` : ''
      throw new Error(`Agent ${agentIndex}${context} failed (exit ${result.exitCode}): ${result.stderr.slice(0, 300)}`)
    }

    // Auto-commit in the agent's worktree
    const commitSuffix = milestoneContext
      ? `milestone ${milestoneContext.milestoneIndex + 1}: ${milestoneContext.milestoneDescription}`
      : undefined
    const devResult = await autoCommit(worktreePath, run.sourceBranch, commitSuffix)

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
 *
 * @param worktreePath - Path to the git worktree
 * @param sourceBranch - The source branch for diff comparison
 * @param commitSuffix - Optional suffix for the commit message (e.g., "milestone 1: Add feature X")
 */
async function autoCommit(worktreePath: string, sourceBranch: string, commitSuffix?: string): Promise<DevResult> {
  const execOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

  // Get the current branch name
  const branch = execSync('git rev-parse --abbrev-ref HEAD', execOpts).trim()

  // Stage all changes
  execSync('git add -A', execOpts)

  // Check if there's anything to commit
  const status = execSync('git status --porcelain', execOpts).trim()
  let commitSha: string

  if (status) {
    // Commit the changes with optional milestone info
    const commitMsg = commitSuffix
      ? `pipeline: dev agent implementation (${commitSuffix})`
      : 'pipeline: dev agent implementation'
    execSync(
      `git commit -m "${commitMsg}"`,
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
