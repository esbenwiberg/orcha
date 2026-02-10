/**
 * Gate Agent: Lint Runner
 *
 * Shell-only gate agent — no AI session needed.
 * Runs lint scoped to changed files only (compared to the source branch).
 *
 * Supports multi-tech stacks: when TechStack[] is provided, runs each
 * stack's lint command in its own directory with extension-filtered files.
 * Falls back to legacy Node.js-only detection when no stacks are provided.
 *
 * Tech-specific behavior:
 * - Node: `npm run lint -- {files}` or `npx eslint {files}` (eslint output parsing)
 * - .NET: `dotnet format --verify-no-changes` in stack path (no file list — project-wide)
 * - Python: `ruff check {files}` or `flake8 {files}` (generic output parsing)
 */

import { readFile } from 'fs/promises'
import { join, relative } from 'path'
import { execSync, execFileSync } from 'child_process'
import type { GateResult, StackRunnerResult } from '../types.js'
import { aggregateStackVerdicts } from '../types.js'
import type { TechStack } from '../tech-scanner.js'
import { getChangedLintableFiles, getChangedFilesByExtensions } from '../git-utils.js'

// ============================================================================
// Filename Validation
// ============================================================================

/**
 * Validate that a filename is safe for use with lint commands.
 * Uses a whitelist approach: only allows characters that are safe in all contexts.
 *
 * Security: While execFileSync prevents shell injection, we validate filenames
 * to prevent issues with:
 * - Control characters
 * - Quotes and backticks (could cause issues in log parsing or other contexts)
 * - Semicolons (shell command separators in some edge cases)
 * - Other potentially problematic characters
 *
 * Allowed: alphanumeric, hyphen, underscore, period, forward slash
 * This covers normal file paths like 'src/components/Button.tsx'
 *
 * SECURITY NOTE: The '@' character is intentionally NOT allowed even though it's
 * used in npm scopes (e.g., '@types/node'). In dotnet tooling, '@file.rsp'
 * references response files that can contain arbitrary commands. Since we pass
 * files to dotnet format --include, allowing '@' could enable command injection.
 * npm scope directories work fine without special handling since we're passing
 * file paths, not package names.
 *
 * Note: Characters like '+', ';', '|', '&', '`', '$', '@', quotes are implicitly
 * rejected because they are NOT in the whitelist regex pattern.
 */
const SAFE_FILENAME_RE = /^[a-zA-Z0-9_.\-/]+$/

function isValidFilename(filename: string): boolean {
  // Reject empty filenames
  if (!filename) return false
  // Reject filenames that are too long (prevent DoS)
  if (filename.length > 500) return false
  // Reject path traversal
  if (filename.includes('..')) return false
  // Reject absolute paths
  if (filename.startsWith('/')) return false
  // Reject consecutive slashes (could bypass security checks)
  if (filename.includes('//')) return false
  // Reject flag-like filenames (e.g., '-v.ts' or '--verify-no-changes.ts')
  // These could be interpreted as CLI flags even with execFileSync
  // Reject both single-dash (-v) and double-dash (--flag) patterns
  if (filename.startsWith('-')) return false
  // Only allow whitelisted characters
  return SAFE_FILENAME_RE.test(filename)
}

/**
 * Defense-in-depth filter for flag-like filenames.
 *
 * This function is a safety net that should rarely trigger in practice because:
 * - isValidFilename() already rejects filenames starting with '-'
 * - filterValidFilenames() is called before this function
 *
 * However, if somehow a flag-like filename bypasses validation, this catches it.
 * Returns empty string for flag-like filenames (which is then filtered out).
 *
 * @param filename - Already-validated filename from filterValidFilenames()
 * @returns The filename unchanged, or empty string if it looks like a flag
 */
function prefixIfFlag(filename: string): string {
  // Defense-in-depth: catch any flag-like filename that somehow bypassed validation
  // This should never happen if isValidFilename() is working correctly
  if (filename.startsWith('-')) {
    console.warn(`[lint-runner] Security: Rejecting flag-like filename that bypassed validation: ${filename}`)
    return '' // Empty string will be filtered out by .filter(Boolean)
  }
  return filename
}

