/**
 * Attempt Tracker
 *
 * Tracks fix-loop attempts and summarizes what each attempt changed.
 * Uses simple heuristics to detect changes:
 * - Files modified in diff
 * - Functions/classes added/removed (naive pattern matching)
 */

import type { AttemptHistory } from '../types.js'

// ============================================================================
// Types
// ============================================================================

export interface AttemptTrackerOptions {
  /** Initial attempt history (for loading from persisted state). */
  initialHistory?: AttemptHistory[]
}

// ============================================================================
// Attempt Tracker Class
// ============================================================================

export class AttemptTracker {
  private history: AttemptHistory[]

  constructor(opts?: AttemptTrackerOptions) {
    this.history = opts?.initialHistory ?? []
  }

  /**
   * Record a fix attempt with its failure report and diff.
   */
  recordAttempt(attempt: number, failureReport: string, diff: string): void {
    const summary = this.summarizeAttempt(attempt, failureReport, diff)

    this.history.push({
      attempt,
      failureReport,
      diff,
      summary,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Summarize what a fix attempt tried to do based on the diff.
   * Uses heuristics to detect:
   * - Files modified
   * - Functions/classes added or removed
   * - Lines changed
   */
  summarizeAttempt(attempt: number, failureReport: string, diff: string): string {
    const filesModified = this.extractModifiedFiles(diff)
    const functionsChanged = this.extractFunctionChanges(diff)
    const linesChanged = this.countLinesChanged(diff)

    const parts: string[] = []

    // Extract the primary failure type from the report
    const failureType = this.extractFailureType(failureReport)
    if (failureType) {
      parts.push(`Attempted to fix: ${failureType}`)
    }

    // Files modified
    if (filesModified.length > 0) {
      if (filesModified.length <= 3) {
        parts.push(`Modified: ${filesModified.join(', ')}`)
      } else {
        parts.push(`Modified ${filesModified.length} files: ${filesModified.slice(0, 3).join(', ')} and ${filesModified.length - 3} more`)
      }
    }

    // Functions changed
    if (functionsChanged.added.length > 0) {
      parts.push(`Added: ${functionsChanged.added.slice(0, 3).join(', ')}${functionsChanged.added.length > 3 ? ' and more' : ''}`)
    }
    if (functionsChanged.removed.length > 0) {
      parts.push(`Removed: ${functionsChanged.removed.slice(0, 3).join(', ')}${functionsChanged.removed.length > 3 ? ' and more' : ''}`)
    }

    // Lines changed
    parts.push(`${linesChanged.added} lines added, ${linesChanged.removed} lines removed`)

    return parts.join('. ')
  }

  /**
   * Get the full attempt history.
   */
  getHistory(): AttemptHistory[] {
    return [...this.history]
  }

  /**
   * Get a formatted summary of all attempts for inclusion in prompts.
   */
  getFormattedHistory(): string {
    if (this.history.length === 0) {
      return 'No previous attempts.'
    }

    return this.history.map((h) => {
      return `**Attempt ${h.attempt}** (${h.timestamp}):\n${h.summary}`
    }).join('\n\n')
  }

  // ============================================================================
  // Heuristic Helpers
  // ============================================================================

  /**
   * Extract file paths from diff headers.
   */
  private extractModifiedFiles(diff: string): string[] {
    const files = new Set<string>()
    const lines = diff.split('\n')

    for (const line of lines) {
      // Match diff headers: diff --git a/path/to/file b/path/to/file
      const match = line.match(/^diff --git a\/(.+) b\//)
      if (match) {
        files.add(match[1])
      }
    }

    return Array.from(files)
  }

  /**
   * Extract function/class names from added/removed lines.
   * Uses naive pattern matching for common languages.
   */
  private extractFunctionChanges(diff: string): { added: string[]; removed: string[] } {
    const added = new Set<string>()
    const removed = new Set<string>()
    const lines = diff.split('\n')

    for (const line of lines) {
      // Added line
      if (line.startsWith('+')) {
        const functions = this.extractFunctionNames(line.slice(1))
        for (const fn of functions) added.add(fn)
      }

      // Removed line
      if (line.startsWith('-')) {
        const functions = this.extractFunctionNames(line.slice(1))
        for (const fn of functions) removed.add(fn)
      }
    }

    return {
      added: Array.from(added),
      removed: Array.from(removed),
    }
  }

  /**
   * Extract function/class names from a single line.
   * Patterns:
   * - TypeScript/JavaScript: function name(...), const name = (...) =>, class Name
   * - Python: def name(...):, class Name:
   * - C#/Go: func Name(...), class Name
   */
  private extractFunctionNames(line: string): string[] {
    const names: string[] = []

    // TypeScript/JavaScript function declaration
    const tsFuncMatch = line.match(/\bfunction\s+(\w+)\s*\(/i)
    if (tsFuncMatch) names.push(tsFuncMatch[1])

    // TypeScript/JavaScript arrow function
    const tsArrowMatch = line.match(/\bconst\s+(\w+)\s*=.*=>/i)
    if (tsArrowMatch) names.push(tsArrowMatch[1])

    // TypeScript/JavaScript async function
    const tsAsyncMatch = line.match(/\basync\s+function\s+(\w+)\s*\(/i)
    if (tsAsyncMatch) names.push(tsAsyncMatch[1])

    // Python function
    const pyFuncMatch = line.match(/\bdef\s+(\w+)\s*\(/i)
    if (pyFuncMatch) names.push(pyFuncMatch[1])

    // Class declaration (all languages)
    const classMatch = line.match(/\bclass\s+(\w+)/i)
    if (classMatch) names.push(classMatch[1])

    // Interface declaration (TypeScript)
    const interfaceMatch = line.match(/\binterface\s+(\w+)/i)
    if (interfaceMatch) names.push(interfaceMatch[1])

    // Type alias (TypeScript)
    const typeMatch = line.match(/\btype\s+(\w+)\s*=/i)
    if (typeMatch) names.push(typeMatch[1])

    return names
  }

  /**
   * Count added and removed lines in diff.
   */
  private countLinesChanged(diff: string): { added: number; removed: number } {
    const lines = diff.split('\n')
    let added = 0
    let removed = 0

    for (const line of lines) {
      // Don't count diff metadata lines (diff, index, +++, ---)
      if (line.startsWith('diff ') || line.startsWith('index ') || line.startsWith('+++') || line.startsWith('---')) {
        continue
      }

      if (line.startsWith('+')) added++
      if (line.startsWith('-')) removed++
    }

    return { added, removed }
  }

  /**
   * Extract the primary failure type from the failure report.
   * Looks for check names and first line of summaries.
   */
  private extractFailureType(failureReport: string): string | null {
    const lines = failureReport.split('\n')

    for (const line of lines) {
      // Look for check failure headers: ## checkName — FAILED
      const match = line.match(/^##\s*(.+?)\s*—\s*FAILED/i)
      if (match) {
        return match[1].trim()
      }
    }

    // Fallback: extract first non-header line
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith('#') && trimmed.length > 10) {
        return trimmed.split('.')[0] // Take first sentence
      }
    }

    return null
  }
}
