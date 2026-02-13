/**
 * Gate Agent: Build Runner
 *
 * Shell-only gate agent — no AI session needed.
 * Runs build commands for each detected tech stack in the pipeline worktree.
 *
 * Supports multi-tech stacks: when TechStack[] is provided, runs each
 * stack's build command in its own directory. Falls back to legacy
 * package.json detection when no stacks are provided.
 */

import { readFile } from 'fs/promises'
import { join, relative } from 'path'
import { execAsync, execFileAsync } from '../exec-utils.js'
import type { GateResult, StackRunnerResult, ActionableFinding } from '../types.js'
import { aggregateStackVerdicts } from '../types.js'
import type { TechStack } from '../tech-scanner.js'

/** Cap raw output at 50KB for sanity. */
const MAX_RAW_OUTPUT = 50 * 1024

// ============================================================================
// Allowed Build Commands (whitelist for security)
// ============================================================================

/**
 * Map of allowed build commands to their execFileAsync arguments.
 * Only commands in this whitelist can be executed, preventing arbitrary
 * command injection from malicious package.json or project files.
 *
 * Security: Object.freeze() makes this immutable at runtime, preventing
 * prototype pollution attacks that could add malicious commands.
 * Deep freeze is applied to nested args arrays as well.
 */
const ALLOWED_BUILD_COMMANDS: Readonly<Record<string, Readonly<{ cmd: string; args: readonly string[] }>>> = Object.freeze({
  'npm run build': Object.freeze({ cmd: 'npm', args: Object.freeze(['run', 'build']) }),
  'dotnet build': Object.freeze({ cmd: 'dotnet', args: Object.freeze(['build', '-m:2', '--no-restore', '/p:UseSharedCompilation=false']) }),
  'python -m build': Object.freeze({ cmd: 'python', args: Object.freeze(['-m', 'build']) }),
})

// ============================================================================
// Build Runner
// ============================================================================

/**
 * Run builds in the worktree and return a GateResult.
 *
 * When techStacks is provided and non-empty, runs the build command for each
 * stack that has one configured. When not provided, falls back to legacy
 * package.json detection for backward compatibility.
 *
 * Skips stacks that failed dependency installation (tracked in dependencyFailures).
 */
export async function runBuildRunner(
  worktreePath: string,
  techStacks?: TechStack[],
  dependencyFailures?: string[],
): Promise<GateResult> {
  // Multi-tech path: run per-stack builds
  if (techStacks && techStacks.length > 0) {
    return await runMultiStackBuilds(worktreePath, techStacks, dependencyFailures)
  }

  // Legacy path: detect from package.json (backward compat)
  return runLegacyBuild(worktreePath)
}

// ============================================================================
// Multi-Stack Build Execution
// ============================================================================

/**
 * Run builds for each detected tech stack. Collects per-stack results and
 * aggregates the verdict: any fail → 'fail', all skip → 'skip', else 'pass'.
 *
 * Skips stacks that failed dependency installation.
 * Uses a whitelist of allowed build commands and execFileAsync to prevent
 * command injection from malicious project files.
 */
async function runMultiStackBuilds(
  worktreePath: string,
  techStacks: TechStack[],
  dependencyFailures?: string[],
): Promise<GateResult> {
  const timestamp = new Date().toISOString()
  const stackResults: StackRunnerResult[] = []
  const failedDeps = new Set(dependencyFailures ?? [])

  for (const stack of techStacks) {
    const relPath = relative(worktreePath, stack.absolutePath) || '.'

    // Skip if dependency installation failed for this tech
    if (failedDeps.has(stack.type)) {
      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'skip',
        output: 'Skipped: dependency installation failed',
      })
      continue
    }

    if (!stack.commands.build) {
      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'skip',
      })
      continue
    }

    // Validate build command against whitelist to prevent command injection
    const allowedCmd = ALLOWED_BUILD_COMMANDS[stack.commands.build]
    if (!allowedCmd) {
      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'skip',
        output: `Build command "${stack.commands.build}" not in whitelist — skipping for security`,
      })
      continue
    }

    try {
      // Copy args array since ours is frozen
      const { stdout: output } = await execFileAsync(allowedCmd.cmd, [...allowedCmd.args], {
        cwd: stack.absolutePath,
        timeout: 300000, // 5 minute timeout per stack
        env: {
          ...process.env,
          CI: '1',
          NO_COLOR: '1',
          FORCE_COLOR: '0',
          MSBUILDDISABLENODEREUSE: '1', // Don't keep MSBuild worker nodes alive after build
          DOTNET_CLI_TELEMETRY_OPTOUT: '1',
        },
      })

      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'pass',
        command: stack.commands.build,
        output: output.slice(-2000),
      })
    } catch (err) {
      const execError = err as { code?: number; stdout?: string; stderr?: string }
      const output = [execError.stdout || '', execError.stderr || ''].join('\n').trim()

      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'fail',
        command: stack.commands.build,
        output: output.slice(-4000),
        exitCode: execError.code,
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
      ? `Build failed (${parts.join(', ')})`
      : verdict === 'skip'
        ? `No build commands configured — skipping build gate`
        : `All builds passed (${parts.join(', ')})`

  // Build rawOutput from all stack outputs
  const allRawOutput = stackResults
    .map((r) => r.output ? `[${r.type}] ${r.output}` : '')
    .filter(Boolean)
    .join('\n---\n')

  // Build findings from failed stacks
  const findings: ActionableFinding[] = stackResults
    .filter((r) => r.status === 'fail')
    .map((r) => ({
      file: '',
      line: 0,
      issue: `Build failed for ${r.type} stack at ${r.path} (exit code ${r.exitCode ?? 'unknown'})`,
      suggestedFix: `Run \`${r.command ?? 'build'}\` in ${r.path} and fix build errors`,
      severity: 'critical' as const,
    }))

  return {
    verdict,
    checkName: 'build',
    summary,
    details: { stacks: stackResults },
    findings,
    rawOutput: allRawOutput.slice(0, MAX_RAW_OUTPUT),
    timestamp,
  }
}

