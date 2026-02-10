/**
 * Gate Agent: Test Runner
 *
 * Shell-only gate agent — no AI session needed.
 * Runs the project's configured test command (default: `npm test`)
 * in the pipeline worktree and captures the output.
 *
 * Supports multi-tech stacks: when TechStack[] is provided, runs each
 * stack's test command in its own directory. Falls back to legacy
 * package.json detection when no stacks are provided.
 */

import { readFile } from 'fs/promises'
import { join, relative } from 'path'
import { execSync, execFileSync } from 'child_process'
import type { GateResult, StackRunnerResult } from '../types.js'
import { aggregateStackVerdicts } from '../types.js'
import type { TechStack } from '../tech-scanner.js'

// ============================================================================
// Allowed Test Commands (whitelist for security)
// ============================================================================

/**
 * Map of allowed test commands to their execFileSync arguments.
 * Only commands in this whitelist can be executed, preventing arbitrary
 * command injection from malicious package.json or project files.
 *
 * Security:
 * - Object.freeze() makes this immutable at runtime, preventing prototype
 *   pollution attacks that could add malicious commands.
 * - Deep freeze is applied to nested args arrays as well.
 * - The args arrays are spread-copied before use ([...allowedCmd.args]) to
 *   prevent any modification of the frozen originals.
 *
 * Threat model: We trust that techStacks data comes from detectTechStacks()
 * which reads project marker files (package.json, *.csproj, etc.). An attacker
 * with write access to these files could influence which stack is detected,
 * but the command executed is always from this fixed whitelist.
 */
const ALLOWED_TEST_COMMANDS: Readonly<Record<string, Readonly<{ cmd: string; args: readonly string[] }>>> = Object.freeze({
  'npm test': Object.freeze({ cmd: 'npm', args: Object.freeze(['test']) }),
  'dotnet test': Object.freeze({ cmd: 'dotnet', args: Object.freeze(['test']) }),
  'pytest': Object.freeze({ cmd: 'pytest', args: Object.freeze([]) }),
})

// ============================================================================
// Test Runner
// ============================================================================

/**
 * Run tests in the worktree and return a GateResult.
 *
 * When techStacks is provided and non-empty, runs the test command for each
 * stack that has one configured. When not provided, falls back to legacy
 * package.json detection for backward compatibility.
 */
export async function runTestRunner(
  worktreePath: string,
  techStacks?: TechStack[],
): Promise<GateResult> {
  // Multi-tech path: run per-stack tests
  if (techStacks && techStacks.length > 0) {
    return runMultiStackTests(worktreePath, techStacks)
  }

  // Legacy path: detect from package.json (backward compat)
  return runLegacyTests(worktreePath)
}

// ============================================================================
// Multi-Stack Test Execution
// ============================================================================

/**
 * Run tests for each detected tech stack. Collects per-stack results and
 * aggregates the verdict: any fail → 'fail', all skip → 'skip', else 'pass'.
 *
 * Uses a whitelist of allowed test commands and execFileSync to prevent
 * command injection from malicious project files.
 */
