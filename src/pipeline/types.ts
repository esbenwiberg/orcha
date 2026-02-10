/**
 * Pipeline Types for Orcha
 *
 * Defines the type system for the pipeline orchestration:
 * states, runs, stage results, gate verdicts, blueprints, usage tracking,
 * learning records, and per-stage model/budget configuration.
 */

// ============================================================================
// Pipeline States
// ============================================================================

export type PipelineState =
  | 'created'
  | 'architect'
  | 'checkpoint:arch'
  | 'dev'
  | 'gate'
  | 'fix-loop'
  | 'checkpoint:ship'
  | 'ship'
  | 'completed'
  | 'cancelled'
  | 'escalated'
  | 'paused'
  | 'error'

/** States that are considered "active" (pipeline is doing work or waiting for human). */
export const ACTIVE_STATES: ReadonlySet<PipelineState> = new Set<PipelineState>([
  'created',
  'architect',
  'checkpoint:arch',
  'dev',
  'gate',
  'fix-loop',
  'checkpoint:ship',
  'ship',
])

/** Terminal states -- pipeline cannot leave these. */
export const TERMINAL_STATES: ReadonlySet<PipelineState> = new Set<PipelineState>([
  'cancelled',
])

/** Soft-terminal states: pipeline stops but can be reopened (e.g. review feedback). */
export const SOFT_TERMINAL_STATES: ReadonlySet<PipelineState> = new Set<PipelineState>([
  'completed',
  'escalated',
])

// ============================================================================
// Model & Budget Configuration
// ============================================================================

/** Known stage-level model keys. */
export type ModelStageKey =
  | 'default'
  | 'architect'
  | 'dev'
  | 'gate'
  | 'gate:adversary'
  | 'gate:build-runner'
  | 'gate:test-runner'
  | 'gate:lint-runner'
  | 'gate:security'
  | 'gate:code-review'
  | 'fix'
  | 'ship'

/** Known stage-level budget keys. */
export type BudgetStageKey =
  | 'default'
  | 'architect'
  | 'dev'
  | 'gate'
  | 'fix'
  | 'ship'

/**
 * Per-stage model mapping.
 * "default" is required; all other keys are optional and fall back to default.
 */
export type ModelConfig = { default: string } & Partial<Record<Exclude<ModelStageKey, 'default'>, string>>

/**
 * Per-stage budget mapping (USD).
 * "default" is required; all other keys are optional and fall back to default.
 */
export type BudgetConfig = { default: number } & Partial<Record<Exclude<BudgetStageKey, 'default'>, number>>

// ============================================================================
// Pipeline Configuration
// ============================================================================

export interface PipelineConfig {
  models: ModelConfig
  budgets: BudgetConfig
  maxFixLoops?: number // Default: 3
  /** Number of competing dev agents (default: 1 = no competition). */
  competingAgents?: number // Default: 1
}

// ============================================================================
// Gate Verdicts & Stage Results
// ============================================================================

export type GateVerdict = 'pass' | 'fail' | 'skip'

export interface GateResult {
  verdict: GateVerdict
  /** Name of the gate check (e.g. "tests", "lint", "adversary-review"). */
  checkName: string
  /** Human-readable summary of the gate outcome. */
  summary: string
  /** Optional structured details (e.g. test counts, lint errors). */
  details?: Record<string, unknown>
  timestamp: string // ISO 8601
}

/** Per-stack result used by multi-tech gate runners (test, lint, build). */
export interface StackRunnerResult {
  type: string
  path: string
  status: GateVerdict
  command?: string
  output?: string
  exitCode?: number
}

/**
 * Aggregate per-stack verdicts: any fail → 'fail', all skip → 'skip', else 'pass'.
 *
 * Logic:
 * 1. If any verdict is 'fail' → return 'fail' (strictest)
 * 2. If ALL verdicts are 'skip' → return 'skip' (nothing ran)
 * 3. Otherwise → return 'pass' (at least one passed, none failed)
 *
 * Note: With current GateVerdict = 'pass' | 'fail' | 'skip', after checking for
 * 'fail' and confirming not all are 'skip', the remaining verdicts MUST contain
 * at least one 'pass'. The explicit check is kept for clarity and future-proofing.
 */
