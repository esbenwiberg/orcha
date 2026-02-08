/**
 * Gate Agent: Code Review
 *
 * AI-powered gate agent that reviews the code diff for correctness,
 * conventions, and code quality issues.
 *
 * Uses Claude via stage-runner in print mode to analyze the diff and produce
 * a structured pass/fail verdict.
 */

import { execSync } from 'child_process'
import type { PipelineRun, GateResult } from '../types.js'
import { runStage } from '../stage-runner.js'
import { resolveModel, resolveBudget } from '../pipeline-config.js'
import { buildCodeReviewPrompt } from '../prompt-builder.js'
import type { WorkItemContext, DiffContext } from '../prompt-builder.js'

// ============================================================================
// Types
// ============================================================================

export interface CodeReviewOptions {
  modelOverride?: string
  budgetOverride?: number
}

interface CodeReviewVerdictOutput {
  pass: boolean
  summary: string
  findings?: Array<{
    severity: string
    file: string
    line?: number
    description: string
  }>
}

// ============================================================================
// Code Review Agent
// ============================================================================

/**
 * Run the code review gate agent.
 *
 * Fetches the git diff, sends it to Claude for code review,
 * and returns a structured GateResult.
 */
export async function runCodeReview(
  run: PipelineRun,
  opts?: CodeReviewOptions,
): Promise<GateResult> {
  const timestamp = new Date().toISOString()

  // Get the diff
  const diff = getDiff(run.worktreePath, run.sourceBranch)
  if (!diff) {
    return {
      verdict: 'skip',
      checkName: 'code-review',
      summary: 'No diff found — skipping code review',
      details: { reason: 'no-diff' },
      timestamp,
    }
  }

  // Build prompts
  const workItem: WorkItemContext = {
    workItemId: run.workItemId,
    description: run.description,
    acceptanceCriteria: run.acceptanceCriteria,
  }
  const diffCtx: DiffContext = { diff }
  const { systemPrompt, userPrompt } = buildCodeReviewPrompt(workItem, diffCtx)

  try {
    const result = await runStage({
      pipelineId: run.id,
      stageKey: 'gate-code-review',
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
        checkName: 'code-review',
        summary: `Code review session failed (exit code ${result.exitCode})`,
        details: { error: result.stderr.slice(0, 1000) },
        timestamp,
      }
    }

    return parseCodeReviewVerdict(result.stdout, timestamp)
  } catch (err) {
    return {
      verdict: 'fail',
      checkName: 'code-review',
      summary: `Code review error: ${(err as Error).message}`,
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
  } catch { /* origin/sourceBranch may not exist */ }

  try {
    const diff = execSync(`git diff ${sourceBranch}...HEAD`, execOpts).trim()
    if (diff) return diff
  } catch { /* sourceBranch may not exist locally */ }

  try {
    const diff = execSync('git diff HEAD~1', execOpts).trim()
    if (diff) return diff
  } catch { /* No previous commit */ }

  return null
}

// ============================================================================
// Output Parsing
// ============================================================================

function parseCodeReviewVerdict(stdout: string, timestamp: string): GateResult {
  const parsed = tryParseCodeReviewOutput(stdout)

  if (!parsed) {
    return {
      verdict: 'pass',
      checkName: 'code-review',
      summary: 'Code review produced unstructured output — assuming pass',
      details: { rawOutput: stdout.slice(0, 2000) },
      timestamp,
    }
  }

  const majorFindings = parsed.findings?.filter(
    (f) => f.severity === 'critical' || f.severity === 'major',
  ) ?? []

  return {
    verdict: parsed.pass ? 'pass' : 'fail',
    checkName: 'code-review',
    summary: parsed.summary,
    details: {
      findings: parsed.findings,
      totalFindings: parsed.findings?.length ?? 0,
      majorFindings: majorFindings.length,
    },
    timestamp,
  }
}

function tryParseCodeReviewOutput(stdout: string): CodeReviewVerdictOutput | null {
  const trimmed = stdout.trim()

  const direct = tryJson(trimmed)
  if (isCodeReviewVerdict(direct)) return direct

  if (direct && typeof direct === 'object' && 'result' in direct) {
    const inner = tryJson((direct as Record<string, unknown>).result as string)
    if (isCodeReviewVerdict(inner)) return inner
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlockMatch) {
    const parsed = tryJson(codeBlockMatch[1])
    if (isCodeReviewVerdict(parsed)) return parsed
  }

  const braceMatch = trimmed.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    const parsed = tryJson(braceMatch[0])
    if (isCodeReviewVerdict(parsed)) return parsed
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

function isCodeReviewVerdict(obj: unknown): obj is CodeReviewVerdictOutput {
  if (typeof obj !== 'object' || obj === null) return false
  const v = obj as Record<string, unknown>
  return typeof v.pass === 'boolean' && typeof v.summary === 'string'
}
