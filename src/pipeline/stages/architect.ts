/**
 * Architect Stage
 *
 * Runs the architect agent to produce an implementation blueprint.
 *
 * Steps:
 * 1. Build the architect prompt via prompt-builder
 * 2. Define the JSON schema for structured output
 * 3. Run via stage-runner with read-only tools
 * 4. Parse and validate the JSON output
 * 5. Save blueprint to ~/.orcha/pipelines/{id}/blueprint.json
 * 6. Transition state to checkpoint:arch
 */

import { writeFile } from 'fs/promises'
import { join } from 'path'
import type { PipelineRun, StageResult, BlueprintOutput } from '../types.js'
import { transition, recordStageResult, transitionToError } from '../pipeline-engine.js'
import { getPipelineDir } from '../pipeline-store.js'
import { runStage } from '../stage-runner.js'
import { buildArchitectPrompt } from '../prompt-builder.js'
import type { WorkItemContext, CodebaseContext } from '../prompt-builder.js'
import { getRelevantHints } from '../learning-store.js'
import { parseStructuredOutput } from '../output-parser.js'

// ============================================================================
// Blueprint JSON Schema
// ============================================================================

/**
 * JSON schema for the architect's blueprint output.
 * Used with --output-format json to get structured responses.
 *
 * DESIGN DECISION: Milestones execute SEQUENTIALLY, not in parallel.
 * Rationale:
 * 1. Milestones typically have sequential dependencies (M2 builds on M1 changes)
 * 2. Parallel execution would require complex merge conflict resolution
 * 3. The competing agents feature already provides parallelism for the same work unit
 *
 * The 'steps' field is supported for backward compatibility, but 'milestones'
 * is the preferred field name. Each milestone is executed with a FRESH Claude
 * session to prevent context pollution and reduce costs.
 */
export const BLUEPRINT_SCHEMA = {
  type: 'object' as const,
  properties: {
    approach: {
      type: 'string' as const,
      description: 'High-level description of the implementation approach',
    },
    filesToTouch: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Array of file paths that need to be created or modified',
    },
    risks: {
      type: 'array' as const,
      items: { type: 'string' as const },
      description: 'Array of potential risks or concerns',
    },
    testStrategy: {
      type: 'string' as const,
      description: 'How to test the changes',
    },
    steps: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        properties: {
          description: { type: 'string' as const },
          details: { type: 'string' as const },
        },
        required: ['description', 'details'],
      },
      description: 'Ordered implementation steps (alias for milestones, for backward compatibility)',
    },
  },
  required: ['approach', 'filesToTouch', 'risks', 'testStrategy', 'steps'],
}

// Re-export BlueprintOutput from types.ts for backward compatibility
export type { BlueprintOutput } from '../types.js'

// ============================================================================
// Architect Stage Runner
// ============================================================================

export interface ArchitectOptions {
  /** Override model for the architect (takes precedence over config). */
  modelOverride?: string
  /** Override budget for the architect (takes precedence over config). */
  budgetOverride?: number
}

/**
 * Execute the architect stage for a pipeline run.
 *
 * Expects the pipeline to be in 'architect' state. On success, transitions
 * to 'checkpoint:arch' and saves the blueprint. On failure, transitions to 'error'.
 *
 * Returns the updated PipelineRun.
 */
export async function runArchitectStage(
  run: PipelineRun,
  opts?: ArchitectOptions,
): Promise<PipelineRun> {
  const startedAt = new Date().toISOString()

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

  // Query learning store for relevant hints from past pipeline runs
  let learningHints: string[] = []
  try {
    const hints = await getRelevantHints(run.description, run.sourceBranch)
    learningHints = hints.map((h) => h.hint)
  } catch {
    // Best-effort: if learning store fails, proceed without hints
  }

  // Build the prompt (with learning hints if available)
  const { systemPrompt, userPrompt } = buildArchitectPrompt(workItem, codebase, learningHints)

  try {
    // Run the architect stage
    const result = await runStage({
      pipelineId: run.id,
      stageKey: 'architect',
      config: run.config,
      cwd: run.worktreePath,
      prompt: userPrompt,
      systemPrompt,
      allowedTools: 'Read,Grep,Glob',
      outputFormat: 'json',
      modelOverride: opts?.modelOverride,
      budgetOverride: opts?.budgetOverride,
    })

    if (!result.success) {
      const errorMsg = `Architect stage failed (exit code ${result.exitCode}): ${result.stderr.slice(0, 500)}`
      run = await transitionToError(run, errorMsg)
      return run
    }

    // Parse the blueprint output
    const blueprint = parseArchitectOutput(result.stdout)

    if (!blueprint) {
      const errorMsg = 'Architect stage produced invalid or unparseable output'
      run = await transitionToError(run, errorMsg)
      return run
    }

    // Save blueprint to disk
    const pipelineDir = getPipelineDir(run.id)
    const blueprintPath = join(pipelineDir, 'blueprint.json')
    await writeFile(blueprintPath, JSON.stringify(blueprint, null, 2), 'utf-8')

    // Record the stage result
    const completedAt = new Date().toISOString()
    const stageResult: StageResult = {
      stage: 'architect',
      startedAt,
      completedAt,
      model: result.model,
      output: `${blueprint.approach} (${blueprint.steps.length} steps, ${blueprint.filesToTouch.length} files)`,
    }
    run = await recordStageResult(run, stageResult)

    // Update the blueprint path on the run
    run = { ...run, blueprintPath }

    // Transition to checkpoint:arch
    run = await transition(run, 'checkpoint:arch')

    return run
  } catch (err) {
    const errorMsg = `Architect stage error: ${(err as Error).message}`
    try {
      run = await transitionToError(run, errorMsg)
    } catch {
      // If we can't even transition to error (e.g. already in error), just set it
      run = { ...run, state: 'error', error: errorMsg }
    }
    return run
  }
}

// ============================================================================
// Output Parsing
// ============================================================================

function parseArchitectOutput(stdout: string): BlueprintOutput | null {
  return parseStructuredOutput(stdout, isValidBlueprint)
}

function isValidBlueprint(obj: unknown): obj is BlueprintOutput {
  if (typeof obj !== 'object' || obj === null) return false
  const bp = obj as Record<string, unknown>
  // Support both 'milestones' (preferred) and 'steps' (backward compat)
  const hasMilestones = Array.isArray(bp.milestones) || Array.isArray(bp.steps)
  return (
    typeof bp.approach === 'string' &&
    Array.isArray(bp.filesToTouch) &&
    Array.isArray(bp.risks) &&
    typeof bp.testStrategy === 'string' &&
    hasMilestones
  )
}
