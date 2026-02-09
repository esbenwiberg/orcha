/**
 * Output Parser
 *
 * Generic structured output parser for Claude CLI responses.
 * Implements a 4-strategy extraction pattern:
 * 1. Direct JSON parse of the full output
 * 2. Unwrap Claude's -p result wrapper ({ result: "..." })
 * 3. Extract JSON from markdown code blocks
 * 4. Find the first { ... } block (greedy brace match)
 *
 * Each strategy is validated against a caller-supplied type guard.
 */

// ============================================================================
// Public API
// ============================================================================

/**
 * Try to parse JSON from a string, returning null on failure.
 */
export function tryParseJson(str: string): unknown | null {
  try {
    return JSON.parse(str)
  } catch {
    return null
  }
}

/**
 * Parse structured output from Claude CLI stdout.
 *
 * Uses 4 fallback strategies to extract JSON from potentially
 * wrapped or decorated output. The `validator` type guard determines
 * whether the parsed object matches the expected shape.
 *
 * Returns null if no valid object can be extracted.
 */
export function parseStructuredOutput<T>(
  stdout: string,
  validator: (obj: unknown) => obj is T,
): T | null {
  const trimmed = stdout.trim()

  // Strategy 1: direct JSON parse
  const direct = tryParseJson(trimmed)
  if (validator(direct)) return direct

  // Strategy 2: Claude's -p output-format json wraps in a result object
  // The result field may be direct JSON, or prose + code block with JSON
  if (direct && typeof direct === 'object' && 'result' in direct) {
    const resultStr = (direct as Record<string, unknown>).result as string
    if (typeof resultStr === 'string') {
      // 2a: Try direct parse of result string
      const inner = tryParseJson(resultStr)
      if (validator(inner)) return inner

      // 2b: Extract from code block inside result string
      const codeMatch = resultStr.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
      if (codeMatch) {
        const parsed = tryParseJson(codeMatch[1])
        if (validator(parsed)) return parsed
      }

      // 2c: Find first { ... } block inside result string
      const braceMatch = resultStr.match(/\{[\s\S]*\}/)
      if (braceMatch) {
        const parsed = tryParseJson(braceMatch[0])
        if (validator(parsed)) return parsed
      }
    }
  }

  // Strategy 3: extract from code block
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n([\s\S]*?)\n```/)
  if (codeBlockMatch) {
    const parsed = tryParseJson(codeBlockMatch[1])
    if (validator(parsed)) return parsed
  }

  // Strategy 4: find first { ... } block (greedy)
  const braceMatch = trimmed.match(/\{[\s\S]*\}/)
  if (braceMatch) {
    const parsed = tryParseJson(braceMatch[0])
    if (validator(parsed)) return parsed
  }

  return null
}
