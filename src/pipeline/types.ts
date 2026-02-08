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
  'completed',
  'cancelled',
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

export interface Blueprint {
  /** Markdown content of the architectural plan. */
  content: string
  /** SHA of the commit where the blueprint was saved. */
  commitSha?: string
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
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
  /** Human-readable description of the task. */
  description: string
  /** Acceptance criteria the gate stage checks against. */
  acceptanceCriteria: string[]

  // --- Git / worktree context ---
  /** Branch the pipeline is working on. */
  sourceBranch: string
  /** Absolute path to the git worktree. */
  worktreePath: string
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

  // --- Usage ---
  /** Aggregated token/cost usage snapshot. */
  usageSnapshot?: UsageSnapshot

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
