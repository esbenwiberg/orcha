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
import type { PipelineRun, GateResult, StageResult, AttemptHistoryEntry } from '../types.js'
import { transition, recordStageResult, incrementFixLoop, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { runStage } from '../stage-runner.js'
import { resolveModel, resolveBudget } from '../pipeline-config.js'
import { buildFixLoopPrompt } from '../prompt-builder.js'
import type { WorkItemContext, CodebaseContext } from '../prompt-builder.js'
import { getDiff } from '../git-utils.js'
import { appendProgress } from '../progress.js'
import { CircuitBreaker } from '../fix-loop/circuit-breaker.js'
import { savePipelineRun, loadPipelineRun } from '../pipeline-store.js'
import { EscalationManager } from '../escalation/escalation-manager.js'
import { buildEnhancedFixContext } from '../fix-loop/context-builder.js'
import { AttemptTracker } from '../fix-loop/attempt-tracker.js'
import { FailurePatternStore, detectPatternType, extractKeywords } from '../learning/failure-patterns.js'
import { createHash } from 'crypto'

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
    // Initialize circuit breaker from existing state (if any)
    const circuitBreaker = new CircuitBreaker(run.circuitBreakerState)

    // Compute failure signature from current gate results
    const failureSignature = circuitBreaker.computeSignature(run.gateResults)

    // Check if this is a repeated failure (before incrementing count)
    if (circuitBreaker.isRepeatedFailure(failureSignature)) {
      // Circuit breaker has tripped — escalate immediately
      await appendProgress(run.id, {
        type: 'info',
        stage: 'fix-loop',
        title: 'Circuit breaker triggered: repeated failure pattern detected',
        detail: failureSignature.description,
      }).catch(() => { /* best-effort */ })

      // Use escalation manager to record escalation state
      const escalationManager = new EscalationManager()
      await escalationManager.escalate(run.id, `Circuit breaker: ${failureSignature.description}`)

      // Reload from disk to pick up escalation field before transition overwrites
      run = (await loadPipelineRun(run.id))!
      run = await transition(run, 'escalated')
      return run
    }

    // Record this failure (increments count)
    const shouldEscalate = circuitBreaker.recordFailure(failureSignature)

    // Persist circuit breaker state
    const updatedRun: PipelineRun = {
      ...run,
      circuitBreakerState: circuitBreaker.getState(),
      updatedAt: new Date().toISOString(),
    }
    await savePipelineRun(updatedRun)
    run = updatedRun

    // Check if we should escalate due to circuit breaker
    if (shouldEscalate) {
      await appendProgress(run.id, {
        type: 'info',
        stage: 'fix-loop',
        title: 'Circuit breaker triggered: escalating due to repeated failures',
        detail: failureSignature.description,
      }).catch(() => { /* best-effort */ })

      // Use escalation manager to record escalation state
      const escalationManager = new EscalationManager()
      await escalationManager.escalate(run.id, `Circuit breaker: ${failureSignature.description}`)

      // Reload from disk to pick up escalation field before transition overwrites
      run = (await loadPipelineRun(run.id))!
      run = await transition(run, 'escalated')
      return run
    }

    // Check if we've exceeded max fix loops
    if (run.fixLoopCount >= maxFixLoops) {
      // Use escalation manager to record escalation state
      const escalationManager = new EscalationManager()
      await escalationManager.escalate(run.id, `Max fix loops exceeded (${maxFixLoops})`)

      // Reload from disk to pick up escalation field before transition overwrites
      run = (await loadPipelineRun(run.id))!
      run = await transition(run, 'escalated')
      return run
    }

    // Determine attempt number (pre-increment, for labeling)
    const attempt = run.fixLoopCount + 1

    // Emit progress for fix-loop iteration start
    await appendProgress(run.id, {
      type: 'fix-loop',
      stage: 'fix-loop',
      title: `Fix loop attempt ${attempt}/${maxFixLoops}`,
      data: { attempt, maxAttempts: maxFixLoops },
    }).catch(() => { /* best-effort */ })

    // Load the blueprint
    const blueprintPath = run.blueprintPath || join(getPipelineDir(run.id), 'blueprint.json')
    const blueprintJson = await readFile(blueprintPath, 'utf-8')

    // Get the current diff
    const diff = getDiff(run.worktreePath, run.sourceBranch, run.baseCommit) ?? '(unable to generate diff)'

    // Build failure report from gate results
    const failureReport = buildFailureReport(run.gateResults)

    // Build enhanced context for fix agent
    const enhancedContext = await buildEnhancedFixContext(run, run.gateResults)

    // Load and query failure pattern store
    const patternStore = new FailurePatternStore()
    await patternStore.load()

    const patternType = detectPatternType(run.gateResults)
    const similarPatterns = patternStore.findSimilarPatterns(run.gateResults)
    const successfulFixes = patternStore.getSuccessfulFixes(patternType)

    // Format successful fix examples for prompt
    let successfulFixExamples: string | undefined
    if (successfulFixes.length > 0) {
      successfulFixExamples = successfulFixes.map((fix, i) => {
        return [
          `**Example ${i + 1}**: ${fix.description}`,
          `- Approach: ${fix.approach}`,
          `- Files: ${fix.filesModified.join(', ')}`,
        ].join('\n')
      }).join('\n\n')
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

    // Build the fix prompt with enhanced context
    const { systemPrompt, userPrompt: baseUserPrompt } = await buildFixLoopPrompt(workItem, codebase, {
      blueprintJson,
      diff,
      failureReport,
      attempt,
      maxAttempts: maxFixLoops,
      enhancedContext: {
        ...enhancedContext,
        successfulFixExamples,
      },
    })

    // Inject user instructions if provided (from retry-escalated)
    const userPrompt = run.userInstructions
      ? `${baseUserPrompt}\n\n# Additional Instructions from User\n${run.userInstructions}`
      : baseUserPrompt

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

    // Increment fix loop counter only after the stage ran successfully
    run = await incrementFixLoop(run)

    // Get the diff after fix (before commit)
    const fixDiff = getDiff(run.worktreePath, run.sourceBranch, run.baseCommit) ?? ''

    // Track this attempt
    const attemptTracker = new AttemptTracker()
    attemptTracker.recordAttempt(attempt, failureReport, fixDiff)

    // Auto-commit fix changes
    const commitResult = await autoCommitFix(run.worktreePath, attempt)

    // Save fix loop artifacts
    const fixDir = join(getPipelineDir(run.id), 'fix-loops', `attempt-${attempt}`)
    await mkdir(fixDir, { recursive: true })

    const attemptMeta = {
      attempt,
      commitSha: commitResult.commitSha,
      model: result.model,
      budget: result.budget,
      failureReport,
      startedAt,
      completedAt: new Date().toISOString(),
      // Gate results will be populated after gate re-runs (not yet available here)
      attemptSummary: attemptTracker.getHistory()[0]?.summary,
    }

    await writeFile(
      join(fixDir, 'meta.json'),
      JSON.stringify(attemptMeta, null, 2),
      'utf-8',
    )

    // Record failure pattern for learning (will be marked as successful if next gate passes)
    // The pattern is recorded now but won't include the successful fix until gate confirms it worked
    const keywords = extractKeywords(run.gateResults)
    const signature = createHash('sha256')
      .update(`${patternType}:${run.gateResults[0]?.checkName}:${run.gateResults[0]?.summary.split('\n')[0]}`)
      .digest('hex')
      .slice(0, 16)

    patternStore.recordPattern({
      patternType,
      signature,
      checkName: run.gateResults[0]?.checkName ?? 'unknown',
      language: detectLanguageFromFiles(Object.keys(enhancedContext.fullFileContents)),
      keywords,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
      // successfulFix will be added later if gate passes
    })

    await patternStore.save()

    // Emit progress for fix-loop completion
    await appendProgress(run.id, {
      type: 'fix-loop',
      stage: 'fix-loop',
      title: `Fix loop attempt ${attempt} completed`,
      detail: `Committed ${commitResult.commitSha}`,
      data: { attempt, commitSha: commitResult.commitSha, model: result.model },
    }).catch(() => { /* best-effort */ })

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
  const passing = gateResults.filter((r) => r.verdict === 'pass')

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
      try {
        lines.push(JSON.stringify(f.details, null, 2))
      } catch {
        lines.push('(details could not be serialized)')
      }
      lines.push('```')
    }
    return lines.join('\n')
  })

  const passingWarning = passing.length > 0
    ? [
        '',
        `# Passing Checks (DO NOT REGRESS)`,
        `The following checks are currently PASSING. Do NOT make changes that would break them:`,
        ...passing.map((p) => `- **${p.checkName}**: ${p.summary}`),
      ]
    : []

  return [
    `# Gate Failures (${failures.length} check(s) failed)`,
    '',
    ...sections,
    ...passingWarning,
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

/**
 * Detect programming language from file paths.
 */
function detectLanguageFromFiles(files: string[]): string | undefined {
  for (const file of files) {
    if (file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.js') || file.endsWith('.jsx')) {
      return 'typescript'
    }
    if (file.endsWith('.py')) {
      return 'python'
    }
    if (file.endsWith('.cs') || file.endsWith('.fs')) {
      return 'csharp'
    }
    if (file.endsWith('.go')) {
      return 'go'
    }
    if (file.endsWith('.rs')) {
      return 'rust'
    }
    if (file.endsWith('.java')) {
      return 'java'
    }
  }
  return undefined
}
