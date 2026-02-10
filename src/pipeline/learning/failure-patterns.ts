/**
 * Failure Pattern Store
 *
 * Records and retrieves patterns of gate failures and their successful fixes.
 * Used to provide examples to the fix agent when similar failures occur.
 *
 * Pattern matching is based on:
 * - Failure type (check name + first line of summary)
 * - File extension / language
 * - Keywords in the failure message
 *
 * Stored in: ~/.orcha/learning/failure-patterns.json
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import { existsSync } from 'fs'
import type { GateResult, FailurePattern, Fix } from '../types.js'

// ============================================================================
// Constants
// ============================================================================

const LEARNING_DIR = join(homedir(), '.orcha', 'learning')
const PATTERNS_FILE = join(LEARNING_DIR, 'failure-patterns.json')

// Maximum number of patterns to keep per pattern type
const MAX_PATTERNS_PER_TYPE = 50

// ============================================================================
// Failure Pattern Store Class
// ============================================================================

export class FailurePatternStore {
  private patterns: FailurePattern[] = []

  /**
   * Load patterns from disk.
   */
  async load(): Promise<void> {
    if (!existsSync(PATTERNS_FILE)) {
      this.patterns = []
      return
    }

    try {
      const content = await readFile(PATTERNS_FILE, 'utf-8')
      const data = JSON.parse(content)
      this.patterns = Array.isArray(data.patterns) ? data.patterns : []
    } catch {
      // Corrupted or invalid JSON — reset
      this.patterns = []
    }
  }

  /**
   * Save patterns to disk.
   */
  async save(): Promise<void> {
    await mkdir(LEARNING_DIR, { recursive: true })
    await writeFile(
      PATTERNS_FILE,
      JSON.stringify({ patterns: this.patterns, updatedAt: new Date().toISOString() }, null, 2),
      'utf-8',
    )
  }

  /**
   * Record a new failure pattern.
   * De-duplicates by patternType + signature.
   */
  recordPattern(pattern: FailurePattern): void {
    // Check if pattern already exists
    const existingIndex = this.patterns.findIndex(
      (p) => p.patternType === pattern.patternType && p.signature === pattern.signature,
    )

    if (existingIndex >= 0) {
      // Update existing pattern (increment occurrence count if available)
      const existing = this.patterns[existingIndex]
      this.patterns[existingIndex] = {
        ...existing,
        occurrences: (existing.occurrences ?? 1) + 1,
        lastSeen: new Date().toISOString(),
      }
    } else {
      // Add new pattern
      this.patterns.push({
        ...pattern,
        occurrences: 1,
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
      })
    }

    // Prune old patterns if we exceed the limit
    this.pruneOldPatterns(pattern.patternType)
  }

  /**
   * Find similar patterns to the given gate results.
   * Returns patterns sorted by relevance (most recent first).
   */
  findSimilarPatterns(gateResults: GateResult[]): FailurePattern[] {
    const failures = gateResults.filter((r) => r.verdict === 'fail')
    if (failures.length === 0) return []

    const similar: Array<{ pattern: FailurePattern; score: number }> = []

    for (const pattern of this.patterns) {
      const score = this.computeSimilarityScore(pattern, failures)
      if (score > 0) {
        similar.push({ pattern, score })
      }
    }

    // Sort by score (descending), then by recency
    similar.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      return new Date(b.pattern.lastSeen).getTime() - new Date(a.pattern.lastSeen).getTime()
    })

    return similar.slice(0, 5).map((s) => s.pattern)
  }

  /**
   * Get successful fixes for a given pattern type.
   * Returns fixes sorted by recency (most recent first).
   */
  getSuccessfulFixes(patternType: string): Fix[] {
    const matchingPatterns = this.patterns.filter(
      (p) => p.patternType === patternType && p.successfulFix,
    )

    return matchingPatterns
      .sort((a, b) => new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime())
      .slice(0, 3) // Return top 3 most recent
      .map((p) => p.successfulFix!)
  }

  /**
   * Get all patterns (for debugging/inspection).
   */
  getAllPatterns(): FailurePattern[] {
    return [...this.patterns]
  }

  // ============================================================================
  // Helpers
  // ============================================================================

  /**
   * Compute similarity score between a pattern and gate failures.
   * Score is based on:
   * - Check name match (weight: 3)
   * - Language match (weight: 2)
   * - Keyword overlap (weight: 1 per keyword)
   */
  private computeSimilarityScore(pattern: FailurePattern, failures: GateResult[]): number {
    let score = 0

    for (const failure of failures) {
      // Check name match
      if (failure.checkName === pattern.checkName) {
        score += 3
      }

      // Language match (extract from pattern signature or keywords)
      const failureText = `${failure.checkName} ${failure.summary}`.toLowerCase()
      if (pattern.language && failureText.includes(pattern.language.toLowerCase())) {
        score += 2
      }

      // Keyword overlap
      const keywords = pattern.keywords ?? []
      for (const keyword of keywords) {
        if (failureText.includes(keyword.toLowerCase())) {
          score += 1
        }
      }
    }

    return score
  }

  /**
   * Prune old patterns to keep storage bounded.
   * Removes oldest patterns beyond MAX_PATTERNS_PER_TYPE.
   */
  private pruneOldPatterns(patternType: string): void {
    const ofType = this.patterns.filter((p) => p.patternType === patternType)
    if (ofType.length <= MAX_PATTERNS_PER_TYPE) return

    // Sort by lastSeen (oldest first)
    ofType.sort((a, b) => new Date(a.lastSeen).getTime() - new Date(b.lastSeen).getTime())

    // Remove oldest patterns
    const toRemove = ofType.slice(0, ofType.length - MAX_PATTERNS_PER_TYPE)
    this.patterns = this.patterns.filter((p) => !toRemove.includes(p))
  }
}

