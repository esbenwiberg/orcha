/**
 * Gate Agent: AC Validator
 *
 * AI-powered gate agent that compares the dev agent's code changes (git diff)
 * against the acceptance criteria from the work item.
 *
 * Uses Claude via stage-runner in print mode to analyze the diff and produce
 * a structured pass/fail verdict.
 */

import { execSync } from 'child_process'
import type { PipelineRun, GateResult } from '../types.js'
import { runStage } from '../stage-runner.js'
import { resolveModel, resolveBudget } from '../pipeline-config.js'
import { buildAcValidatorPrompt } from '../prompt-builder.js'
import type { WorkItemContext } from '../prompt-builder.js'

// ============================================================================
// AC Validator
// ============================================================================

export interface AcValidatorOptions {
  modelOverride?: string
  budgetOverride?: number
}

/**
 * Run the AC validator gate agent.
 *
 * Fetches the git diff, sends it to Claude along with the acceptance criteria,
 * and returns a structured GateResult.
 */
export async function runAcValidator(
  run: PipelineRun,
  opts?: AcValidatorOptions,
): Promise<GateResult> {
  const timestamp = new Date().toISOString()

  // If no acceptance criteria, skip
  if (run.acceptanceCriteria.length === 0) {
    return {
      verdict: 'skip',
      checkName: 'ac-validator',
      summary: 'No acceptance criteria defined — skipping AC validation',
      details: { reason: 'no-acceptance-criteria' },
      timestamp,
    }
  }

  // Get the diff from the dev stage
  const diff = getDiff(run.worktreePath, run.sourceBranch)
  if (!diff) {
    return {
      verdict: 'skip',
      checkName: 'ac-validator',
      summary: 'No diff found — skipping AC validation',
      details: { reason: 'no-diff' },
      timestamp,
    }
  }

  // Build work item context
  const workItem: WorkItemContext = {
    workItemId: run.workItemId,
    description: run.description,
    acceptanceCriteria: run.acceptanceCriteria,
  }

  // Build the AC validator prompt
  const { systemPrompt, userPrompt } = buildAcValidatorPrompt(workItem, { diff })

  try {
    // Run Claude to evaluate ACs
    // Use 'gate-ac-validator' as stageKey for unique log naming,
    // but resolve model/budget from 'gate' config key.
    const result = await runStage({
      pipelineId: run.id,
      stageKey: 'gate-ac-validator',
      config: run.config,
      cwd: run.worktreePath,
      prompt: userPrompt,
      systemPrompt,
      allowedTools: 'Read,Grep,Glob',
      modelOverride: opts?.modelOverride ?? resolveModel(run.config, 'gate'),
      budgetOverride: opts?.budgetOverride ?? resolveBudget(run.config, 'gate'),
    })

    if (!result.success) {
      return {
        verdict: 'fail',
        checkName: 'ac-validator',
        summary: `AC validator session failed (exit code ${result.exitCode})`,
        details: { error: result.stderr.slice(0, 1000) },
        timestamp,
      }
    }

    // Parse the verdict from the output
    return parseAcVerdict(result.stdout, timestamp)
  } catch (err) {
    return {
      verdict: 'fail',
      checkName: 'ac-validator',
      summary: `AC validator error: ${(err as Error).message}`,
      details: { error: (err as Error).message },
      timestamp,
    }
  }
}

// ============================================================================
// Diff Retrieval
// ============================================================================

function getDiff(worktreePath: string, sourceBranch: string): string | null {
  const execOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 10000 }

  try {
    const diff = execSync(`git diff origin/${sourceBranch}...HEAD`, execOpts).trim()
    if (diff) return diff
  } catch {
    // origin/sourceBranch may not exist
  }

  try {
    const diff = execSync(`git diff ${sourceBranch}...HEAD`, execOpts).trim()
    if (diff) return diff
  } catch {
    // sourceBranch may not exist locally
  }

  try {
    const diff = execSync('git diff HEAD~1', execOpts).trim()
    if (diff) return diff
  } catch {
    // No previous commit
  }

  return null
}

// ============================================================================
// Output Parsing
// ============================================================================

interface AcVerdictOutput {
  pass: boolean
  summary: string
  criteria?: Array<{
    criterion: string
    met: boolean
    explanation: string
  }>
}

/**
 * Parse the AC validator's output to extract a structured verdict.
 */
function parseAcVerdict(stdout: string, timestamp: string): GateResult {
  const parsed = tryParseAcOutput(stdout)

  if (!parsed) {
    // Could not parse structured output — treat as a warning but pass
    return {
      verdict: 'pass',
      checkName: 'ac-validator',
      summary: 'AC validator produced unstructured output — assuming pass',
      details: { rawOutput: stdout.slice(0, 2000) },
      timestamp,
    }
  }

  return {
    verdict: parsed.pass ? 'pass' : 'fail',
    checkName: 'ac-validator',
    summary: parsed.summary,
    details: {
      criteria: parsed.criteria,
      totalCriteria: parsed.criteria?.length ?? 0,
      metCriteria: parsed.criteria?.filter((c) => c.met).length ?? 0,
    },
    timestamp,
  }
}

function tryParseAcOutput(stdout: string): AcVerdictOutput | null {
  const trimmed = stdout.trim()

  // Strategy 1: direct JSON parse
  const direct = tryJson(trimmed)
  if (isAcVerdict(direct)) return direct

  // Strategy 2: Claude -p result wrapper
  if (direct && typeof direct === 'object' && 'result' in direct) {
    const inner = tryJson((direct as Record<string, unknown>).result as string)
    if (isAcVerdict(inner)) return inner
  }

  // Strategy 3: extract from code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlockMatch) {
    const parsed = tryJson(codeBlockMatch[1])
    if (isAcVerdict(parsed)) return parsed
  }

  // Strategy 4: find first { ... } block
  const braceMatch = trimmed.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    const parsed = tryJson(braceMatch[0])
    if (isAcVerdict(parsed)) return parsed
  }

  return null
}

function tryJson(str: string): unknown | null {
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}

function isAcVerdict(obj: unknown): obj is AcVerdictOutput {
  if (typeof obj !== 'object' || obj === null) return false
  const v = obj as Record<string, unknown>
  return typeof v.pass === 'boolean' && typeof v.summary === 'string'
}
