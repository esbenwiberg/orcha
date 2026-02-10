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
import type { PipelineRun, StageResult, BlueprintOutput, BlueprintMilestone } from '../types.js'
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

// Export validation function for external use
export { isValidBlueprint }

// ============================================================================
// Blueprint Loading from File
// ============================================================================

/**
 * Parse a markdown blueprint with MINIMAL parsing + FULL context preservation.
 *
 * Philosophy:
 * - Extract only what's needed for orchestration (title, milestone count/boundaries)
 * - Preserve ENTIRE raw markdown for agents to interpret
 * - Keep full milestone text blocks (don't lose context from original blueprint)
 * - Agents are good at understanding context - don't over-structure
 *
 * What we extract:
 * - headline: For UI display
 * - milestoneCount: For progress tracking
 * - milestone boundaries: For iteration
 * - rawMarkdown: EVERYTHING (diagrams, rationale, architecture, examples)
 * - milestone.rawText: Full milestone section (not just description/details)
 *
 * What we DON'T need to parse perfectly:
 * - Risks, approach, files - agents can extract from rawMarkdown
 * - We still extract basic fields for backward compatibility
 */
export async function parseMarkdownBlueprint(markdown: string): Promise<BlueprintOutput> {
  const lines = markdown.split('\n')

  // Extract title - handle multiple formats:
  // 1. "# Blueprint: Title" (explicit)
  // 2. "# Title Implementation Blueprint" (natural)
  // 3. "# Title" (generic)
  let headline = 'Untitled Blueprint'
  const explicitMatch = markdown.match(/^#\s+Blueprint:\s+(.+)$/m)
  if (explicitMatch) {
    headline = explicitMatch[1].trim()
  } else {
    const genericMatch = markdown.match(/^#\s+(.+)$/m)
    if (genericMatch) {
      headline = genericMatch[1].trim()
        .replace(/\s+Implementation\s+Blueprint$/i, '') // Clean up "X Implementation Blueprint" -> "X"
        .replace(/\s+Blueprint$/i, '') // Clean up "X Blueprint" -> "X"
    }
  }

  // Extract milestone count
  const milestoneCountMatch = markdown.match(/\*\*Milestones:\s+(\d+)\*\*/i)
  const milestoneCount = milestoneCountMatch ? parseInt(milestoneCountMatch[1]) : 0

  // Extract Goal section
  const goalMatch = markdown.match(/##\s+Goal\s*\n+([\s\S]*?)(?=\n##|\n###|$)/i)
  const goal = goalMatch ? goalMatch[1].trim() : ''

  // Extract Acceptance Criteria
  const acMatch = markdown.match(/##\s+Acceptance Criteria\s*\n+([\s\S]*?)(?=\n##|\n###|$)/i)
  const acceptanceCriteria: string[] = []
  if (acMatch) {
    const acLines = acMatch[1].split('\n')
    for (const line of acLines) {
      const itemMatch = line.match(/^-\s+\[.\]\s+(.+)$/)
      if (itemMatch) {
        acceptanceCriteria.push(itemMatch[1].trim())
      }
    }
  }

  // Extract files to touch from Architecture or Key files sections
  const filesToTouch: string[] = []
  const keyFilesMatches = markdown.matchAll(/\*\*Key files:\*\*\s+(.+)/gi)
  for (const match of keyFilesMatches) {
    const files = match[1].split(',').map(f => f.trim().replace(/`/g, ''))
    filesToTouch.push(...files)
  }

  // Extract risks from Risks section if present
  const risksMatch = markdown.match(/##\s+Risks\s*(?:&\s*Probes)?\s*\n+([\s\S]*?)(?=\n##|\n###|$)/i)
  const risks: string[] = []
  if (risksMatch) {
    const riskLines = risksMatch[1].split('\n')
    for (const line of riskLines) {
      const itemMatch = line.match(/^[-*]\s+(.+)$/)
      if (itemMatch) {
        risks.push(itemMatch[1].trim())
      }
    }
  }
  if (risks.length === 0) {
    risks.push('No risks identified')
  }

  // Extract test strategy from Architecture or details
  const testStrategyMatch = markdown.match(/\*\*Verification:\*\*\s*\n+```[\s\S]*?```/i) ||
                           markdown.match(/##\s+Test(?:ing)?\s+Strategy\s*\n+([\s\S]*?)(?=\n##|\n###|$)/i)
  const testStrategy = testStrategyMatch ? 'See milestone verification steps' : 'Manual testing and review'

  // Extract milestones
  // KEY: We preserve the FULL raw text for each milestone (rawText field)
  // This includes everything: intent, details, verification, key files, etc.
  // Agents get the complete context, not just extracted fields.
  let milestones: BlueprintMilestone[] = []

  // Try format 1: ### M1:, ### M2:, etc. (common from /blueprint skill)
  const m1Regex = /###\s+M\d+:\s+(.+?)\s*\n+([\s\S]*?)(?=\n###\s+M\d+:|\n##\s+(?!#)|$)/gi
  let m1Match
  while ((m1Match = m1Regex.exec(markdown)) !== null) {
    const title = m1Match[1].trim()
    const body = m1Match[2].trim()
    const fullMatch = m1Match[0] // PRESERVE FULL TEXT

    const intentMatch = body.match(/\*\*Intent:\*\*\s+(.+?)(?:\n|$)/i)
    const intent = intentMatch ? intentMatch[1].trim() : ''

    const keyFilesMatch = body.match(/\*\*Key files:\*\*\s+(.+?)(?:\n|$)/i)
    const milestoneFiles: string[] = []
    if (keyFilesMatch) {
      const files = keyFilesMatch[1].split(',').map(f => f.trim().replace(/`/g, ''))
      milestoneFiles.push(...files)
    }

    const detailsMatch = body.match(/\*\*Details:\*\*\s*\n+([\s\S]*?)(?=\n\*\*Verification:|\n###|$)/i)
    const details = detailsMatch ? detailsMatch[1].trim() : body

    milestones.push({
      description: intent || title,
      details: details || `Implement: ${title}`,
      ...(milestoneFiles.length > 0 ? { filesToTouch: milestoneFiles } : {}),
      rawText: fullMatch, // FULL milestone section with ALL context
    })
  }

  // Try format 2: ## Milestone 1:, ## Milestone 2:, etc. (long-form)
  if (milestones.length === 0) {
    const m2Regex = /##\s+Milestone\s+\d+:\s+(.+?)\s*\n+([\s\S]*?)(?=\n##\s+Milestone\s+\d+:|\n##\s+(?!Milestone)|$)/gi
    let m2Match
    while ((m2Match = m2Regex.exec(markdown)) !== null) {
      const title = m2Match[1].trim()
      const body = m2Match[2].trim()
      const fullMatch = m2Match[0] // PRESERVE FULL TEXT

      const intentMatch = body.match(/\*\*Intent:\*\*\s+(.+?)(?:\n|$)/i)
      const intent = intentMatch ? intentMatch[1].trim() : ''

      const keyFilesMatch = body.match(/\*\*Key files:\*\*\s+(.+?)(?:\n|$)/i)
      const milestoneFiles: string[] = []
      if (keyFilesMatch) {
        const files = keyFilesMatch[1].split(',').map(f => f.trim().replace(/`/g, ''))
        milestoneFiles.push(...files)
      }

      const detailsMatch = body.match(/\*\*Details:\*\*\s*\n+([\s\S]*?)(?=\n\*\*|$)/i)
      const details = detailsMatch ? detailsMatch[1].trim() : body

      milestones.push({
        description: intent || title,
        details: details || `Implement: ${title}`,
        ...(milestoneFiles.length > 0 ? { filesToTouch: milestoneFiles } : {}),
        rawText: fullMatch, // FULL milestone section with ALL context
      })
    }
  }

  // Try format 3: ## M1:, ## M2:, etc. (short-form)
  if (milestones.length === 0) {
    const m3Regex = /##\s+M\d+:\s+(.+?)\s*\n+([\s\S]*?)(?=\n##\s+M\d+:|\n##\s+(?!M\d)|$)/gi
    let m3Match
    while ((m3Match = m3Regex.exec(markdown)) !== null) {
      const title = m3Match[1].trim()
      const body = m3Match[2].trim()
      const fullMatch = m3Match[0] // PRESERVE FULL TEXT

      milestones.push({
        description: title,
        details: body,
        rawText: fullMatch, // FULL milestone section with ALL context
      })
    }
  }

  // Try format 4: ### Phase A:, ### Phase B:, etc. (phases as milestones)
  if (milestones.length === 0 || milestones.length === 1) {
    const phaseRegex = /###\s+Phase\s+[A-Z\d]+:\s+(.+?)\s*(?:\([\d\s\-]+hours?\))?\s*\n+([\s\S]*?)(?=\n###\s+Phase\s+[A-Z\d]+:|\n##\s+|$)/gi
    let phaseMatch
    const phases: BlueprintMilestone[] = []
    while ((phaseMatch = phaseRegex.exec(markdown)) !== null) {
      const title = phaseMatch[1].trim()
      const body = phaseMatch[2].trim()
      const fullMatch = phaseMatch[0] // PRESERVE FULL TEXT

      phases.push({
        description: title,
        details: body,
        rawText: fullMatch, // FULL phase section with ALL context
      })
    }

    // If we found phases, use them instead of (or in addition to) the outer milestone
    if (phases.length > 1) {
      milestones = phases
    }
  }

  // Fallback: try generic ### headers under ## Milestones section
  if (milestones.length === 0) {
    const genericRegex = /###\s+(.+?)\s*\n+([\s\S]*?)(?=\n###|\n##\s+(?!#)|$)/gi
    let genericMatch
    while ((genericMatch = genericRegex.exec(markdown)) !== null) {
      const title = genericMatch[1].trim()
      const body = genericMatch[2].trim()
      const fullMatch = genericMatch[0] // PRESERVE FULL TEXT

      // Skip if this looks like a section header (Goal, Architecture, etc)
      if (body.length > 0 && !title.match(/^(Goal|Architecture|Risks|Test|Non-Goals|Acceptance)/i)) {
        milestones.push({
          description: title,
          details: body,
          rawText: fullMatch, // FULL milestone section with ALL context
        })
      }
    }
  }

  // Deduplicate files
  const uniqueFiles = [...new Set(filesToTouch)]

  // Build shortDescription with proper grammar
  const finalMilestoneCount = milestoneCount || milestones.length
  const milestoneLabel = finalMilestoneCount === 1 ? 'milestone' : 'milestones'
  const goalFirstLine = goal.split('\n')[0].trim()
  const shortDescription = goalFirstLine
    ? `${goalFirstLine}. ${finalMilestoneCount} ${milestoneLabel}.`
    : `${finalMilestoneCount} ${milestoneLabel}.`

  return {
    headline,
    shortDescription,
    approach: goal,
    filesToTouch: uniqueFiles,
    risks,
    testStrategy,
    milestones,
    rawMarkdown: markdown, // PRESERVE ENTIRE BLUEPRINT for agents
  }
}

/**
 * Load and validate a blueprint from a file (supports JSON or Markdown).
 *
 * @param blueprintPath - Absolute path to the blueprint file (.json or .md)
 * @returns Validated BlueprintOutput object
 * @throws Error if file cannot be read or blueprint is invalid
 */
export async function loadBlueprintFromFile(blueprintPath: string): Promise<BlueprintOutput> {
  const { readFile } = await import('fs/promises')
  const { extname } = await import('path')

  try {
    const content = await readFile(blueprintPath, 'utf-8')
    const ext = extname(blueprintPath).toLowerCase()

    let parsed: BlueprintOutput

    if (ext === '.md' || ext === '.markdown') {
      // Parse markdown blueprint
      parsed = await parseMarkdownBlueprint(content)
    } else if (ext === '.json') {
      // Parse JSON blueprint
      parsed = JSON.parse(content)
    } else {
      // Try JSON first, fall back to markdown
      try {
        parsed = JSON.parse(content)
      } catch {
        parsed = await parseMarkdownBlueprint(content)
      }
    }

    if (!isValidBlueprint(parsed)) {
      throw new Error('Blueprint validation failed: missing required fields or invalid structure')
    }

    return parsed as BlueprintOutput
  } catch (err) {
    if (err instanceof SyntaxError) {
      throw new Error(`Blueprint file contains invalid JSON: ${err.message}`)
    }
    throw err
  }
}

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
    // Handle singular/plural: "1 milestone" vs "2 milestones"
    // (Zero milestones cannot occur here — isValidBlueprint requires at least one)
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
 *
 * Validates that description and details are non-empty, non-whitespace strings.
 * Empty strings would pass type checks but cause downstream failures in the
 * dev stage which depends on these fields for milestone execution.
 *
 * Note: The typeof checks MUST come before trim() calls because:
 * 1. Non-strings would throw on trim() — so we check typeof first
 * 2. Once we know they're strings, we check they're not whitespace-only
 */
function isValidMilestoneObject(obj: unknown): boolean {
  if (typeof obj !== 'object' || obj === null) return false
  const m = obj as Record<string, unknown>
  // First check typeof to ensure we can safely call trim()
  if (typeof m.description !== 'string' || typeof m.details !== 'string') return false
  // Then check for non-empty, non-whitespace content
  const trimmedDesc = m.description.trim()
  const trimmedDetails = m.details.trim()
  return trimmedDesc.length > 0 && trimmedDetails.length > 0
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

  // Check if milestones field is valid (preferred field name)
  const milestonesValid = Array.isArray(bp.milestones) &&
    bp.milestones.length > 0 &&
    bp.milestones.every(isValidMilestoneObject)

  // Check if steps field is valid (backward compat alias for milestones)
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