// ============================================================================
// Legacy Build Execution (backward compat)
// ============================================================================

/**
 * Original single-project build runner. Used when no techStacks are provided.
 * Uses execFileAsync with whitelisted command to prevent command injection.
 */
async function runLegacyBuild(worktreePath: string): Promise<GateResult> {
  const timestamp = new Date().toISOString()

  // Detect build command from package.json
  const buildCommand = await detectBuildCommand(worktreePath)
  if (!buildCommand) {
    return {
      verdict: 'skip',
      checkName: 'build',
      summary: 'No build command found in package.json — skipping build gate',
      details: { reason: 'no-build-command' },
      findings: [],
      rawOutput: '',
      timestamp,
    }
  }

  // Validate against whitelist to prevent command injection
  const allowedCmd = ALLOWED_BUILD_COMMANDS[buildCommand]
  if (!allowedCmd) {
    return {
      verdict: 'skip',
      checkName: 'build',
      summary: `Build command "${buildCommand}" not in whitelist — skipping for security`,
      details: { reason: 'command-not-whitelisted', command: buildCommand },
      findings: [],
      rawOutput: '',
      timestamp,
    }
  }

  try {
    // Copy args array since ours is frozen
    const { stdout: output } = await execFileAsync(allowedCmd.cmd, [...allowedCmd.args], {
      cwd: worktreePath,
      timeout: 300000, // 5 minute timeout for builds
      env: {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        MSBUILDDISABLENODEREUSE: '1',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      },
    })

    return {
      verdict: 'pass',
      checkName: 'build',
      summary: 'Build passed',
      details: {
        command: buildCommand,
        output: output.slice(-2000), // Last 2KB of output
      },
      findings: [],
      rawOutput: output.slice(0, MAX_RAW_OUTPUT),
      timestamp,
    }
  } catch (err) {
    const execError = err as { code?: number; stdout?: string; stderr?: string }
    const output = [execError.stdout || '', execError.stderr || ''].join('\n').trim()

    return {
      verdict: 'fail',
      checkName: 'build',
      summary: `Build failed (exit code ${execError.code ?? 'unknown'})`,
      details: {
        command: buildCommand,
        exitCode: execError.code,
        output: output.slice(-4000), // Last 4KB for failures (more context)
      },
      findings: [{
        file: '',
        line: 0,
        issue: `Build failed with exit code ${execError.code ?? 'unknown'}`,
        suggestedFix: `Run \`${buildCommand}\` and fix build errors`,
        severity: 'critical',
      }],
      rawOutput: output.slice(0, MAX_RAW_OUTPUT),
      timestamp,
    }
  }
}

// ============================================================================
// Build Command Detection
// ============================================================================

/**
 * Detect the build command from package.json.
 * Returns null if no build command is found.
 */
async function detectBuildCommand(worktreePath: string): Promise<string | null> {
  try {
    const pkgPath = join(worktreePath, 'package.json')
    const pkgJson = JSON.parse(await readFile(pkgPath, 'utf-8'))

    if (pkgJson.scripts?.build) {
      return 'npm run build'
    }

    return null
  } catch {
    // No package.json or can't parse it
    return null
  }
}
