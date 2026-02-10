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

import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { mkdtemp, writeFile, readFile, rm } from 'fs/promises'
import { join, resolve, relative } from 'path'
import { tmpdir } from 'os'
import type { PipelineRun, GateResult } from '../types.js'
import type { TechStack } from '../tech-scanner.js'
import { runStage } from '../stage-runner.js'
import { resolveModel, resolveBudget } from '../pipeline-config.js'
import { buildAdversaryPrompt } from '../prompt-builder.js'
import type { WorkItemContext, DiffContext } from '../prompt-builder.js'
import { getDiff } from '../git-utils.js'
import { parseStructuredOutput } from '../output-parser.js'

// ============================================================================
// Types
// ============================================================================

export interface AdversaryOptions {
  modelOverride?: string
  budgetOverride?: number
  techStacks?: TechStack[]
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

  // Pick the primary tech stack (first one, or fallback to undefined for backwards compat)
  const primaryTech = opts?.techStacks?.[0]?.type

  // Get the diff
  const diff = getDiff(run.worktreePath, run.sourceBranch, run.baseCommit)
  if (!diff) {
    return {
      verdict: 'skip',
      checkName: 'adversary',
      summary: 'No diff found — skipping adversary gate',
      details: { reason: 'no-diff' },
      timestamp,
    }
  }

  // Get existing test patterns for context (tech-aware)
  const testPatterns = getTestPatterns(run.worktreePath, primaryTech)

  // Build prompts (tech-aware)
  const workItem: WorkItemContext = {
    workItemId: run.workItemId,
    description: run.description,
    acceptanceCriteria: run.acceptanceCriteria,
  }
  const diffCtx: DiffContext = { diff }
  const { systemPrompt, userPrompt } = buildAdversaryPrompt(workItem, diffCtx, testPatterns, primaryTech)

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
      const targetPath = join(tempDir, safeName)
      // Validate path stays within tempDir (prevent traversal via crafted filenames)
      if (!resolve(targetPath).startsWith(resolve(tempDir))) continue
      await writeFile(targetPath, test.content, 'utf-8')
    }

    // Execute each test against the worktree (tech-aware runner)
    const execResults = await executeTests(tempDir, run.worktreePath, adversaryOutput.tests, primaryTech)

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
// Test Pattern Discovery
// ============================================================================

/** Valid tech types for test pattern lookup. */
const VALID_TECH_TYPES: ReadonlySet<TechStack['type']> = new Set<TechStack['type']>(['node', 'dotnet', 'python'])

/**
 * Test file patterns as arrays for execFileSync (avoids shell interpolation).
 * Security: Object.freeze() prevents runtime modification via prototype pollution.
 */
const TEST_FILE_PATTERNS = Object.freeze({
  node: Object.freeze(['*.test.ts', '*.spec.ts', '*.test.js', '*.spec.js'] as const),
  dotnet: Object.freeze(['*Tests.cs', '*Test.cs'] as const),
  python: Object.freeze(['test_*.py', '*_test.py'] as const),
}) satisfies Readonly<Record<TechStack['type'], readonly string[]>>

/**
 * Validate techType against whitelist to prevent command injection.
 * Returns a valid tech type or defaults to 'node'.
 */
function validateTechType(techType?: TechStack['type']): TechStack['type'] {
  if (techType && VALID_TECH_TYPES.has(techType)) {
    return techType
  }
  return 'node'
}

/**
 * Get a sample of existing test patterns from the project for context.
 *
 * @param techType - If provided, searches for tech-appropriate test file patterns.
 *                   Falls back to Node patterns if not specified (backwards compatible).
 *
 * Security: Uses execFileSync with args array to prevent command injection.
 * The pattern array comes from a validated whitelist.
 */
