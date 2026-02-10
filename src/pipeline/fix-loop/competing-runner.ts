/**
 * Competing Fix Runner
 *
 * Interface design for running multiple competing fix strategies in parallel.
 * This allows the fix-loop to try different approaches and select the best one.
 *
 * IMPLEMENTATION STATUS: Interface only - not yet implemented.
 * TODO: Implement the actual competing fix runner logic.
 */

import type { PipelineRun } from '../types.js'

// ============================================================================
// Types
// ============================================================================

/**
 * Fix strategy configuration.
 * Each strategy represents a different approach to fixing gate failures.
 */
export interface FixStrategy {
  /** Strategy name (e.g. 'conservative', 'refactor', 'minimal'). */
  name: string
  /** Custom prompt instructions for this strategy. */
  prompt: string
  /** File access scope: 'targeted' = only failing files, 'module' = related modules, 'broad' = full repo. */
  scopePermissions: 'targeted' | 'module' | 'broad'
}

/**
 * Result from a single competing fix strategy.
 * After running all strategies, the gate evaluates each and selects the best.
 */
export interface CompetingFixResult {
  /** Strategy name that produced this result. */
  strategyName: string
  /** Worktree path where this fix was applied. */
  worktreePath: string
  /** Git diff produced by this fix. */
  diff: string
  /** Gate score after applying this fix (number of passed checks). */
  gateScore: number
  /** True if this strategy was selected as the winner. */
  winner: boolean
  /** Commit SHA after the fix was applied. */
  commitSha?: string
  /** Gate results after this fix (populated after re-gating). */
  gateResults?: import('../types.js').GateResult[]
}

// ============================================================================
// Interface
// ============================================================================

/**
 * Competing Fix Runner Interface.
 *
 * Runs multiple fix strategies in parallel worktrees and returns results.
 * The gate stage then evaluates each result and selects the best one.
 *
 * FUTURE IMPLEMENTATION ROADMAP:
 * 1. Create separate worktrees for each strategy (git worktree add)
 * 2. Run fix agent in each worktree with strategy-specific prompts
 * 3. Auto-commit each fix to its worktree
 * 4. Return CompetingFixResult[] with diffs and worktree paths
 * 5. Gate stage re-runs on all results and picks the winner
 * 6. Cleanup losing worktrees after selection
 *
 * DESIGN DECISIONS:
 * - Strategies run in parallel to minimize fix-loop latency
 * - Each strategy gets its own worktree to avoid conflicts
 * - Gate evaluates all strategies and picks the best based on:
 *   - Number of passed checks (primary metric)
 *   - Diff size (tiebreaker: prefer smaller changes)
 *   - Execution time (tiebreaker: prefer faster fixes)
 * - Winner's worktree becomes the new pipeline worktree
 * - Losers are cleaned up to avoid worktree clutter
 *
 * CONFIGURATION:
 * - Enable competing mode with: --competing-fix-strategies 3
 * - Default strategies: conservative, refactor, minimal
 * - Custom strategies can be defined in pipeline config
 *
 * FALLBACK:
 * - If all strategies fail gate, escalate to human review
 * - If worktree creation fails, fall back to single-strategy mode
 */
export interface CompetingFixRunner {
  /**
   * Run multiple fix strategies in parallel and return results.
   *
   * @param run - Pipeline run context
   * @param strategies - Fix strategies to try
   * @returns Array of results, one per strategy
   *
   * TODO: Implement this method.
   * For now, this is just an interface definition.
   */
  runCompetingFixes(
    run: PipelineRun,
    strategies: FixStrategy[],
  ): Promise<CompetingFixResult[]>
}

// ============================================================================
// Default Strategies (for future implementation)
// ============================================================================

/**
 * Built-in fix strategies with different risk profiles.
 *
 * TODO: Fine-tune these prompts based on empirical fix success rates.
 */
export const DEFAULT_STRATEGIES: FixStrategy[] = [
  {
    name: 'conservative',
    prompt: `You are a conservative fix agent. Make minimal, targeted changes to fix gate failures.
Only modify files directly mentioned in failures. Prefer safe, defensive fixes.
Avoid refactoring unless absolutely necessary.`,
    scopePermissions: 'targeted',
  },
  {
    name: 'refactor',
    prompt: `You are a refactoring fix agent. Fix failures by improving code structure.
Consider related modules and apply best practices. Refactor as needed to fix root causes.
You have broader file access to make systemic improvements.`,
    scopePermissions: 'module',
  },
  {
    name: 'minimal',
    prompt: `You are a minimal fix agent. Make the absolute smallest change to pass the gate.
Focus on symptom resolution over root cause. Prioritize speed over code quality.
Only touch the exact lines mentioned in failures.`,
    scopePermissions: 'targeted',
  },
]

// ============================================================================
// Placeholder Implementation (stub)
// ============================================================================

/**
 * Stub implementation that throws an error.
 * Replace this with the actual implementation when ready.
 *
 * TODO: Remove this stub and implement the real CompetingFixRunner class.
 */
export class CompetingFixRunnerStub implements CompetingFixRunner {
  async runCompetingFixes(
    run: PipelineRun,
    strategies: FixStrategy[],
  ): Promise<CompetingFixResult[]> {
    throw new Error('CompetingFixRunner not yet implemented. This is a stub interface.')
  }
}