// ============================================================================
// Pattern Type Detection
// ============================================================================

/**
 * Detect the pattern type from gate results.
 * Returns a classification like 'command-injection', 'validation-missing', etc.
 */
export function detectPatternType(gateResults: GateResult[]): string {
  const failures = gateResults.filter((r) => r.verdict === 'fail')
  if (failures.length === 0) return 'unknown'

  // Check for specific patterns in failure messages
  for (const failure of failures) {
    const text = `${failure.summary} ${JSON.stringify(failure.details)}`.toLowerCase()

    // Security patterns
    if (text.includes('command injection') || text.includes('shell injection')) {
      return 'command-injection'
    }
    if (text.includes('sql injection')) {
      return 'sql-injection'
    }
    if (text.includes('xss') || text.includes('cross-site scripting')) {
      return 'xss'
    }
    if (text.includes('path traversal')) {
      return 'path-traversal'
    }
    if (text.includes('regex') && text.includes('injection')) {
      return 'regex-injection'
    }

    // Validation patterns
    if (text.includes('validation') || text.includes('input sanitization')) {
      return 'validation-missing'
    }
    if (text.includes('null') || text.includes('undefined')) {
      return 'null-pointer'
    }
    if (text.includes('type error')) {
      return 'type-error'
    }

    // Test patterns
    if (text.includes('test fail') || text.includes('assertion')) {
      return 'test-failure'
    }

    // Lint patterns
    if (text.includes('lint') || text.includes('eslint')) {
      return 'lint-error'
    }

    // Build patterns
    if (text.includes('build') || text.includes('compilation')) {
      return 'build-error'
    }
  }

  // Fallback: use check name
  const checkName = failures[0].checkName.toLowerCase()
  if (checkName.includes('security')) return 'security-issue'
  if (checkName.includes('test')) return 'test-failure'
  if (checkName.includes('lint')) return 'lint-error'
  if (checkName.includes('build')) return 'build-error'

  return 'unknown'
}

/**
 * Extract keywords from gate failures for pattern matching.
 */
export function extractKeywords(gateResults: GateResult[]): string[] {
  const keywords = new Set<string>()
  const failures = gateResults.filter((r) => r.verdict === 'fail')

  for (const failure of failures) {
    const text = failure.summary.toLowerCase()

    // Extract technical terms (simple heuristic: words with capitals or dashes)
    const words = text.split(/\s+/)
    for (const word of words) {
      // Keep words that look like technical terms
      if (word.length > 3 && (word.includes('-') || /[A-Z]/.test(word))) {
        keywords.add(word.toLowerCase())
      }
    }

    // Extract quoted terms
    const quoted = text.match(/'([^']+)'|"([^"]+)"/g)
    if (quoted) {
      for (const q of quoted) {
        keywords.add(q.replace(/['"`]/g, ''))
      }
    }
  }

  return Array.from(keywords).slice(0, 10) // Limit to 10 keywords
}