/**
 * Filter file list to only include valid filenames.
 * Logs a warning for any rejected filenames.
 */
function filterValidFilenames(files: string[]): string[] {
  return files.filter((f) => {
    if (!isValidFilename(f)) {
      console.warn(`Skipping invalid filename in lint: ${JSON.stringify(f)}`)
      return false
    }
    return true
  })
}

// ============================================================================
// Lint-specific result (extends StackRunnerResult with lint fields)
// ============================================================================

interface StackLintResult extends StackRunnerResult {
  filesChecked?: number
  files?: string[]
  findings?: LintFinding[]
}

// ============================================================================
// Lint Runner
// ============================================================================

/**
 * Run lint on changed files in the worktree and return a GateResult.
 *
 * When techStacks is provided and non-empty, runs the lint command for each
 * stack that has one configured, scoped to files matching that stack's
 * lintableExtensions. When not provided, falls back to legacy Node.js
 * detection for backward compatibility.
 */
export async function runLintRunner(
  worktreePath: string,
  sourceBranch: string,
  baseCommit?: string,
  techStacks?: TechStack[],
): Promise<GateResult> {
  // Multi-tech path: run per-stack lints
  if (techStacks && techStacks.length > 0) {
    return runMultiStackLint(worktreePath, sourceBranch, baseCommit, techStacks)
  }

  // Legacy path: detect from package.json (backward compat)
  return runLegacyLint(worktreePath, sourceBranch, baseCommit)
}

// ============================================================================
// Multi-Stack Lint Execution
// ============================================================================

/**
 * Run lint for each detected tech stack. Collects per-stack results and
 * aggregates the verdict: any fail → 'fail', all skip → 'skip', else 'pass'.
 */
function runMultiStackLint(
  worktreePath: string,
  sourceBranch: string,
  baseCommit: string | undefined,
  techStacks: TechStack[],
): GateResult {
  const timestamp = new Date().toISOString()
  const stackResults: StackLintResult[] = []

  for (const stack of techStacks) {
    const relPath = relative(worktreePath, stack.absolutePath) || '.'

    if (!stack.commands.lint) {
      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'skip',
      })
      continue
    }

    // For all stacks, scope to changed files matching stack extensions
    const rawChangedFiles = getChangedFilesByExtensions(
      worktreePath,
      sourceBranch,
      stack.lintableExtensions,
      baseCommit,
    )

    // Filter out any filenames with control characters for security
    const changedFiles = filterValidFilenames(rawChangedFiles)

    if (changedFiles.length === 0) {
      stackResults.push({
        type: stack.type,
        path: relPath,
        status: 'skip',
        filesChecked: 0,
      })
      continue
    }

    if (stack.type === 'node') {
      stackResults.push(runNodeLint(stack, relPath, changedFiles))
    } else if (stack.type === 'dotnet') {
      stackResults.push(runDotnetLint(stack, relPath, changedFiles))
    } else if (stack.type === 'python') {
      stackResults.push(runPythonLint(stack, relPath, changedFiles))
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
      ? `Lint failed (${parts.join(', ')})`
      : verdict === 'skip'
        ? `No lint commands configured or no lintable files changed — skipping lint gate`
        : `Lint passed (${parts.join(', ')})`

  return {
    verdict,
    checkName: 'lint',
    summary,
    details: { stacks: stackResults },
    timestamp,
  }
}

// ============================================================================
// Per-Tech Lint Execution
// ============================================================================

/**
 * Run Node.js lint (eslint-based). Uses `npm run lint -- {files}` or `npx eslint {files}`
 * depending on the detected command. Parses output with the eslint parser.
 *
 * Uses execFileSync with args array to avoid shell injection vulnerabilities.
 */
