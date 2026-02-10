/**
 * Git Utilities
 *
 * Shared helpers for git diff retrieval and changed-file detection.
 * Used by gate agents and the fix-loop stage.
 */

import { execSync, execFileSync } from 'child_process'

// ============================================================================
// Branch Name Validation
// ============================================================================

const SAFE_BRANCH_RE = /^[a-zA-Z0-9\/_.\-]+$/

function assertSafeBranch(branch: string): void {
  if (!SAFE_BRANCH_RE.test(branch)) {
    throw new Error(`Invalid branch name: ${branch}`)
  }
}

// ============================================================================
// Commit SHA Validation
// ============================================================================

const SAFE_SHA_RE = /^[a-f0-9]{7,40}$/i

function assertSafeCommitSha(sha: string): void {
  if (!SAFE_SHA_RE.test(sha)) {
    throw new Error(`Invalid commit SHA: ${sha}`)
  }
}

// ============================================================================
// HEAD SHA Retrieval
// ============================================================================

/**
 * Get the current HEAD commit SHA.
 * Used to snapshot the base commit at pipeline creation time.
 */
export function getHeadSha(worktreePath: string): string | undefined {
  try {
    return execSync('git rev-parse HEAD', {
      cwd: worktreePath,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim() || undefined
  } catch {
    return undefined
  }
}

// ============================================================================
// Diff Retrieval
// ============================================================================

/**
 * Get the diff between the current HEAD and the base commit or source branch.
 *
 * Strategy order:
 * 1. baseCommit..HEAD (exact — uses the snapshot from pipeline creation)
 * 2. origin/sourceBranch...HEAD (three-dot merge-base)
 * 3. sourceBranch...HEAD (local fallback)
 * 4. HEAD~1 (last resort)
 *
 * Returns null if no diff can be obtained.
 */
export function getDiff(worktreePath: string, sourceBranch: string, baseCommit?: string): string | null {
  const execOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 10000 }

  // Best strategy: diff from the exact base commit captured at pipeline start
  if (baseCommit) {
    assertSafeCommitSha(baseCommit)
    try {
      const diff = execSync(`git diff ${baseCommit}..HEAD`, execOpts).trim()
      if (diff) return diff
    } catch { /* baseCommit may have been garbage-collected or rebased away */ }
  }

  assertSafeBranch(sourceBranch)

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
// Changed Files Detection
// ============================================================================

// Strict validation pattern for file extensions to prevent command injection.
// Only allows extensions like .ts, .js, .cs, .py, etc.
const SAFE_EXTENSION_RE = /^\.[a-zA-Z0-9]+$/

/**
 * Validate that an extension is safe for use in shell commands.
 * Throws if the extension doesn't match the safe pattern.
 */
function assertSafeExtension(ext: string): void {
  if (!SAFE_EXTENSION_RE.test(ext)) {
    throw new Error(`Invalid file extension: ${ext}`)
  }
}

/**
 * Build a regex that matches any of the given extensions at the end of a filename.
 * e.g. ['.cs', '.fs'] → /\.(cs|fs)$/
 */
function buildExtensionRegex(extensions: string[]): RegExp {
  const alts = extensions.map((ext) => ext.replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\.(${alts.join('|')})$`)
}

/**
 * Build git diff args array for execFileSync.
 * Returns args array: ['diff', '--name-only', ...range, '--', ...pathspecs]
 *
 * Security: Uses execFileSync with args array to prevent shell injection.
 */
function buildDiffArgs(range: string[], pathspecs: string[]): string[] {
  return ['diff', '--name-only', ...range, '--', ...pathspecs]
}

/**
 * Get the list of changed files (relative paths) matching the given extensions.
 * Uses git diff --name-only with extension filters.
 *
 * Strategy order (same as getDiff):
 * 1. baseCommit..HEAD (exact)
 * 2. origin/sourceBranch...HEAD (three-dot merge-base)
 * 3. sourceBranch...HEAD (local fallback)
 * 4. HEAD (last resort — filters with regex since pathspec may not apply)
 *
 * Security: Uses execFileSync with args array to prevent command injection.
 */
export function getChangedFilesByExtensions(
  worktreePath: string,
  sourceBranch: string,
  extensions: string[],
  baseCommit?: string,
): string[] {
  if (extensions.length === 0) return []

  const execOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 10000 }

  // Validate extensions and build pathspecs (e.g., ['*.ts', '*.js'])
  const pathspecs = extensions.map((ext) => {
    assertSafeExtension(ext)
    return `*${ext}`
  })

  // Best strategy: diff from exact base commit
  if (baseCommit) {
    assertSafeCommitSha(baseCommit)
    try {
      const args = buildDiffArgs([`${baseCommit}..HEAD`], pathspecs)
      const output = execFileSync('git', args, execOpts).trim()
      if (output) return output.split('\n').filter(Boolean)
    } catch { /* baseCommit may be unavailable */ }
  }

  assertSafeBranch(sourceBranch)

  try {
    const args = buildDiffArgs([`origin/${sourceBranch}...HEAD`], pathspecs)
    const output = execFileSync('git', args, execOpts).trim()
    if (output) return output.split('\n').filter(Boolean)
  } catch { /* origin/sourceBranch may not exist */ }

  try {
    const args = buildDiffArgs([`${sourceBranch}...HEAD`], pathspecs)
    const output = execFileSync('git', args, execOpts).trim()
    if (output) return output.split('\n').filter(Boolean)
  } catch { /* sourceBranch may not exist locally */ }

  try {
    const args = buildDiffArgs(['HEAD'], [])
    const output = execFileSync('git', args, execOpts).trim()
    if (output) {
      const extRegex = buildExtensionRegex(extensions)
      return output.split('\n').filter((f) => extRegex.test(f))
    }
  } catch { /* Ignore */ }

  return []
}

/**
 * Get the list of changed files (relative paths) that are lintable (JS/TS).
 * Convenience wrapper around getChangedFilesByExtensions for backward compatibility.
 */
export function getChangedLintableFiles(worktreePath: string, sourceBranch: string, baseCommit?: string): string[] {
  return getChangedFilesByExtensions(worktreePath, sourceBranch, ['.ts', '.js', '.tsx', '.jsx'], baseCommit)
}