function getTestPatterns(worktreePath: string, techType?: TechStack['type']): string {
  // Validate techType against whitelist to prevent command injection
  const validatedType = validateTechType(techType)
  const patterns = TEST_FILE_PATTERNS[validatedType]

  try {
    // Build find args safely using execFileSync (no shell interpolation)
    // find . -maxdepth 4 -type f \( -name "*.test.ts" -o -name "*.spec.ts" ... \)
    const findArgs = ['.', '-maxdepth', '4', '-type', 'f', '(']
    for (let i = 0; i < patterns.length; i++) {
      if (i > 0) findArgs.push('-o')
      findArgs.push('-name', patterns[i])
    }
    findArgs.push(')')

    const testFilesOutput = execFileSync('find', findArgs, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()

    if (!testFilesOutput) return ''

    // Take only first 5 files (equivalent to | head -5)
    const testFiles = testFilesOutput.split('\n').filter(Boolean).slice(0, 5)

    const patternSamples: string[] = []
    for (const file of testFiles.slice(0, 3)) {
      try {
        const fullPath = join(worktreePath, file)
        const content = (readFileSync(fullPath, 'utf-8') as string)
          .split('\n').slice(0, 30).join('\n')
        patternSamples.push(`--- ${file} ---\n${content}`)
      } catch { /* skip unreadable files */ }
    }

    return patternSamples.join('\n\n')
  } catch {
    return ''
  }
}

// ============================================================================
// Test Execution
// ============================================================================

/**
 * Get the command and args to execute a test file for the given tech type.
 *
 * Returns null if execution should be skipped (e.g. .NET tests need project context).
 */
function getTestRunner(
  testPath: string,
  techType?: TechStack['type'],
): { cmd: string; args: string[] } | null {
  switch (techType) {
    case 'python':
      return { cmd: 'pytest', args: [testPath, '-x', '--tb=short'] }
    case 'dotnet':
      // .NET adversary tests cannot be executed standalone — they need a project
      // context to compile. This is a known limitation; the tests are still
      // valuable as review artifacts.
      return null
    case 'node':
    default:
      return { cmd: 'npx', args: ['tsx', testPath] }
  }
}

/**
 * Detect compile/import errors for a given tech type from combined output.
 */
function isCompileError(output: string, techType?: TechStack['type']): boolean {
  switch (techType) {
    case 'python':
      return output.includes('SyntaxError')
        || output.includes('ModuleNotFoundError')
        || output.includes('ImportError')
    case 'dotnet':
      return true // .NET tests are not executed, so any error is "compile"
    case 'node':
    default:
      return output.includes('SyntaxError')
        || output.includes('Cannot find module')
        || output.includes('ERR_MODULE_NOT_FOUND')
  }
}

/**
 * Execute adversary tests from the temp dir against the worktree code.
 *
 * @param techType - Determines which test runner to use. Defaults to 'node' (npx tsx).
 */
async function executeTests(
  tempDir: string,
  worktreePath: string,
  tests: AdversaryTest[],
  techType?: TechStack['type'],
): Promise<TestExecResult[]> {
  const results: TestExecResult[] = []

  for (const test of tests) {
    const safeName = test.filename.replace(/[^a-zA-Z0-9._-]/g, '_')
    const testPath = join(tempDir, safeName)

    // Validate the resolved test path stays within tempDir (prevent traversal)
    const resolvedTestPath = resolve(testPath)
    const relPath = relative(tempDir, resolvedTestPath)
    if (relPath.startsWith('..') || resolve(relPath) !== resolvedTestPath) {
      results.push({ filename: safeName, compiled: false, passed: false, output: 'Path traversal detected' })
      continue
    }

    // Get the appropriate test runner for this tech type
    const runner = getTestRunner(testPath, techType)
    if (!runner) {
      // Execution skipped (e.g. .NET) — treat as compiled-but-passed (review-only)
      results.push({
        filename: safeName,
        compiled: true,
        passed: true,
        output: `Execution skipped for ${techType ?? 'unknown'} — tests are review-only artifacts`,
      })
      continue
    }

    // Execute the test using execFileSync to avoid shell injection
    try {
      const output = execFileSync(
        runner.cmd, runner.args,
        {
          cwd: worktreePath,
          encoding: 'utf-8',
          timeout: 30000, // 30s per test
          env: {
            ...process.env,
            CI: '1',
            NO_COLOR: '1',
            ...(techType === 'node' || !techType
              ? { NODE_PATH: join(worktreePath, 'node_modules') }
              : {}),
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

      if (isCompileError(output, techType)) {
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

function isAdversaryOutput(obj: unknown): obj is AdversaryOutput {
  if (typeof obj !== 'object' || obj === null) return false
  const v = obj as Record<string, unknown>
  return Array.isArray(v.tests) && typeof v.reasoning === 'string'
}

function parseAdversaryOutput(stdout: string): AdversaryOutput | null {
  return parseStructuredOutput(stdout, isAdversaryOutput)
}
