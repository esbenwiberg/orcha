/**
 * Gate Agent: Security Review
 *
 * AI-powered gate agent that reviews the code diff for security vulnerabilities.
 * Checks against OWASP top 10, hardcoded secrets, injection flaws, and more.
 *
 * Uses Claude via stage-runner in print mode to analyze the diff and produce
 * a structured pass/fail verdict.
 */

import { execSync } from 'child_process'
import type { PipelineRun, GateResult } from '../types.js'
import { runStage } from '../stage-runner.js'
import { resolveModel, resolveBudget } from '../pipeline-config.js'
import { buildSecurityReviewPrompt } from '../prompt-builder.js'
import type { WorkItemContext, DiffContext } from '../prompt-builder.js'

// ============================================================================
// Types
// ============================================================================

export interface SecurityReviewOptions {
  modelOverride?: string
  budgetOverride?: number
}

interface SecurityVerdictOutput {
  pass: boolean
  summary: string
  findings?: Array<{
    severity: string
    category: string
    file: string
    line?: number
    description: string
  }>
}

// ============================================================================
// Security Review Agent
// ============================================================================

/**
 * Run the security review gate agent.
 *
 * Fetches the git diff, sends it to Claude for security analysis,
 * and returns a structured GateResult.
 */
export async function runSecurityReview(
  run: PipelineRun,
  opts?: SecurityReviewOptions,
): Promise<GateResult> {
  const timestamp = new Date().toISOString()

  // Get the diff
  const diff = getDiff(run.worktreePath, run.sourceBranch)
  if (!diff) {
    return {
      verdict: 'skip',
      checkName: 'security',
      summary: 'No diff found — skipping security review',
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
  const { systemPrompt, userPrompt } = buildSecurityReviewPrompt(workItem, diffCtx)

  try {
    const result = await runStage({
      pipelineId: run.id,
      stageKey: 'gate-security',
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
        checkName: 'security',
        summary: `Security review session failed (exit code ${result.exitCode})`,
        details: { error: result.stderr.slice(0, 1000) },
        timestamp,
      }
    }

    return parseSecurityVerdict(result.stdout, timestamp)
  } catch (err) {
    return {
      verdict: 'fail',
      checkName: 'security',
      summary: `Security review error: ${(err as Error).message}`,
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

function parseSecurityVerdict(stdout: string, timestamp: string): GateResult {
  const parsed = tryParseSecurityOutput(stdout)

  if (!parsed) {
    return {
      verdict: 'pass',
      checkName: 'security',
      summary: 'Security review produced unstructured output — assuming pass',
      details: { rawOutput: stdout.slice(0, 2000) },
      timestamp,
    }
  }

  const criticalFindings = parsed.findings?.filter(
    (f) => f.severity === 'critical' || f.severity === 'high',
  ) ?? []

  return {
    verdict: parsed.pass ? 'pass' : 'fail',
    checkName: 'security',
    summary: parsed.summary,
    details: {
      findings: parsed.findings,
      totalFindings: parsed.findings?.length ?? 0,
      criticalFindings: criticalFindings.length,
    },
    timestamp,
  }
}

function tryParseSecurityOutput(stdout: string): SecurityVerdictOutput | null {
  const trimmed = stdout.trim()

  const direct = tryJson(trimmed)
  if (isSecurityVerdict(direct)) return direct

  if (direct && typeof direct === 'object' && 'result' in direct) {
    const inner = tryJson((direct as Record<string, unknown>).result as string)
    if (isSecurityVerdict(inner)) return inner
  }

  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlockMatch) {
    const parsed = tryJson(codeBlockMatch[1])
    if (isSecurityVerdict(parsed)) return parsed
  }

  const braceMatch = trimmed.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    const parsed = tryJson(braceMatch[0])
    if (isSecurityVerdict(parsed)) return parsed
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

function isSecurityVerdict(obj: unknown): obj is SecurityVerdictOutput {
  if (typeof obj !== 'object' || obj === null) return false
  const v = obj as Record<string, unknown>
  return typeof v.pass === 'boolean' && typeof v.summary === 'string'
}
