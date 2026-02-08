/**
 * Gate Agent: Lint Runner
 *
 * Shell-only gate agent — no AI session needed.
 * Runs lint scoped to changed files only (compared to the source branch).
 *
 * Discovery order:
 * 1. `npm run lint` if "lint" script exists in package.json
 * 2. `npx eslint` as fallback
 *
 * Uses `--max-warnings 0` for strict mode — any warning = gate failure.
 * Only lints files matching *.ts, *.js, *.tsx, *.jsx.
 */

import { readFile } from 'fs/promises'
import { join } from 'path'
import { execSync } from 'child_process'
import type { GateResult } from '../types.js'
import { getChangedLintableFiles } from '../git-utils.js'

// ============================================================================
// Lint Runner
// ============================================================================

/**
 * Run lint on changed files in the worktree and return a GateResult.
 */
export async function runLintRunner(
  worktreePath: string,
  sourceBranch: string,
): Promise<GateResult> {
  const timestamp = new Date().toISOString()

  // Get changed files (only lintable extensions)
  const changedFiles = getChangedLintableFiles(worktreePath, sourceBranch)

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
    const findings = parseLintOutput(output)

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
// Lint Strategy Detection
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
  const fileList = changedFiles.map((f) => `"${f}"`).join(' ')

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
function parseLintOutput(output: string): LintFinding[] {
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
