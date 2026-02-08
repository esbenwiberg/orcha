/**
 * Gate Agent: Test Runner
 *
 * Shell-only gate agent — no AI session needed.
 * Runs the project's configured test command (default: `npm test`)
 * in the pipeline worktree and captures the output.
 *
 * Detects test command from package.json scripts. If no test command
 * exists, skips with a warning.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { execSync } from 'child_process'
import type { GateResult } from '../types.js'

// ============================================================================
// Test Runner
// ============================================================================

/**
 * Run tests in the worktree and return a GateResult.
 */
export async function runTestRunner(worktreePath: string): Promise<GateResult> {
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

  try {
    const output = execSync(testCommand, {
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
