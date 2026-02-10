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
import { getBlueprintMilestones } from '../types.js'
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
 * Each milestone is executed with a FRESH Claude session to prevent context
 * pollution and reduce costs. For large tasks, divide into focused milestones
 * (single responsibility, implementable independently).
 *
 * The 'steps' field is supported for backward compatibility, but 'milestones'
 * is the preferred field name.
 */
export const BLUEPRINT_SCHEMA = {
  type: 'object' as const,
  properties: {
    headline: {
      type: 'string' as const,
      description: 'Short, clear title for the plan (e.g. "Add User Authentication")',
    },
    shortDescription: {
      type: 'string' as const,
      description: 'Summary including the milestone count (e.g. "Implements X with Y milestones"). MUST explicitly state the number of milestones.',
    },
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
    milestones: {
      type: 'array' as const,
      minItems: 1,
      items: {
        type: 'object' as const,
        properties: {
          description: { type: 'string' as const },
          details: { type: 'string' as const },
          filesToTouch: {
            type: 'array' as const,
            items: { type: 'string' as const },
            description: 'Optional: subset of files this milestone touches',
          },
        },
        required: ['description', 'details'],
      },
      description: 'Ordered implementation milestones. Each milestone should be independently implementable with a focused scope (single responsibility). For large tasks, create discrete milestones that run with fresh context. MUST contain at least one milestone.',
    },
    steps: {
      type: 'array' as const,
      minItems: 1,
      items: {
        type: 'object' as const,
        properties: {
          description: { type: 'string' as const },
          details: { type: 'string' as const },
        },
        required: ['description', 'details'],
      },
      description: '(Deprecated - use milestones instead) Backward compatibility alias for milestones. MUST contain at least one step.',
    },
  },
  // Schema requires the core fields. For milestones vs steps, we use anyOf to express
  // "at least one must be present with at least one item". The minItems: 1 on both arrays
  // ensures the schema enforces non-empty arrays, matching isValidBlueprint's validation.
  required: ['headline', 'shortDescription', 'approach', 'filesToTouch', 'risks', 'testStrategy'],
  anyOf: [
    { required: ['milestones'] },
    { required: ['steps'] },
  ],
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
  const { systemPrompt, userPrompt } = await buildArchitectPrompt(workItem, codebase, learningHints)

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
    const milestoneCount = getBlueprintMilestones(blueprint).length
    // Handle singular/plural correctly: "1 milestone" vs "0 milestones" / "2 milestones"
    // Note: Zero milestones should not occur (validation requires >= 1), but handle gracefully
    const milestoneSuffix = milestoneCount === 1 ? 'milestone' : 'milestones'
    const stageResult: StageResult = {
      stage: 'architect',
      startedAt,
      completedAt,
      model: result.model,
      output: `${blueprint.headline} — ${milestoneCount} ${milestoneSuffix}, ${blueprint.filesToTouch.length} files`,
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

/**
 * Validate that a milestone/step object has the required fields.
 */
function isValidMilestoneObject(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) return false
  const m = obj as Record<string, unknown>
  return typeof m.description === 'string' && typeof m.details === 'string'
}

function isValidBlueprint(obj: unknown): obj is BlueprintOutput {
  if (typeof obj !== 'object' || obj === null) return false
  const bp = obj as Record<string, unknown>

  // Validate core required fields
  const hasRequiredFields =
    typeof bp.headline === 'string' &&
    typeof bp.shortDescription === 'string' &&
    typeof bp.approach === 'string' &&
    Array.isArray(bp.filesToTouch) &&
    Array.isArray(bp.risks) &&
    typeof bp.testStrategy === 'string'

  if (!hasRequiredFields) return false

  // Check if milestones field is present and valid
  const milestonesPresent = 'milestones' in bp
  const milestonesValid = Array.isArray(bp.milestones) &&
    bp.milestones.length > 0 &&
    bp.milestones.every(isValidMilestoneObject)

  // Check if steps field is present and valid (backward compat)
  const stepsPresent = 'steps' in bp
  const stepsValid = Array.isArray(bp.steps) &&
    bp.steps.length > 0 &&
    bp.steps.every(isValidMilestoneObject)

  // Schema semantics: anyOf requires at least one of milestones OR steps to be valid.
  // This matches JSON Schema anyOf: if at least one option is satisfied, validation passes.
  //
  // Logic:
  // - At least one of milestones or steps must be present AND valid
  // - A "valid" array means: is an Array, has length > 0, all items pass isValidMilestoneObject
  // - If a field is present but invalid (empty array or bad items), we still pass if the OTHER field is valid
  //   (this is standard anyOf behavior - we only need one to match)
  //
  // Edge cases:
  // - milestones=[] and steps=[...valid...] → PASS (steps satisfies anyOf)
  // - milestones=[...valid...] and steps=[] → PASS (milestones satisfies anyOf)
  // - milestones=[] and steps=[] → FAIL (neither satisfies)
  // - neither present → FAIL
  if (milestonesValid || stepsValid) {
    // At least one valid array present — anyOf satisfied
    return true
  }

  // Neither field is valid (either not present, empty, or has invalid items) — fail
  return false
}