export function aggregateStackVerdicts(verdicts: GateVerdict[]): GateVerdict {
  // Empty array case: treat as 'skip' (nothing to aggregate)
  if (verdicts.length === 0) return 'skip'
  // Any failure means overall failure
  if (verdicts.some((v) => v === 'fail')) return 'fail'
  // All skipped means overall skip
  if (verdicts.every((v) => v === 'skip')) return 'skip'
  // At this point, we have no failures and not all skipped.
  // With GateVerdict = 'pass' | 'fail' | 'skip', this means at least one 'pass'.
  return 'pass'
}

export interface StageResult {
  stage: PipelineState
  startedAt: string // ISO 8601
  completedAt: string // ISO 8601
  /** Model used for this stage invocation. */
  model?: string
  /** USD spent during this stage. */
  costUsd?: number
  /** Arbitrary output/notes from the stage. */
  output?: string
  error?: string
}

// ============================================================================
// Blueprint
// ============================================================================

/**
 * A single milestone in the blueprint.
 *
 * Each milestone represents a discrete unit of work that can be implemented
 * with a fresh Claude session (clean context). This addresses context pollution
 * and cost concerns for large blueprints.
 *
 * DESIGN DECISION: Milestones execute SEQUENTIALLY, not in parallel.
 * Rationale:
 * 1. Milestones typically have sequential dependencies (M2 builds on M1 changes)
 * 2. Parallel execution would require complex merge conflict resolution
 * 3. The competing agents feature already provides parallelism for the same work unit
 *    (use --competing N to run parallel agents on each milestone)
 */
export interface BlueprintMilestone {
  /** Human-readable description of what this milestone accomplishes. */
  description: string
  /** Detailed implementation guidance for the dev agent. */
  details: string
  /** Optional: subset of files this milestone touches (for context hints). */
  filesToTouch?: string[]
  /**
   * Optional: milestone indices this depends on (for future parallel support).
   * Currently unused since all milestones execute sequentially.
   */
  dependsOn?: number[]
}

export interface Blueprint {
  /** Markdown content of the architectural plan. */
  content: string
  /** SHA of the commit where the blueprint was saved. */
  commitSha?: string
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
}

/**
 * Structured blueprint output from the architect stage.
 *
 * Contains the implementation plan as milestones (steps).
 * The 'milestones' field is the canonical name, but 'steps' is supported
 * for backward compatibility with existing blueprints.
 */
export interface BlueprintOutput {
  /** Short title for the plan (e.g. "Add User Authentication"). */
  headline: string
  /** 1-2 sentence summary of what this blueprint accomplishes. */
  shortDescription: string
  /** High-level description of the implementation approach. */
  approach: string
  /** Array of file paths that need to be created or modified. */
  filesToTouch: string[]
  /** Array of potential risks or concerns. */
  risks: string[]
  /** How to test the changes. */
  testStrategy: string
  /**
   * Ordered implementation milestones (preferred).
   * Each milestone is implemented with a FRESH Claude session for context isolation.
   */
  milestones?: BlueprintMilestone[]
  /**
   * Ordered implementation steps (backward compatibility alias for milestones).
   * @deprecated Use 'milestones' instead.
   */
  steps?: Array<{ description: string; details: string }>
}

/**
 * Get milestones from a blueprint, supporting both 'milestones' and 'steps' fields.
 * Returns the milestones array, converting from steps if necessary.
 */
export function getBlueprintMilestones(blueprint: BlueprintOutput): BlueprintMilestone[] {
  if (blueprint.milestones && blueprint.milestones.length > 0) {
    return blueprint.milestones
  }
  // Backward compatibility: convert steps to milestones
  if (blueprint.steps && blueprint.steps.length > 0) {
    return blueprint.steps.map((step) => ({
      description: step.description,
      details: step.details,
    }))
  }
  return []
}

// ============================================================================
// Usage & Learning
// ============================================================================

export interface UsageSnapshot {
  /** Total USD spent across all stages so far. */
  totalCostUsd: number
  /** Per-stage cost breakdown. */
  perStage: Partial<Record<PipelineState, number>>
  /** Total input tokens consumed (if available). */
  inputTokens?: number
  /** Total output tokens consumed (if available). */
  outputTokens?: number
  timestamp: string // ISO 8601
}

export interface LearningRecord {
  /** What was learned (e.g. pattern, anti-pattern). */
  insight: string
  /** Which stage produced this learning. */
  stage: PipelineState
  /** Severity / importance. */
  severity: 'info' | 'warning' | 'critical'
  timestamp: string // ISO 8601
}

// ============================================================================
// Competing Dev Agents
// ============================================================================