function runNodeLint(stack: TechStack, relPath: string, changedFiles: string[]): StackLintResult {
  // Build args array for execFileSync (avoids shell injection)
  let cmd: string
  let args: string[]

  // Prefix filenames with './' if they start with '-' to prevent flag injection
  // Filter out any empty strings (rejected flag-like filenames)
  const safeFiles = changedFiles.map(prefixIfFlag).filter(Boolean)

  if (safeFiles.length === 0) {
    return {
      type: stack.type,
      path: relPath,
      status: 'skip',
      filesChecked: 0,
      output: 'All files were filtered out as invalid',
    }
  }

  if (stack.commands.lint === 'npm run lint') {
    // npm run lint -- ./file1.ts ./file2.ts --max-warnings 0
    cmd = 'npm'
    args = ['run', 'lint', '--', ...safeFiles, '--max-warnings', '0']
  } else if (stack.commands.lint === 'npx eslint .') {
    // npx eslint ./file1.ts ./file2.ts --max-warnings 0
    cmd = 'npx'
    args = ['eslint', ...safeFiles, '--max-warnings', '0']
  } else {
    // Generic fallback: try to parse the lint command
    // For safety, only support known patterns
    cmd = 'npx'
    args = ['eslint', ...safeFiles, '--max-warnings', '0']
  }

  const lintCommand = `${cmd} ${args.join(' ')}` // For display only

  try {
    const output = execFileSync(cmd, args, {
      cwd: stack.absolutePath,
      encoding: 'utf-8',
      timeout: 120000,
      env: {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    })

    return {
      type: stack.type,
      path: relPath,
      status: 'pass',
      command: lintCommand,
      filesChecked: changedFiles.length,
      files: changedFiles,
      output: output.slice(-2000),
    }
  } catch (err) {
    const execError = err as { status?: number; stdout?: string; stderr?: string }
    const output = [execError.stdout || '', execError.stderr || ''].join('\n').trim()

    return {
      type: stack.type,
      path: relPath,
      status: 'fail',
      command: lintCommand,
      filesChecked: changedFiles.length,
      files: changedFiles,
      findings: parseEslintOutput(output),
      output: output.slice(-4000),
      exitCode: execError.status,
    }
  }
}

/**
 * Run .NET lint via `dotnet format --verify-no-changes`.
 * Scoped to changed files using `--include` flags.
 *
 * Uses execFileSync with args array to avoid shell injection vulnerabilities.
 * Each --include flag is passed as a separate argument.
 *
 * Security:
 * - Files starting with '-' are already rejected by isValidFilename() in the caller.
 * - The '@' character is now rejected by SAFE_FILENAME_RE to prevent response file injection
 *   (dotnet uses @file.rsp syntax to read commands from files).
 * - The '--include' flags are dotnet format OPTIONS, not file arguments. The '--' separator
 *   is placed AFTER all options to separate them from any positional arguments.
 */
function runDotnetLint(stack: TechStack, relPath: string, changedFiles: string[]): StackLintResult {
  // Build args array for execFileSync (avoids shell injection)
  // Note: Files starting with '-' and '@' are already rejected by isValidFilename() in the caller.
  // Format: dotnet format --verify-no-changes --include file1.cs --include file2.cs
  // The '--include' flags are OPTIONS to dotnet format, not positional file arguments.
  const args: string[] = ['format', '--verify-no-changes']
  for (const file of changedFiles) {
    args.push('--include', file)
  }

  // Add '--' separator at the end to clearly mark end of options (defense-in-depth)
  args.push('--')

  const lintCommand = `dotnet ${args.join(' ')}` // For display only

  try {
    const output = execFileSync('dotnet', args, {
      cwd: stack.absolutePath,
      encoding: 'utf-8',
      timeout: 120000,
      env: {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
        DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      },
    })

    return {
      type: stack.type,
      path: relPath,
      status: 'pass',
      command: lintCommand,
      filesChecked: changedFiles.length,
      files: changedFiles,
      output: output.slice(-2000),
    }
  } catch (err) {
    const execError = err as { status?: number; stdout?: string; stderr?: string }
    const output = [execError.stdout || '', execError.stderr || ''].join('\n').trim()

    return {
      type: stack.type,
      path: relPath,
      status: 'fail',
      command: lintCommand,
      filesChecked: changedFiles.length,
      files: changedFiles,
      findings: parseGenericOutput(output),
      output: output.slice(-4000),
      exitCode: execError.status,
    }
  }
}

/**
 * Run Python lint (ruff or flake8). Scoped to changed files.
 * Uses generic output parsing.
 *
 * Uses execFileSync with args array to avoid shell injection vulnerabilities.
 */
function runPythonLint(stack: TechStack, relPath: string, changedFiles: string[]): StackLintResult {
  // Build args array for execFileSync (avoids shell injection)
  let cmd: string
  let args: string[]

  // Prefix filenames with './' if they start with '-' to prevent flag injection
  // Filter out any empty strings (rejected flag-like filenames)
  const safeFiles = changedFiles.map(prefixIfFlag).filter(Boolean)

  if (safeFiles.length === 0) {
    return {
      type: stack.type,
      path: relPath,
      status: 'skip',
      filesChecked: 0,
      output: 'All files were filtered out as invalid',
    }
  }

  const baseLint = stack.commands.lint!
  if (baseLint === 'ruff check .') {
    // ruff check ./file1.py ./file2.py
    cmd = 'ruff'
    args = ['check', ...safeFiles]
  } else if (baseLint === 'flake8') {
    // flake8 ./file1.py ./file2.py
    cmd = 'flake8'
    args = [...safeFiles]
  } else {
    // Generic fallback: assume ruff-like pattern
    cmd = 'ruff'
    args = ['check', ...safeFiles]
  }

  const lintCommand = `${cmd} ${args.join(' ')}` // For display only

  try {
    const output = execFileSync(cmd, args, {
      cwd: stack.absolutePath,
      encoding: 'utf-8',
      timeout: 120000,
      env: {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    })

    return {
      type: stack.type,
      path: relPath,
      status: 'pass',
      command: lintCommand,
      filesChecked: changedFiles.length,
      files: changedFiles,
      output: output.slice(-2000),
    }
  } catch (err) {
    const execError = err as { status?: number; stdout?: string; stderr?: string }
    const output = [execError.stdout || '', execError.stderr || ''].join('\n').trim()

    return {
      type: stack.type,
      path: relPath,
      status: 'fail',
      command: lintCommand,
      filesChecked: changedFiles.length,
      files: changedFiles,
      findings: parseGenericOutput(output),
      output: output.slice(-4000),
      exitCode: execError.status,
    }
  }
}

// ============================================================================
// Legacy Lint Execution (backward compat)
// ============================================================================

/**
 * Original single-project lint runner. Used when no techStacks are provided.
 */
async function runLegacyLint(
  worktreePath: string,
  sourceBranch: string,
  baseCommit?: string,
): Promise<GateResult> {
  const timestamp = new Date().toISOString()

  // Get changed files (only lintable extensions)
  const rawChangedFiles = getChangedLintableFiles(worktreePath, sourceBranch, baseCommit)

  // Filter out any filenames with control characters for security
  const changedFiles = filterValidFilenames(rawChangedFiles)

  if (changedFiles.length === 0) {
    return {
      verdict: 'skip',
      checkName: 'lint',
      summary: 'No lintable files changed — skipping lint gate',
      details: { reason: 'no-changed-files' },
      timestamp,
    }
  }

  // Detect lint command
  const lintStrategy = await detectLintStrategy(worktreePath)
  if (!lintStrategy) {
    return {
      verdict: 'skip',
      checkName: 'lint',
      summary: 'No lint command found — skipping lint gate',
      details: { reason: 'no-lint-command' },
      timestamp,
    }
  }

  // Build the lint command scoped to changed files
  const lintCommand = buildLintCommand(lintStrategy, changedFiles)

  try {
    const output = execSync(lintCommand, {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 120000, // 2 minute timeout for lint
      env: {
        ...process.env,
        CI: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
    })

    return {
      verdict: 'pass',
      checkName: 'lint',
      summary: `Lint passed on ${changedFiles.length} changed file(s)`,
      details: {
        command: lintCommand,
        filesChecked: changedFiles.length,
        files: changedFiles,
        output: output.slice(-2000),
      },
      timestamp,
    }
  } catch (err) {
    const execError = err as { status?: number; stdout?: string; stderr?: string }
    const output = [execError.stdout || '', execError.stderr || ''].join('\n').trim()

    // Parse lint output for structured reporting
    const findings = parseEslintOutput(output)

    return {
      verdict: 'fail',
      checkName: 'lint',
      summary: `Lint failed: ${findings.length} issue(s) in ${changedFiles.length} changed file(s)`,
      details: {
        command: lintCommand,
        exitCode: execError.status,
        filesChecked: changedFiles.length,
        files: changedFiles,
        findings,
        output: output.slice(-4000),
      },
      timestamp,
    }
  }
}

// ============================================================================
// Lint Strategy Detection (legacy)
// ============================================================================

type LintStrategy = 'npm-lint' | 'npx-eslint'

async function detectLintStrategy(worktreePath: string): Promise<LintStrategy | null> {
  try {
    const pkgPath = join(worktreePath, 'package.json')
    const pkgJson = JSON.parse(await readFile(pkgPath, 'utf-8'))

    if (pkgJson.scripts?.lint) {
      return 'npm-lint'
    }

    // Check if eslint is a dependency
    const deps = {
      ...pkgJson.dependencies,
      ...pkgJson.devDependencies,
    }
    if (deps?.eslint) {
      return 'npx-eslint'
    }

    return null
  } catch {
    return null
  }
}

function buildLintCommand(strategy: LintStrategy, changedFiles: string[]): string {
  const fileList = changedFiles.map((f) => `"${f.replace(/["\\$`]/g, '\\$&')}"`).join(' ')

  switch (strategy) {
    case 'npm-lint':
      // npm run lint typically runs on all files — we pass changed files as extra args
      // This works with eslint-based lint scripts: "lint": "eslint src/"
      // The -- passes remaining args to eslint
      return `npm run lint -- ${fileList} --max-warnings 0`

    case 'npx-eslint':
      return `npx eslint ${fileList} --max-warnings 0`
  }
}

// ============================================================================
// Output Parsing
// ============================================================================

interface LintFinding {
  file: string
  line?: number
  column?: number
  rule?: string
  severity: string
  message: string
}

/**
 * Parse eslint-style output into structured findings.
 * Handles the default eslint formatter output.
 */
function parseEslintOutput(output: string): LintFinding[] {
  const findings: LintFinding[] = []
  let currentFile = ''

  for (const line of output.split('\n')) {
    const trimmed = line.trim()

    // File path line (e.g. "/path/to/file.ts")
    if (trimmed.startsWith('/') && !trimmed.includes('  ')) {
      currentFile = trimmed
      continue
    }

    // Error/warning line (e.g. "  3:10  error  'foo' is unused  no-unused-vars")
    const match = trimmed.match(/^(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(.+)$/)
    if (match && currentFile) {
      findings.push({
        file: currentFile,
        line: parseInt(match[1], 10),
        column: parseInt(match[2], 10),
        severity: match[3],
        message: match[4],
        rule: match[5],
      })
    }
  }

  return findings
}

/**
 * Parse generic linter output (ruff, flake8, dotnet format) into structured findings.
 * Handles common "file:line:col: message" formats.
 */
function parseGenericOutput(output: string): LintFinding[] {
  const findings: LintFinding[] = []

  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // Pattern: "file.py:10:5: E123 some message" (ruff / flake8 style)
    const match = trimmed.match(/^(.+?):(\d+):(\d+):\s+(\S+)\s+(.+)$/)
    if (match) {
      findings.push({
        file: match[1],
        line: parseInt(match[2], 10),
        column: parseInt(match[3], 10),
        rule: match[4],
        severity: 'error',
        message: match[5],
      })
      continue
    }

    // Pattern: "file.py:10: E123 some message" (no column)
    const matchNoCol = trimmed.match(/^(.+?):(\d+):\s+(\S+)\s+(.+)$/)
    if (matchNoCol) {
      findings.push({
        file: matchNoCol[1],
        line: parseInt(matchNoCol[2], 10),
        rule: matchNoCol[3],
        severity: 'error',
        message: matchNoCol[4],
      })
    }
  }

  return findings
}
