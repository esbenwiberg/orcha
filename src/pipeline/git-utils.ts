/**
 * Git Utilities
 *
 * Shared helpers for git diff retrieval and changed-file detection.
 * Used by gate agents and the fix-loop stage.
 */

import { execSync } from 'child_process'

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

const LINTABLE_EXTENSIONS = /\.(ts|js|tsx|jsx)$/

/**
 * Get the list of changed files (relative paths) that are lintable.
 * Uses git diff --name-only with extension filters.
 */
export function getChangedLintableFiles(worktreePath: string, sourceBranch: string, baseCommit?: string): string[] {
  const execOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 10000 }

  // Best strategy: diff from exact base commit
  if (baseCommit) {
    assertSafeCommitSha(baseCommit)
    try {
      const output = execSync(
        `git diff --name-only ${baseCommit}..HEAD -- '*.ts' '*.js' '*.tsx' '*.jsx'`,
        execOpts,
      ).trim()
      if (output) return output.split('\n').filter(Boolean)
    } catch { /* baseCommit may be unavailable */ }
  }

  assertSafeBranch(sourceBranch)

  try {
    const output = execSync(
      `git diff --name-only origin/${sourceBranch}... -- '*.ts' '*.js' '*.tsx' '*.jsx'`,
      execOpts,
    ).trim()
    if (output) return output.split('\n').filter(Boolean)
  } catch { /* origin/sourceBranch may not exist */ }

  try {
    const output = execSync(
      `git diff --name-only ${sourceBranch}... -- '*.ts' '*.js' '*.tsx' '*.jsx'`,
      execOpts,
    ).trim()
    if (output) return output.split('\n').filter(Boolean)
  } catch { /* sourceBranch may not exist locally */ }

  try {
    const output = execSync('git diff --name-only HEAD', execOpts).trim()
    if (output) {
      return output.split('\n').filter((f) => LINTABLE_EXTENSIONS.test(f))
    }
  } catch { /* Ignore */ }

  return []
}
