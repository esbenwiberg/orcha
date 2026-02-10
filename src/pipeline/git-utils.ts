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
// Rejects: wildcards (*), question marks (?), brackets ([]), and other glob special chars.
const SAFE_EXTENSION_RE = /^\.[a-zA-Z0-9]+$/

/** Maximum number of unsafe filenames to log (prevents log flooding). */
const MAX_UNSAFE_FILENAME_WARNINGS = 10

/**
 * Validate that a filename is safe (no path traversal or absolute paths).
 * Returns true if the filename is safe to use.
 *
 * Security: Rejects paths containing:
 * - '..' (path traversal)
 * - '/' at start (absolute paths)
 * - '\' (Windows-style paths that could be traversal on some systems)
 * - '%' (URL-encoded sequences like %2e%2e)
 * - null bytes
 */
function isSafeFilename(filename: string): boolean {
  // Reject absolute paths
  if (filename.startsWith('/')) return false
  // Reject path traversal sequences
  if (filename.includes('..')) return false
  // Reject null bytes
  if (filename.includes('\x00')) return false
  // Reject backslashes (Windows-style paths)
  if (filename.includes('\\')) return false
  // Reject URL-encoded sequences (could bypass '..' checks via %2e%2e)
  if (filename.includes('%')) return false
  return true
}

/**
 * Filter a list of filenames to only include safe ones.
 * Logs a warning for rejected filenames (rate-limited to prevent log flooding).
 *
 * Security: If ANY unsafe filenames are detected, logs a warning but continues
 * with the safe subset. This prevents a single malicious file from blocking
 * legitimate operations while still protecting against path traversal attacks.
 * The warning enables detection of potential attacks in logs.
 */
function filterSafeFilenames(filenames: string[]): string[] {
  const safeFiles: string[] = []
  const unsafeFiles: string[] = []

  for (const f of filenames) {
    if (isSafeFilename(f)) {
      safeFiles.push(f)
    } else {
      unsafeFiles.push(f)
    }
  }

  if (unsafeFiles.length > 0) {
    // Rate-limit logging to prevent log flooding from malicious repos with many bad filenames
    const samplesToLog = unsafeFiles.slice(0, MAX_UNSAFE_FILENAME_WARNINGS)
    const remaining = unsafeFiles.length - samplesToLog.length
    const suffix = remaining > 0 ? ` (and ${remaining} more)` : ''
    console.warn(
      `[git-utils] Filtered ${unsafeFiles.length} unsafe filename(s) from git diff: ${JSON.stringify(samplesToLog)}${suffix}`
    )
  }

  return safeFiles
}

/**
 * Validate that an extension is safe for use in git pathspecs.
 * Throws if the extension doesn't match the safe pattern or is too long.
 *
 * Security:
 * - Length limit prevents memory exhaustion from extremely long strings
 * - Pattern validation ensures only alphanumeric extensions (no wildcards or glob chars)
 * - Must start with '.' to be a valid extension
 * - Rejects: *, ?, [, ], {, }, and other glob metacharacters
 */
function assertSafeExtension(ext: string): void {
  // Must start with '.'
  if (!ext.startsWith('.')) {
    throw new Error(`Invalid file extension (must start with '.'): ${ext}`)
  }
  // Limit extension length to prevent memory issues (10 chars like ".typescript" is more than enough)
  if (ext.length > 10) {
    throw new Error(`File extension too long: ${ext}`)
  }
  // Explicitly reject glob metacharacters that could expand to unintended files
  if (/[*?[\]{}]/.test(ext)) {
    throw new Error(`Invalid file extension (contains glob metacharacters): ${ext}`)
  }
  // Explicitly reject shell command separators (defense-in-depth, regex also rejects these)
  if (/[;|&`$]/.test(ext)) {
    throw new Error(`Invalid file extension (contains shell metacharacters): ${ext}`)
  }
  // SAFE_EXTENSION_RE only allows alphanumeric characters after the dot
  // This is the primary security check - all characters must be alphanumeric
  if (!SAFE_EXTENSION_RE.test(ext)) {
    throw new Error(`Invalid file extension: ${ext}`)
  }
}

/**
 * Build a regex that matches any of the given extensions at the end of a filename.
 * e.g. ['.cs', '.fs'] → /\.(cs|fs)$/
 *
 * Security: The pattern is anchored to end-of-string ($) to prevent matching files
 * like 'test.ts.backup' when looking for '.ts' files.
 */
function buildExtensionRegex(extensions: string[]): RegExp {
  // Escape regex special characters in each extension (after removing leading dot)
  const alts = extensions.map((ext) => ext.replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  // Pattern: \.(ext1|ext2)$ — anchored to end of string
  return new RegExp(`\\.(${alts.join('|')})$`)
}

/**
 * Validate that a pathspec is safe (no command substitution or shell metacharacters).
 * Defense-in-depth: even though execFileSync prevents shell injection, we validate
 * pathspecs to prevent any potential issues with git's pathspec parsing.
 *
 * Security: Rejects pathspecs containing:
 * - Command substitution chars: $, `, |
 * - Shell separators: ;, &
 * - Newlines (could affect git argument parsing)
 */
function isValidPathspec(pathspec: string): boolean {
  if (!pathspec || pathspec.length === 0) return false
  // Reject command substitution and shell metacharacters
  if (/[$`|;&\n\r]/.test(pathspec)) return false
  return true
}

/**
 * Build git diff args array for execFileSync.
 * Returns args array: ['diff', '--name-only', ...range, '--', ...pathspecs]
 *
 * Security: Uses execFileSync with args array to prevent shell injection.
 * Filters out empty and invalid pathspecs to prevent issues.
 */
function buildDiffArgs(range: string[], pathspecs: string[]): string[] {
  // Filter out empty and invalid pathspecs
  // This is defense-in-depth — callers should already validate via assertSafeExtension
  const filteredPathspecs = pathspecs.filter(isValidPathspec)
  return ['diff', '--name-only', ...range, '--', ...filteredPathspecs]
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
      if (output) return filterSafeFilenames(output.split('\n').filter(Boolean))
    } catch { /* baseCommit may be unavailable */ }
  }

  assertSafeBranch(sourceBranch)

  try {
    const args = buildDiffArgs([`origin/${sourceBranch}...HEAD`], pathspecs)
    const output = execFileSync('git', args, execOpts).trim()
    if (output) return filterSafeFilenames(output.split('\n').filter(Boolean))
  } catch { /* origin/sourceBranch may not exist */ }

  try {
    const args = buildDiffArgs([`${sourceBranch}...HEAD`], pathspecs)
    const output = execFileSync('git', args, execOpts).trim()
    if (output) return filterSafeFilenames(output.split('\n').filter(Boolean))
  } catch { /* sourceBranch may not exist locally */ }

  try {
    const args = buildDiffArgs(['HEAD'], [])
    const output = execFileSync('git', args, execOpts).trim()
    if (output) {
      const extRegex = buildExtensionRegex(extensions)
      return filterSafeFilenames(output.split('\n').filter((f) => extRegex.test(f)))
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
