/**
 * Gate Agent: Code Review
 *
 * AI-powered gate agent that reviews the code diff for correctness,
 * conventions, and code quality issues.
 *
 * Uses Claude via stage-runner in print mode to analyze the diff and produce
 * a structured pass/fail verdict.
 */

import type { PipelineRun, GateResult, ActionableFinding, Severity } from '../types.js'
import { runStage } from '../stage-runner.js'
import { resolveModel, resolveBudget } from '../pipeline-config.js'
import { buildCodeReviewPrompt } from '../prompt-builder.js'
import type { WorkItemContext, DiffContext } from '../prompt-builder.js'
import { getDiff } from '../git-utils.js'
import { parseStructuredOutput } from '../output-parser.js'

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
  const diff = await getDiff(run.worktreePath, run.sourceBranch, run.baseCommit)
  if (!diff) {
    return {
      verdict: 'skip',
      checkName: 'code-review',
      summary: 'No diff found — skipping code review',
      details: { reason: 'no-diff' },
      findings: [],
      rawOutput: '',
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
  const { systemPrompt, userPrompt } = await buildCodeReviewPrompt(workItem, diffCtx)

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
        findings: [],
        rawOutput: result.stderr.slice(0, 50000),
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
      findings: [],
      rawOutput: '',
      timestamp,
    }
  }
}

// ============================================================================
// Output Parsing
// ============================================================================

function isCodeReviewVerdict(obj: unknown): obj is CodeReviewVerdictOutput {
  if (typeof obj !== 'object' || obj === null) return false
  const v = obj as Record<string, unknown>
  return typeof v.pass === 'boolean' && typeof v.summary === 'string'
}

/** Map code review severity strings to ActionableFinding severity. */
function mapCodeReviewSeverity(severity: string): Severity {
  switch (severity) {
    case 'critical': return 'critical'
    case 'major': return 'high'
    case 'minor': return 'medium'
    case 'info':
    case 'nitpick': return 'info'
    default: return 'medium'
  }
}

function parseCodeReviewVerdict(stdout: string, timestamp: string): GateResult {
  const parsed = parseStructuredOutput(stdout, isCodeReviewVerdict)

  if (!parsed) {
    return {
      verdict: 'fail',
      checkName: 'code-review',
      summary: 'Code review produced unstructured output — cannot verify code quality',
      details: { rawOutput: stdout.slice(0, 2000) },
      findings: [],
      rawOutput: stdout,
      timestamp,
    }
  }

  const majorFindings = parsed.findings?.filter(
    (f) => f.severity === 'critical' || f.severity === 'major',
  ) ?? []

  // Convert code review findings to ActionableFinding format
  const actionableFindings: ActionableFinding[] = (parsed.findings ?? []).map((f) => ({
    file: f.file ?? '',
    line: f.line ?? 0,
    issue: f.description,
    suggestedFix: `Review and fix the ${f.severity} issue in ${f.file ?? 'the code'}${f.line ? ` at line ${f.line}` : ''}`,
    severity: mapCodeReviewSeverity(f.severity),
  }))

  return {
    verdict: parsed.pass ? 'pass' : 'fail',
    checkName: 'code-review',
    summary: parsed.summary,
    details: {
      findings: parsed.findings,
      totalFindings: parsed.findings?.length ?? 0,
      majorFindings: majorFindings.length,
    },
    findings: actionableFindings,
    rawOutput: stdout,
    timestamp,
  }
}
