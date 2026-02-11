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
import { spawnResult } from '../exec-utils.js'
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
// Helpers
// ============================================================================

/**
 * Sanitize a string for use in git commit messages.
 * Uses a WHITELIST approach - only allows safe characters.
 * This is defense-in-depth; the primary protection is using spawnResult with
 * array arguments (which avoids shell interpolation entirely).
 *
 * SECURITY NOTE: Even though we use spawnResult for git commits (which is safe),
 * this sanitization provides defense-in-depth in case the message is ever
 * logged, displayed, or used in other contexts.
 */
function sanitizeForGitMessage(input: string): string {
  // WHITELIST approach: only allow known-safe characters
  // Allowed: alphanumeric, spaces, basic punctuation (.-_:,!?'), common brackets
  // This is more restrictive but much safer than trying to blacklist dangerous chars
  return input
    .replace(/[^a-zA-Z0-9 .\-_:,!?'()\[\]]/g, '') // Remove anything not in whitelist
    .replace(/\s+/g, ' ')                          // Normalize whitespace
    .trim()                                        // Remove leading/trailing whitespace
    .slice(0, 200)                                 // Limit length
}

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

    // Extract raw markdown for full context (if available)
    const rawMarkdown = blueprint.rawMarkdown

    // Get milestones from blueprint (supports both 'milestones' and 'steps')
    const milestones = getBlueprintMilestones(blueprint)

    // Validate that blueprint has at least one milestone
    if (milestones.length === 0) {
      return await transitionToError(run, 'Blueprint has no milestones or steps defined. Cannot proceed with dev stage.')
    }

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

    // If recovering from a failed milestone, remove any error entries for that milestone
    // to avoid duplicate entries in milestoneHistory when the milestone is retried
    if (startingMilestoneIndex > 0 && run.milestoneHistory && run.milestoneHistory.length > 0) {
      const lastEntry = run.milestoneHistory[run.milestoneHistory.length - 1]
      if (lastEntry.index === startingMilestoneIndex && lastEntry.error) {
        // Remove the failed entry - we're retrying this milestone
        run = {
          ...run,
          milestoneHistory: run.milestoneHistory.slice(0, -1),
        }
        await savePipelineRun(run)
      }
    }

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

      // Build milestone-specific prompt (FRESH context for each milestone)
      const milestoneContext: MilestoneContext = {
        blueprintJson,
        rawMarkdown, // Full blueprint context
        milestoneIndex: i,
        totalMilestones: milestones.length,
        milestoneDescription: milestone.description,
        milestoneDetails: milestone.details,
        milestoneFilesToTouch: milestone.filesToTouch,
        milestoneRawText: milestone.rawText, // Full milestone section with ALL context
      }

      const { systemPrompt, userPrompt } = await buildMilestoneDevPrompt(workItem, codebase, milestoneContext)

      // Report milestone start AFTER successful prompt build
      // (If prompt building fails, we don't want to mislead by saying "Starting milestone")
      await appendProgress(run.id, {
        type: 'info',
        stage: 'dev',
        title: `Starting milestone ${i + 1}/${milestones.length}: ${milestone.description}`,
        data: { milestoneIndex: i, description: milestone.description },
      }).catch(() => { /* best-effort */ })

      // AC #1: Run the milestone with a FRESH Claude session (clean context per milestone)
      // Each milestone gets a unique stageKey which ensures a completely new session is spawned.
      // This prevents context pollution between milestones and reduces token costs.
      const result = await runStage({
        pipelineId: run.id,
        stageKey: `dev-milestone-${i}`, // Unique key = fresh session
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
    const finalDiff = await getDiff(run.worktreePath, run.sourceBranch)

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
  // Extract rawMarkdown from the blueprint for full context
  const blueprint: BlueprintOutput = JSON.parse(blueprintJson)
  const { systemPrompt, userPrompt } = await buildDevPrompt(workItem, codebase, {
    blueprintJson,
    rawMarkdown: blueprint.rawMarkdown,
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
// Helper: Get Diff
// ============================================================================

/**
 * Get the diff from sourceBranch to HEAD using merge-base (three-dot) semantics.
 *
 * SECURITY: Uses spawnResult with array arguments to avoid shell command injection.
 * Additionally, we use '--' to separate git options from ref arguments, preventing
 * git flag injection attacks where a malicious branch name like '--help' or
 * '--exec=evil' could be interpreted as a git option.
 */
async function getDiff(worktreePath: string, sourceBranch: string): Promise<string> {
  const spawnOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

  // SECURITY: Validate branch name doesn't contain path traversal sequences
  // that could be used for injection (e.g., '../--exec=evil', '..', etc.)
  if (sourceBranch.includes('..')) {
    throw new Error('Invalid branch name: contains path traversal sequence')
  }
  const sanitizedBranch = sourceBranch

  // Compute the merge-base SHA first, then diff against it.
  // This is equivalent to `git diff sourceBranch...HEAD` but safer because
  // the merge-base SHA is a hex string that can't be misinterpreted as a flag.
  //
  // Try branch name directly first, then with origin/ prefix, then common defaults.
  // SECURITY: Use '--' to separate options from arguments. This tells git that
  // everything after '--' is a ref/path, not an option. This prevents flag
  // injection attacks where a branch named '--help' would be interpreted as an option.
  const candidates = [sanitizedBranch, `origin/${sanitizedBranch}`, 'origin/main', 'origin/master']
  for (const ref of candidates) {
    // '--' ensures 'ref' is treated as a revision, not a flag
    const mbResult = await spawnResult('git', ['merge-base', '--', ref, 'HEAD'], spawnOpts)
    if (mbResult.status === 0 && mbResult.stdout) {
      const mergeBase = mbResult.stdout.trim()
      const diffResult = await spawnResult('git', ['diff', '--', mergeBase, 'HEAD'], spawnOpts)
      if (diffResult.status === 0) {
        return (diffResult.stdout || '').trim()
      }
    }
  }

  // Fall back to diff against previous commit
  const fallback = await spawnResult('git', ['diff', '--', 'HEAD~1'], spawnOpts)
  return (fallback.stdout || '').trim()
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
 * 1. Competition is fair (all agents start from same state for each milestone)
 * 2. Context is fresh for each milestone (no pollution from previous conversations)
 * 3. Parallelism happens WITHIN milestones (N agents), not ACROSS milestones
 *
 * Why milestones are sequential but competing agents are parallel:
 * - Milestones have sequential dependencies (M2 builds on M1's file changes)
 * - Competing agents work on the SAME milestone, so they're independent
 * - Each agent gets a fresh worktree branched from the same commit
 * - After gate selects a winner, that code becomes the base for next milestone
 * - Fresh context per milestone prevents conversation bloat and reduces costs
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

    // Extract raw markdown for full context (if available)
    const rawMarkdown = blueprint.rawMarkdown

    // Get milestones from blueprint
    const milestones = getBlueprintMilestones(blueprint)

    // Validate that blueprint has at least one milestone
    if (milestones.length === 0) {
      return await transitionToError(run, 'Blueprint has no milestones or steps defined. Cannot proceed with dev stage.')
    }

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
      run = await runCompetingAgentsOnMilestone(
        run, count, blueprintJson, workItem, codebase, opts, startedAt, null
      )
      if (run.state === 'error') return run
      run = await transition(run, 'gate')
      return run
    }

    // DESIGN DECISION: Multi-milestone competing mode
    // In competing mode with multiple milestones, we run all agents on the FIRST
    // milestone only, then let gate evaluate and select a winner. The winning
    // agent's worktree becomes the base for subsequent milestones (non-competing).
    // This is because:
    // 1. Running N agents for M milestones would create N*M worktrees (expensive)
    // 2. Without winner selection between milestones, results would conflict
    // 3. The competing feature is meant to find the best APPROACH, not repeat it
    //
    // For truly parallel milestone execution, use --competing 1 (default) and
    // the milestone-based sequential execution, which gives fresh context per milestone.

    await appendProgress(run.id, {
      type: 'info',
      stage: 'dev',
      title: `Starting competing dev for milestone 1/${milestones.length} (${count} agents)`,
      data: {
        totalMilestones: milestones.length,
        agentsPerMilestone: count,
        note: 'Competing agents run on first milestone; gate will select winner for remaining milestones',
      },
    }).catch(() => { /* best-effort */ })

    // Run competing agents on the FIRST milestone only
    const milestoneStartedAt = new Date().toISOString()

    // Update current milestone index
    run = {
      ...run,
      currentMilestoneIndex: startingMilestoneIndex,
      updatedAt: new Date().toISOString(),
    }
    await savePipelineRun(run)

    const milestone = milestones[startingMilestoneIndex]

    await appendProgress(run.id, {
      type: 'competing-start',
      stage: 'dev',
      title: `Starting ${count} competing agents for milestone ${startingMilestoneIndex + 1}/${milestones.length}`,
      data: { milestoneIndex: startingMilestoneIndex, count, description: milestone.description },
    }).catch(() => { /* best-effort */ })

    // Build milestone context for the first milestone
    const milestoneContext: MilestoneContext = {
      blueprintJson,
      rawMarkdown, // Full blueprint context
      milestoneIndex: startingMilestoneIndex,
      totalMilestones: milestones.length,
      milestoneDescription: milestone.description,
      milestoneDetails: milestone.details,
      milestoneFilesToTouch: milestone.filesToTouch,
      milestoneRawText: milestone.rawText, // Full milestone section with ALL context
    }

    // Run competing agents on first milestone (worktrees are NOT cleaned up yet)
    run = await runCompetingAgentsOnMilestone(
      run, count, blueprintJson, workItem, codebase, opts, startedAt, milestoneContext
    )

    // If we hit an error, stop
    if (run.state === 'error') {
      return run
    }

    // Record first milestone completion
    const firstSuccessfulResult = run.competingResults?.find((r) => r.commitSha !== '')
    const milestoneProgress: MilestoneProgress = {
      index: startingMilestoneIndex,
      startedAt: milestoneStartedAt,
      completedAt: new Date().toISOString(),
      commitSha: firstSuccessfulResult?.commitSha,
    }
    run = {
      ...run,
      milestoneHistory: [...(run.milestoneHistory || []), milestoneProgress],
      // Store info about remaining milestones for gate to handle after winner selection
      pendingMilestoneCount: milestones.length - startingMilestoneIndex - 1,
    }
    await savePipelineRun(run)

    // Record dev stage result
    const completedAt = new Date().toISOString()
    const stageResult: StageResult = {
      stage: 'dev',
      startedAt,
      completedAt,
      output: `${run.competingResults?.length ?? 0} competing agents completed milestone 1/${milestones.length}; ${milestones.length - 1} milestones pending`,
    }
    run = await recordStageResult(run, stageResult)

    // Transition to gate
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
 * AC #2: Run N competing agents in PARALLEL on a single milestone.
 *
 * This function spawns N dev agents that work simultaneously on the same milestone.
 * Each agent gets its own worktree and fresh context. The gate stage later evaluates
 * all results and selects a winner.
 *
 * @param count - Number of parallel agents to spawn (from --competing N flag)
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

  // Spawn N agents in PARALLEL - each gets its own worktree and runs concurrently
  for (let i = 0; i < count; i++) {
    agentPromises.push(
      runCompetingAgent(run, i, blueprintJson, workItem, opts, milestoneContext).then(
        (result) => {
          // THREAD-SAFETY NOTE: Array.push() is safe here because JavaScript is
          // single-threaded. Even though these promises run concurrently, each
          // .then() callback executes atomically on the event loop. The sort
          // and filter operations below only run AFTER Promise.all() completes,
          // when all pushes are done. Do NOT add any shared state mutations
          // beyond this push without careful consideration.
          competingResults.push(result)
        },
        (err) => {
          // Record failed agent but don't abort the whole stage
          console.error(`Competing agent ${i} (${milestoneLabel}) failed:`, (err as Error).message)
          const suffix = milestoneContext ? `-m${milestoneContext.milestoneIndex}` : ''
          competingResults.push({
            agentIndex: i,
            branch: `pipeline/${run.id}-dev-${i}${suffix}`,
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

  // Wait for all parallel agents to complete (AC #2: parallel dev agents)
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

  // IMPORTANT: Do NOT clean up worktrees here!
  // The gate stage needs access to the worktrees to evaluate competing agents.
  // Gate is responsible for cleanup after selecting a winner.
  // The worktreePath is stored in each CompetingResult for gate to use.

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

  // SECURITY: Use spawnResult with array args to avoid command injection via
  // malicious run.id values that could craft dangerous branchName or worktreePath.
  // Create a new branch from the current pipeline branch and add worktree
  const worktreeResult = await spawnResult('git', ['worktree', 'add', '-b', branchName, worktreePath, 'HEAD'], {
    cwd: run.worktreePath,
    encoding: 'utf-8',
    timeout: 30000,
  })
  if (worktreeResult.status !== 0) {
    throw new Error(`Failed to create worktree: ${worktreeResult.stderr || 'unknown error'}`)
  }

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
      const prompts = await buildMilestoneDevPrompt(workItem, codebase, milestoneContext)
      systemPrompt = prompts.systemPrompt
      userPrompt = prompts.userPrompt
    } else {
      // Full blueprint prompt (single milestone or legacy mode)
      const prompts = await buildDevPrompt(workItem, codebase, { blueprintJson })
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

    // Note: worktree is intentionally kept on success - the gate stage needs it
    // to evaluate the agent's work. The gate stage is responsible for cleanup
    // after evaluation, or runCompetingAgentsOnMilestone cleans up after all
    // agents complete and results are saved.
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
    // SECURITY: Use spawnResult with array args to avoid command injection via worktreePath
    try {
      await spawnResult('git', ['worktree', 'remove', '--force', worktreePath], {
        cwd: run.worktreePath,
        encoding: 'utf-8',
        timeout: 30000,
      })
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
  const spawnOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

  // Get the current branch name
  const branchResult = await spawnResult('git', ['rev-parse', '--abbrev-ref', 'HEAD'], spawnOpts)
  const branch = (branchResult.stdout || '').trim()

  // Stage all changes
  await spawnResult('git', ['add', '-A'], spawnOpts)

  // Check if there's anything to commit
  const statusResult = await spawnResult('git', ['status', '--porcelain'], spawnOpts)
  const status = (statusResult.stdout || '').trim()
  let commitSha: string

  if (status) {
    // Build commit message safely
    const baseMsg = 'pipeline: dev agent implementation'
    const commitMsg = commitSuffix
      ? `${baseMsg} (${sanitizeForGitMessage(commitSuffix)})`
      : baseMsg

    const commitResult = await spawnResult('git', ['commit', '-m', commitMsg], spawnOpts)

    if (commitResult.status !== 0 && commitResult.status !== null) {
      const stderr = commitResult.stderr || ''
      if (!stderr.includes('nothing to commit')) {
        throw new Error(`git commit failed: ${stderr}`)
      }
    }
  }

  const shaResult = await spawnResult('git', ['rev-parse', 'HEAD'], spawnOpts)
  commitSha = (shaResult.stdout || '').trim()

  const diff = await getDiff(worktreePath, sourceBranch)

  return { diff, branch, commitSha }
}