export interface CompetingResult {
  /** Zero-based index of the competing agent. */
  agentIndex: number
  /** Branch name this agent worked on. */
  branch: string
  /** Worktree path for this agent. */
  worktreePath: string
  /** Git diff produced by this agent. */
  diff: string
  /** Commit SHA after auto-commit. */
  commitSha: string
  /** Gate score (higher is better). -1 if gate not yet run. */
  gateScore: number
  /** Whether this agent was selected as the winner. */
  winner: boolean
  /** Gate results for this agent (populated after gate runs). */
  gateResults?: GateResult[]
}

// ============================================================================
// Milestone Progress Tracking
// ============================================================================

/**
 * Tracks the completion of a single milestone in the dev stage.
 *
 * This allows the pipeline to:
 * 1. Resume from a specific milestone after failure
 * 2. Track progress through large blueprints
 * 3. Record per-milestone commits for auditing
 */
export interface MilestoneProgress {
  /** Zero-based index of the milestone. */
  index: number
  /** ISO 8601 timestamp when this milestone started. */
  startedAt: string
  /** ISO 8601 timestamp when this milestone completed (undefined if still running). */
  completedAt?: string
  /** Commit SHA after the milestone was completed. */
  commitSha?: string
  /** Error message if this milestone failed. */
  error?: string
}

// ============================================================================
// Pipeline Run (the main aggregate)
// ============================================================================

export interface PipelineRun {
  /** Unique pipeline ID (includes timestamp for uniqueness). */
  id: string
  /** Current state of the pipeline. */
  state: PipelineState
  /** Pipeline configuration (models, budgets). */
  config: PipelineConfig

  // --- Work item context ---
  /** External work-item identifier (e.g. GitHub issue number, ADO work item ID). */
  workItemId?: string
  /** Short display title for the pipeline (optional, falls back to truncated description). */
  title?: string
  /** Human-readable description of the task. */
  description: string
  /** Acceptance criteria the gate stage checks against. */
  acceptanceCriteria: string[]

  // --- Git / worktree context ---
  /** Branch the pipeline is working on. */
  sourceBranch: string
  /** Commit SHA at pipeline creation — used as the base for cumulative diffs. */
  baseCommit?: string
  /** Absolute path to the git worktree. */
  worktreePath: string
  /** Whether the worktree was auto-created by the pipeline (vs. user-provided). */
  worktreeManaged?: boolean
  /** Absolute path to the original repository (before worktree creation). */
  repoPath?: string
  /** Path to the saved blueprint file within the worktree. */
  blueprintPath?: string

  // --- Stage tracking ---
  /** Ordered history of completed stages. */
  stageHistory: StageResult[]
  /** The stage that is currently executing (null when paused/terminal). */
  currentStage: PipelineState | null
  /** Gate results from the most recent gate execution. */
  gateResults: GateResult[]
  /** How many fix-loop iterations have been run so far. */
  fixLoopCount: number
  /** Results from competing dev agents (populated if competingAgents > 1). */
  competingResults?: CompetingResult[]

  // --- Recovery / retry hints ---
  /** Gate check names to skip on next gate run (e.g. ['lint', 'security']). */
  skipChecks?: string[]
  /** User-provided instructions injected into the fix-loop prompt. */
  userInstructions?: string

  // --- Milestone tracking ---
  /**
   * Zero-based index of the current milestone being executed.
   * Used to track progress through multi-milestone blueprints and enable
   * recovery from a specific milestone after failure.
   */
  currentMilestoneIndex?: number
  /**
   * History of milestone executions.
   * Each entry records when a milestone started, completed, and its commit SHA.
   * This allows resuming from a failed milestone without re-running earlier ones.
   */
  milestoneHistory?: MilestoneProgress[]
  /**
   * Number of milestones remaining after competing mode completes milestone 1.
   * When competing mode runs on a multi-milestone blueprint, only milestone 1
   * gets competing agents. After gate selects a winner, the remaining milestones
   * run non-competing (sequential). This field tells gate how many remain.
   */
  pendingMilestoneCount?: number

  // --- Usage ---
  /** Aggregated token/cost usage snapshot. */
  usageSnapshot?: UsageSnapshot

  // --- Review rounds ---
  /** Number of times the pipeline has been sent back for review feedback or review points. */
  reviewRounds?: number

  // --- Error ---
  /** Error message if state === 'error'. */
  error?: string

  // --- Timestamps ---
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
  /** Set when state transitions to 'paused'. */
  pausedAt?: string // ISO 8601
  /** The state the pipeline was in before it was paused. */
  pausedStage?: PipelineState
}