function runMultiStackTests(worktreePath: string, techStacks: TechStack[]): GateResult {
  const timestamp = new Date().toISOString()
  const stackResults: StackRunnerResult[] = []

  for (const stack of techStacks) {
    const relPath = relative(worktreePath, stack.absolutePath) || '.'

    if (!stack.commands.test) {
      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'skip',
      })
      continue
    }

    // Validate test command against whitelist to prevent command injection
    const allowedCmd = ALLOWED_TEST_COMMANDS[stack.commands.test]
    if (!allowedCmd) {
      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'skip',
        output: `Test command "${stack.commands.test}" not in whitelist — skipping for security`,
      })
      continue
    }

    try {
      // Copy args array since execFileSync may modify it and ours is frozen
      const output = execFileSync(allowedCmd.cmd, [...allowedCmd.args], {
        cwd: stack.absolutePath,
        encoding: 'utf-8',
        timeout: 300000, // 5 minute timeout per stack
        env: {
          ...process.env,
          CI: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
        },
      })

      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'pass',
        command: stack.commands.test,
        output: output.slice(-2000),
      })
    } catch (err) {
      const execError = err as { status?: number; stdout?: string; stderr?: string }
      const output = [execError.stdout || '', execError.stderr || ''].join('\n').trim()

      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'fail',
        command: stack.commands.test,
        output: output.slice(-4000),
        exitCode: execError.status,
      })
    }
  }

  // Aggregate verdict
  const verdict = aggregateStackVerdicts(stackResults.map((r) => r.status))

  // Build summary
  const passed = stackResults.filter((r) => r.status === 'pass').length
  const failed = stackResults.filter((r) => r.status === 'fail').length
  const skipped = stackResults.filter((r) => r.status === 'skip').length
  const parts: string[] = []
  if (passed > 0) parts.push(`${passed} passed`)
  if (failed > 0) parts.push(`${failed} failed`)
  if (skipped > 0) parts.push(`${skipped} skipped`)
  const summary =
    verdict === 'fail'
      ? `Tests failed (${parts.join(', ')})`
      : verdict === 'skip'
        ? `No test commands configured — skipping test gate`
        : `All tests passed (${parts.join(', ')})`

  return {
    verdict,
    checkName: 'test-runner',
    summary,
    details: { stacks: stackResults },
    timestamp,
  }
}

// ============================================================================
// Legacy Test Execution (backward compat)
// ============================================================================

/**
 * Original single-project test runner. Used when no techStacks are provided.
 * Uses execFileSync with whitelisted command to prevent command injection.
 */
async function runLegacyTests(worktreePath: string): Promise<GateResult> {
  const timestamp = new Date().toISOString()

  // Detect test command from package.json
  const testCommand = await detectTestCommand(worktreePath)
  if (!testCommand) {
    return {
      verdict: 'skip',
      checkName: 'test-runner',
      summary: 'No test command found in package.json — skipping test gate',
      details: { reason: 'no-test-command' },
      timestamp,
    }
  }

  // Validate against whitelist to prevent command injection
  const allowedCmd = ALLOWED_TEST_COMMANDS[testCommand]
  if (!allowedCmd) {
    return {
      verdict: 'skip',
      checkName: 'test-runner',
      summary: `Test command "${testCommand}" not in whitelist — skipping for security`,
      details: { reason: 'command-not-whitelisted', command: testCommand },
      timestamp,
    }
  }

  try {
    // Copy args array since execFileSync may modify it and ours is frozen
    const output = execFileSync(allowedCmd.cmd, [...allowedCmd.args], {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 300000, // 5 minute timeout for tests
      env: {
        ...process.env,
        CI: '1',
        // Disable color output for cleaner logs
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    })

    return {
      verdict: 'pass',
      checkName: 'test-runner',
      summary: 'All tests passed',
      details: {
        command: testCommand,
        output: output.slice(-2000), // Last 2KB of output
      },
      timestamp,
    }
  } catch (err) {
    const execError = err as { status?: number; stdout?: string; stderr?: string }
    const output = [execError.stdout || '', execError.stderr || ''].join('\n').trim()

    return {
      verdict: 'fail',
      checkName: 'test-runner',
      summary: `Tests failed (exit code ${execError.status ?? 'unknown'})`,
      details: {
        command: testCommand,
        exitCode: execError.status,
        output: output.slice(-4000), // Last 4KB for failures (more context)
      },
      timestamp,
    }
  }
}

// ============================================================================
// Test Command Detection
// ============================================================================

/**
 * Detect the test command from package.json.
 * Returns null if no test command is found.
 */
async function detectTestCommand(worktreePath: string): Promise<string | null> {
  try {
    const pkgPath = join(worktreePath, 'package.json')
    const pkgJson = JSON.parse(await readFile(pkgPath, 'utf-8'))

    if (pkgJson.scripts?.test && pkgJson.scripts.test !== 'echo "Error: no test specified" && exit 1') {
      return 'npm test'
    }

    return null
  } catch {
    // No package.json or can't parse it
    return null
  }
}
