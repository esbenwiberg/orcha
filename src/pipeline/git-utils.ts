/**
 * Git Utilities
 *
 * Shared helpers for git diff retrieval and changed-file detection.
 * Used by gate agents and the fix-loop stage.
 *
 * All functions are ASYNC to avoid blocking the Node.js event loop.
 */

import { execAsync, execFileAsync } from './exec-utils.js'

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
export async function getHeadSha(worktreePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execAsync('git rev-parse HEAD', {
      cwd: worktreePath,
      timeout: 5000,
    })
    return stdout.trim() || undefined
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
export async function getDiff(worktreePath: string, sourceBranch: string, baseCommit?: string): Promise<string | null> {
  const execOpts = { cwd: worktreePath, timeout: 10000 }

  // Best strategy: diff from the exact base commit captured at pipeline start
  if (baseCommit) {
    assertSafeCommitSha(baseCommit)
    try {
      const { stdout } = await execAsync(`git diff ${baseCommit}..HEAD`, execOpts)
      const diff = stdout.trim()
      if (diff) return diff
    } catch { /* baseCommit may have been garbage-collected or rebased away */ }
  }

  assertSafeBranch(sourceBranch)

  try {
    const { stdout } = await execAsync(`git diff origin/${sourceBranch}...HEAD`, execOpts)
    const diff = stdout.trim()
    if (diff) return diff
  } catch { /* origin/sourceBranch may not exist */ }

  try {
    const { stdout } = await execAsync(`git diff ${sourceBranch}...HEAD`, execOpts)
    const diff = stdout.trim()
    if (diff) return diff
  } catch { /* sourceBranch may not exist locally */ }

  try {
    const { stdout } = await execAsync('git diff HEAD~1', execOpts)
    const diff = stdout.trim()
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
 */
function assertSafeExtension(ext: string): void {
  if (!ext.startsWith('.')) {
    throw new Error(`Invalid file extension (must start with '.'): ${ext}`)
  }
  if (ext.length > 10) {
    throw new Error(`File extension too long: ${ext}`)
  }
  if (/[*?[\]{}]/.test(ext)) {
    throw new Error(`Invalid file extension (contains glob metacharacters): ${ext}`)
  }
  if (/[;|&`$]/.test(ext)) {
    throw new Error(`Invalid file extension (contains shell metacharacters): ${ext}`)
  }
  if (!SAFE_EXTENSION_RE.test(ext)) {
    throw new Error(`Invalid file extension: ${ext}`)
  }
}

/**
 * Build a regex that matches any of the given extensions at the end of a filename.
 */
function buildExtensionRegex(extensions: string[]): RegExp {
  const alts = extensions.map((ext) => ext.replace(/^\./, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`\\.(${alts.join('|')})$`)
}

/**
 * Validate that a pathspec is safe.
 */
function isValidPathspec(pathspec: string): boolean {
  if (!pathspec || pathspec.length === 0) return false
  if (/[$`|;&\n\r]/.test(pathspec)) return false
  return true
}

/**
 * Validate a git range argument.
 */
const SAFE_RANGE_RE = /^[a-zA-Z0-9._/-]+$/

function isValidRangeArg(arg: string): boolean {
  if (!arg || arg.length === 0) return false
  if (arg.length > 200) return false
  if (arg === '--') return false
  if (!SAFE_RANGE_RE.test(arg)) return false
  if (arg.includes('../')) return false
  if (arg.includes('/..')) return false
  if (arg.includes('./.')) return false
  if (arg.startsWith('..')) return false
  if (arg.includes('//')) return false
  return true
}

/**
 * Build git diff args array for execFileAsync.
 */
function buildDiffArgs(range: string[], pathspecs: string[]): string[] {
  const filteredPathspecs = pathspecs.filter(isValidPathspec)

  const safePathspecs = filteredPathspecs.filter((p) => {
    if (p.startsWith('-')) {
      console.warn(`[git-utils] Rejecting pathspec starting with '-': ${p}`)
      return false
    }
    return true
  })

  const safeRange = range.filter((r) => {
    if (!isValidRangeArg(r)) {
      console.warn(`[git-utils] Rejecting invalid range argument: ${JSON.stringify(r).slice(0, 50)}`)
      return false
    }
    return true
  })

  return ['diff', '--name-only', ...safeRange, '--', ...safePathspecs]
}

/**
 * Get the list of changed files (relative paths) matching the given extensions.
 * Uses git diff --name-only with extension filters.
 *
 * Security: Uses execFileAsync with args array to prevent command injection.
 */
export async function getChangedFilesByExtensions(
  worktreePath: string,
  sourceBranch: string,
  extensions: string[],
  baseCommit?: string,
): Promise<string[]> {
  if (extensions.length === 0) return []

  const execOpts = { cwd: worktreePath, timeout: 10000 }

  for (const ext of extensions) {
    assertSafeExtension(ext)
  }

  const pathspecs = extensions.map((ext) => `*${ext}`)

  // Best strategy: diff from exact base commit
  if (baseCommit) {
    assertSafeCommitSha(baseCommit)
    try {
      const args = buildDiffArgs([`${baseCommit}..HEAD`], pathspecs)
      const { stdout } = await execFileAsync('git', args, execOpts)
      const output = stdout.trim()
      if (output) return filterSafeFilenames(output.split('\n').filter(Boolean))
    } catch { /* baseCommit may be unavailable */ }
  }

  assertSafeBranch(sourceBranch)

  try {
    const args = buildDiffArgs([`origin/${sourceBranch}...HEAD`], pathspecs)
    const { stdout } = await execFileAsync('git', args, execOpts)
    const output = stdout.trim()
    if (output) return filterSafeFilenames(output.split('\n').filter(Boolean))
  } catch { /* origin/sourceBranch may not exist */ }

  try {
    const args = buildDiffArgs([`${sourceBranch}...HEAD`], pathspecs)
    const { stdout } = await execFileAsync('git', args, execOpts)
    const output = stdout.trim()
    if (output) return filterSafeFilenames(output.split('\n').filter(Boolean))
  } catch { /* sourceBranch may not exist locally */ }

  try {
    const args = buildDiffArgs(['HEAD'], [])
    const { stdout } = await execFileAsync('git', args, execOpts)
    const output = stdout.trim()
    if (output) {
      const extRegex = buildExtensionRegex(extensions)
      return filterSafeFilenames(output.split('\n').filter((f) => extRegex.test(f)))
    }
  } catch { /* Ignore */ }

  return []
}

/**
 * Get the list of changed files (relative paths) that are lintable (JS/TS).
 */
export async function getChangedLintableFiles(worktreePath: string, sourceBranch: string, baseCommit?: string): Promise<string[]> {
  return getChangedFilesByExtensions(worktreePath, sourceBranch, ['.ts', '.js', '.tsx', '.jsx'], baseCommit)
}
