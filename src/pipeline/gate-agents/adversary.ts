/**
 * Gate Agent: Adversary
 *
 * AI-powered gate agent that tries to break the dev agent's code by writing
 * adversarial tests. Tests are written to a TEMP directory, executed against
 * the worktree code, and discarded after evaluation.
 *
 * Verdict logic:
 * - If adversary's own tests fail to compile/run → adversary-pass (couldn't break it)
 * - Only tests that compile AND fail against the dev's code → gate failure
 * - If no tests written or all tests pass → pass
 */

import { execSync } from 'child_process'
import { mkdtemp, writeFile, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { PipelineRun, GateResult } from '../types.js'
import { runStage } from '../stage-runner.js'
import { resolveModel, resolveBudget } from '../pipeline-config.js'
import { buildAdversaryPrompt } from '../prompt-builder.js'
import type { WorkItemContext, DiffContext } from '../prompt-builder.js'

// ============================================================================
// Types
// ============================================================================

export interface AdversaryOptions {
  modelOverride?: string
  budgetOverride?: number
}

interface AdversaryTest {
  filename: string
  description: string
  content: string
}

interface AdversaryOutput {
  tests: AdversaryTest[]
  reasoning: string
}

interface TestExecResult {
  filename: string
  compiled: boolean
  passed: boolean
  output: string
}

// ============================================================================
// Adversary Agent
// ============================================================================

/**
 * Run the adversary gate agent.
 *
 * Spawns a Claude session to write adversarial tests, writes them to a temp
 * directory, runs them against the worktree, and reports results.
 */
export async function runAdversary(
  run: PipelineRun,
  opts?: AdversaryOptions,
): Promise<GateResult> {
  const timestamp = new Date().toISOString()

  // Get the diff
  const diff = getDiff(run.worktreePath, run.sourceBranch)
  if (!diff) {
    return {
      verdict: 'skip',
      checkName: 'adversary',
      summary: 'No diff found — skipping adversary gate',
      details: { reason: 'no-diff' },
      timestamp,
    }
  }

  // Get existing test patterns for context
  const testPatterns = getTestPatterns(run.worktreePath)

  // Build prompts
  const workItem: WorkItemContext = {
    workItemId: run.workItemId,
    description: run.description,
    acceptanceCriteria: run.acceptanceCriteria,
  }
  const diffCtx: DiffContext = { diff }
  const { systemPrompt, userPrompt } = buildAdversaryPrompt(workItem, diffCtx, testPatterns)

  let tempDir: string | null = null

  try {
    // Run Claude to generate adversarial tests
    const result = await runStage({
      pipelineId: run.id,
      stageKey: 'gate-adversary',
      config: run.config,
      cwd: run.worktreePath,
      prompt: userPrompt,
      systemPrompt,
      allowedTools: 'Read,Grep,Glob',
      modelOverride: opts?.modelOverride ?? resolveModel(run.config, 'gate:adversary'),
      budgetOverride: opts?.budgetOverride ?? resolveBudget(run.config, 'gate'),
    })

    if (!result.success) {
      return {
        verdict: 'pass',
        checkName: 'adversary',
        summary: `Adversary session failed (exit code ${result.exitCode}) — treating as pass`,
        details: { error: result.stderr.slice(0, 1000) },
        timestamp,
      }
    }

    // Parse adversary output
    const adversaryOutput = parseAdversaryOutput(result.stdout)
    if (!adversaryOutput || adversaryOutput.tests.length === 0) {
      return {
        verdict: 'pass',
        checkName: 'adversary',
        summary: 'Adversary produced no tests — pass',
        details: { reasoning: adversaryOutput?.reasoning ?? 'no output parsed' },
        timestamp,
      }
    }

    // Write tests to temp directory
    tempDir = await mkdtemp(join(tmpdir(), 'orcha-adversary-'))
    for (const test of adversaryOutput.tests) {
      const safeName = test.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
      await writeFile(join(tempDir, safeName), test.content, 'utf-8')
    }

    // Execute each test against the worktree
    const execResults = await executeTests(tempDir, run.worktreePath, adversaryOutput.tests)

    // Determine verdict: only tests that compiled AND failed count as gate failures
    const compiled = execResults.filter((r) => r.compiled)
    const failedTests = compiled.filter((r) => !r.passed)

    if (failedTests.length > 0) {
      return {
        verdict: 'fail',
        checkName: 'adversary',
        summary: `Adversary found ${failedTests.length} bug(s): ${failedTests.map((t) => t.filename).join(', ')}`,
        details: {
          testsWritten: adversaryOutput.tests.length,
          testsCompiled: compiled.length,
          testsPassed: compiled.length - failedTests.length,
          testsFailed: failedTests.length,
          failures: failedTests.map((t) => ({
            filename: t.filename,
            output: t.output.slice(0, 1000),
          })),
          reasoning: adversaryOutput.reasoning,
        },
        timestamp,
      }
    }

    return {
      verdict: 'pass',
      checkName: 'adversary',
      summary: `Adversary wrote ${adversaryOutput.tests.length} test(s), ${compiled.length} compiled, all passed — code is solid`,
      details: {
        testsWritten: adversaryOutput.tests.length,
        testsCompiled: compiled.length,
        testsPassed: compiled.length,
        testsFailed: 0,
        reasoning: adversaryOutput.reasoning,
      },
      timestamp,
    }
  } catch (err) {
    return {
      verdict: 'pass',
      checkName: 'adversary',
      summary: `Adversary error: ${(err as Error).message} — treating as pass`,
      details: { error: (err as Error).message },
      timestamp,
    }
  } finally {
    // Cleanup temp directory
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {})
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
// Test Pattern Discovery
// ============================================================================

/**
 * Get a sample of existing test patterns from the project for context.
 */
function getTestPatterns(worktreePath: string): string {
  try {
    // Find test files and grab first few lines as patterns
    const testFiles = execSync(
      'find . -maxdepth 4 -type f \\( -name "*.test.ts" -o -name "*.spec.ts" -o -name "*.test.js" -o -name "*.spec.js" \\) | head -5',
      { cwd: worktreePath, encoding: 'utf-8', timeout: 5000 },
    ).trim()

    if (!testFiles) return ''

    const patterns: string[] = []
    for (const file of testFiles.split('\n').filter(Boolean).slice(0, 3)) {
      try {
        const content = execSync(`head -30 "${file}"`, {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 3000,
        }).trim()
        patterns.push(`--- ${file} ---\n${content}`)
      } catch { /* skip unreadable files */ }
    }

    return patterns.join('\n\n')
  } catch {
    return ''
  }
}

// ============================================================================
// Test Execution
// ============================================================================

/**
 * Execute adversary tests from the temp dir against the worktree code.
 */
async function executeTests(
  tempDir: string,
  worktreePath: string,
  tests: AdversaryTest[],
): Promise<TestExecResult[]> {
  const results: TestExecResult[] = []

  for (const test of tests) {
    const safeName = test.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const testPath = join(tempDir, safeName)

    // Try to run the test using npx with the worktree as context
    // Use NODE_PATH to resolve imports from the worktree
    try {
      const output = execSync(
        `npx tsx "${testPath}"`,
        {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 30000, // 30s per test
          env: {
            ...process.env,
            CI: '1',
            NO_COLOR: '1',
            NODE_PATH: join(worktreePath, 'node_modules'),
          },
        },
      )

      results.push({
        filename: safeName,
        compiled: true,
        passed: true,
        output: output.slice(-1000),
      })
    } catch (err) {
      const execError = err as { status?: number; stdout?: string; stderr?: string }
      const output = [execError.stdout || '', execError.stderr || ''].join('\n').trim()

      // Distinguish compile errors from test failures
      const isCompileError = output.includes('SyntaxError')
        || output.includes('Cannot find module')
        || output.includes('TypeError: Cannot read properties')
        || output.includes('ERR_MODULE_NOT_FOUND')
        || output.includes('is not a function')

      if (isCompileError) {
        results.push({
          filename: safeName,
          compiled: false,
          passed: false, // doesn't matter — won't count
          output: output.slice(-1000),
        })
      } else {
        // Test compiled but failed — this is a real finding
        results.push({
          filename: safeName,
          compiled: true,
          passed: false,
          output: output.slice(-1000),
        })
      }
    }
  }

  return results
}

// ============================================================================
// Output Parsing
// ============================================================================

function parseAdversaryOutput(stdout: string): AdversaryOutput | null {
  const trimmed = stdout.trim()

  // Strategy 1: direct JSON parse
  const direct = tryJson(trimmed)
  if (isAdversaryOutput(direct)) return direct

  // Strategy 2: Claude -p result wrapper
  if (direct && typeof direct === 'object' && 'result' in direct) {
    const inner = tryJson((direct as Record<string, unknown>).result as string)
    if (isAdversaryOutput(inner)) return inner
  }

  // Strategy 3: extract from code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlockMatch) {
    const parsed = tryJson(codeBlockMatch[1])
    if (isAdversaryOutput(parsed)) return parsed
  }

  // Strategy 4: find first { ... } block
  const braceMatch = trimmed.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    const parsed = tryJson(braceMatch[0])
    if (isAdversaryOutput(parsed)) return parsed
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

function isAdversaryOutput(obj: unknown): obj is AdversaryOutput {
  if (typeof obj !== 'object' || obj === null) return false
  const v = obj as Record<string, unknown>
  return Array.isArray(v.tests) && typeof v.reasoning === 'string'
}
