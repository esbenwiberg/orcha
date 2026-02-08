/**
 * Git Utilities
 *
 * Shared helpers for git diff retrieval and changed-file detection.
 * Used by gate agents and the fix-loop stage.
 */

import { execSync } from 'child_process'

// ============================================================================
// Diff Retrieval
// ============================================================================

/**
 * Get the diff between the current HEAD and the source branch.
 * Tries multiple fallback strategies:
 * 1. origin/sourceBranch...HEAD (most reliable)
 * 2. sourceBranch...HEAD (local fallback)
 * 3. HEAD~1 (last resort)
 *
 * Returns null if no diff can be obtained.
 */
export function getDiff(worktreePath: string, sourceBranch: string): string | null {
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
// Changed Files Detection
// ============================================================================

const LINTABLE_EXTENSIONS = /\.(ts|js|tsx|jsx)$/

/**
 * Get the list of changed files (relative paths) that are lintable.
 * Uses git diff --name-only with extension filters.
 */
export function getChangedLintableFiles(worktreePath: string, sourceBranch: string): string[] {
  const execOpts = { cwd: worktreePath, encoding: 'utf-8' as const, timeout: 10000 }

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
