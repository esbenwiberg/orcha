/**
 * Context Builder
 *
 * Builds enhanced context for the fix agent, including:
 * - Full file contents for files mentioned in failures
 * - Attempt history summary
 * - Affected modules (directory tree)
 * - Related files (imports/exports within affected modules)
 */

import { readFile } from 'fs/promises'
import { join, dirname, relative } from 'path'
import { execSync } from 'child_process'
import type { PipelineRun, GateResult } from '../types.js'
import { getPipelineDir } from '../pipeline-store.js'

// ============================================================================
// Types
// ============================================================================

export interface EnhancedFixContext {
  /** Full file contents for files mentioned in failures. */
  fullFileContents: Record<string, string>
  /** Attempt history summary (what each attempt changed). */
  attemptHistory: string
  /** Affected modules (directory tree). */
  affectedModules: string
  /** Related files (imports/exports within affected modules). */
  relatedFiles: string[]
}

// ============================================================================
// Context Builder
// ============================================================================

/**
 * Build enhanced context for the fix agent.
 *
 * Extracts:
 * - Full file contents for all files mentioned in gate failures
 * - Attempt history summary from previous fix attempts
 * - Affected modules (directory tree for directories containing failures)
 * - Related files (within affected modules)
 */
export async function buildEnhancedFixContext(
  run: PipelineRun,
  gateResults: GateResult[],
): Promise<EnhancedFixContext> {
  // Extract files mentioned in failures
  const failedFiles = extractFailedFiles(gateResults)

  // Load full file contents for failed files
  const fullFileContents = await loadFullFileContents(run.worktreePath, failedFiles)

  // Load attempt history from previous fix loops
  const attemptHistory = await loadAttemptHistory(run)

  // Build affected modules tree
  const affectedModules = buildAffectedModulesTree(run.worktreePath, failedFiles)

  // Find related files in affected modules
  const relatedFiles = findRelatedFiles(run.worktreePath, failedFiles)

  return {
    fullFileContents,
    attemptHistory,
    affectedModules,
    relatedFiles,
  }
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extract file paths mentioned in gate failure details.
 * Looks for:
 * - details.file field
 * - details.files array
 * - file paths in summary text (basic pattern matching)
 */
function extractFailedFiles(gateResults: GateResult[]): string[] {
  const files = new Set<string>()

  for (const result of gateResults) {
    if (result.verdict !== 'fail') continue

    // Check details.file
    if (result.details?.file && typeof result.details.file === 'string') {
      files.add(result.details.file)
    }

    // Check details.files array
    if (Array.isArray(result.details?.files)) {
      for (const f of result.details.files) {
        if (typeof f === 'string') files.add(f)
      }
    }

    // Check details.findings array (security/code review)
    if (Array.isArray(result.details?.findings)) {
      for (const finding of result.details.findings) {
        if (finding.file && typeof finding.file === 'string') {
          files.add(finding.file)
        }
      }
    }

    // Extract file paths from summary (basic pattern: path/to/file.ext)
    const summaryMatches = result.summary.match(/\b[\w\-./]+\.(ts|js|py|cs|go|rs|tsx|jsx)\b/g)
    if (summaryMatches) {
      for (const match of summaryMatches) {
        files.add(match)
      }
    }
  }

  return Array.from(files)
}

/**
 * Load full file contents for the given file paths.
 * Returns a map of file path to contents.
 * Skips files that don't exist or can't be read.
 */
async function loadFullFileContents(
  worktreePath: string,
  filePaths: string[],
): Promise<Record<string, string>> {
  const contents: Record<string, string> = {}

  for (const filePath of filePaths) {
    try {
      const absolutePath = join(worktreePath, filePath)
      const content = await readFile(absolutePath, 'utf-8')
      contents[filePath] = content
    } catch {
      // File doesn't exist or can't be read — skip it
      continue
    }
  }

  return contents
}

/**
 * Load attempt history from previous fix-loop iterations.
 * Returns a formatted string summarizing what each attempt changed.
 */
async function loadAttemptHistory(run: PipelineRun): Promise<string> {
  const fixLoopsDir = join(getPipelineDir(run.id), 'fix-loops')
  const attempts: string[] = []

  // Load meta.json for each previous attempt
  for (let i = 1; i < run.fixLoopCount; i++) {
    try {
      const metaPath = join(fixLoopsDir, `attempt-${i}`, 'meta.json')
      const metaContent = await readFile(metaPath, 'utf-8')
      const meta = JSON.parse(metaContent)

      const summary = [
        `**Attempt ${i}**:`,
        `- Model: ${meta.model ?? 'unknown'}`,
        `- Commit: ${meta.commitSha ?? 'unknown'}`,
        `- Outcome: ${meta.gateResults ? (meta.gateResults.some((r: GateResult) => r.verdict === 'fail') ? 'Failed gate' : 'Passed gate') : 'Not re-gated yet'}`,
      ]

      if (meta.failureReport) {
        const firstFailureLine = meta.failureReport.split('\n')[0]
        summary.push(`- Issue: ${firstFailureLine}`)
      }

      attempts.push(summary.join('\n'))
    } catch {
      // Meta file doesn't exist or can't be read — skip this attempt
      continue
    }
  }

  if (attempts.length === 0) {
    return 'No previous fix attempts.'
  }

  return attempts.join('\n\n')
}

/**
 * Build a directory tree for modules containing failed files.
 * Returns a formatted tree string.
 */
function buildAffectedModulesTree(worktreePath: string, failedFiles: string[]): string {
  if (failedFiles.length === 0) {
    return '(No files identified in failures)'
  }

  // Extract unique directories from failed files
  const dirs = new Set<string>()
  for (const file of failedFiles) {
    const dir = dirname(file)
    if (dir !== '.') {
      dirs.add(dir)
    }
  }

  if (dirs.size === 0) {
    return '(Failed files are all in root directory)'
  }

  // For each directory, get a tree listing (max 2 levels deep)
  const trees: string[] = []
  for (const dir of dirs) {
    try {
      const tree = execSync(
        `find "${dir}" -maxdepth 2 -type f -name '*.ts' -o -name '*.js' -o -name '*.py' -o -name '*.cs' -o -name '*.go' -o -name '*.rs' | head -30 | sort`,
        { cwd: worktreePath, encoding: 'utf-8', timeout: 5000 },
      ).trim()

      if (tree) {
        trees.push(`## ${dir}/\n${tree}`)
      }
    } catch {
      // Ignore errors
      continue
    }
  }

  return trees.join('\n\n') || '(Unable to build module tree)'
}

/**
 * Find related files in affected modules.
 * Looks for files that import or export from failed files.
 * Returns a list of related file paths.
 */
function findRelatedFiles(worktreePath: string, failedFiles: string[]): string[] {
  const related = new Set<string>()

  for (const file of failedFiles) {
    // Extract module name (file without extension)
    const moduleName = file.replace(/\.(ts|js|tsx|jsx|py|cs|go|rs)$/, '')
    const baseName = moduleName.split('/').pop()

    if (!baseName) continue

    try {
      // Search for imports/exports referencing this file
      // Use a simple grep pattern: import/require/from statements mentioning the file
      const pattern = `(import|from|require).*${baseName}`
      const matches = execSync(
        `grep -r -l -E "${pattern}" --include="*.ts" --include="*.js" --include="*.tsx" --include="*.jsx" --include="*.py" . 2>/dev/null | head -20`,
        { cwd: worktreePath, encoding: 'utf-8', timeout: 5000 },
      ).trim()

      if (matches) {
        for (const match of matches.split('\n')) {
          // Convert ./path to path
          const cleanPath = match.replace(/^\.\//, '')
          if (cleanPath !== file) {
            related.add(cleanPath)
          }
        }
      }
    } catch {
      // Ignore errors (grep may fail if no matches or pattern issues)
      continue
    }
  }

  return Array.from(related)
}
