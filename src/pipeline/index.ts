/**
 * Pipeline Module — Public Exports
 */

// Types
export type {
  PipelineState,
  ModelStageKey,
  BudgetStageKey,
  ModelConfig,
  BudgetConfig,
  PipelineConfig,
  GateVerdict,
  GateResult,
  StackRunnerResult,
  StageResult,
  Blueprint,
  UsageSnapshot,
  LearningRecord,
  CompetingResult,
  PipelineRun,
} from './types.js'

export { ACTIVE_STATES, TERMINAL_STATES, SOFT_TERMINAL_STATES, aggregateStackVerdicts } from './types.js'

// Config
export {
  PipelineConfigSchema,
  parsePipelineConfig,
  defaultPipelineConfig,
  resolveModel,
  resolveBudget,
} from './pipeline-config.js'

// Store
export {
  generatePipelineId,
  savePipelineRun,
  loadPipelineRun,
  listPipelineIds,
  listPipelineRuns,
  deletePipelineRun,
  getPipelineDir,
  getPipelinesRoot,
} from './pipeline-store.js'

// Engine (State Machine)
export {
  InvalidTransitionError,
  isValidTransition,
  assertValidTransition,
  transition,
  recordStageResult,
  incrementFixLoop,
  setError,
  transitionToError,
  getAvailableTransitions,
  getRecoveryTarget,
  createPipelineRun,
  executeArchitectStage,
  importExistingBlueprint,
  executeDevStage,
  executeGateStage,
  executeFixLoopStage,
  executeShipStage,
} from './pipeline-engine.js'

export type { CreatePipelineRunOptions } from './pipeline-engine.js'

// Stage Runner
export { runStage, killPipelineProcesses } from './stage-runner.js'
export type { StageRunnerOptions, StageRunnerResult } from './stage-runner.js'

// Tech Scanner
export { detectTechStacks } from './tech-scanner.js'
export type { TechStack } from './tech-scanner.js'

// Git Utilities
export { getDiff, getHeadSha, getChangedFilesByExtensions, getChangedLintableFiles } from './git-utils.js'

// Output Parser
export { tryParseJson, parseStructuredOutput } from './output-parser.js'

// Prompt Builder
export {
  parseAcceptanceCriteria,
  buildArchitectPrompt,
  buildDevPrompt,
  buildMilestoneDevPrompt,
  buildAcValidatorPrompt,
  buildAdversaryPrompt,
  buildSecurityReviewPrompt,
  buildCodeReviewPrompt,
  buildFixLoopPrompt,
  buildStagePrompt,
} from './prompt-builder.js'
export type { WorkItemContext, CodebaseContext, BlueprintContext, MilestoneContext, DiffContext, FixLoopContext, PromptParts } from './prompt-builder.js'

// Template Loader
export { loadTemplate, compileTemplate, validateTemplate, CUSTOM_PROMPTS_DIR, DEFAULT_PROMPTS_DIR } from './template-loader.js'
export type { TemplateData, CompiledPrompt } from './template-loader.js'

// Stages — Architect
export { runArchitectStage, BLUEPRINT_SCHEMA, isValidBlueprint, loadBlueprintFromFile } from './stages/architect.js'
export type { BlueprintOutput, ArchitectOptions } from './stages/architect.js'

// Stages — Dev
export { runDevStage } from './stages/dev.js'
export type { DevOptions, DevResult } from './stages/dev.js'

// Stages — Gate
export { runGateStage } from './stages/gate.js'
export type { GateOptions, GateStageResult } from './stages/gate.js'

// Stages — Fix Loop
export { runFixLoopStage } from './stages/fix-loop.js'
export type { FixLoopOptions } from './stages/fix-loop.js'

// Stages — Ship
export { runShipStage } from './stages/ship.js'
export type { ShipOptions, ShipResult } from './stages/ship.js'

// Checkpoint
export {
  approveCheckpoint,
  rejectCheckpoint,
  approveArchitectCheckpoint,
  rejectArchitectCheckpoint,
  feedbackArchitectCheckpoint,
  approveShipCheckpoint,
  rejectShipCheckpoint,
  feedbackShipCheckpoint,
  submitReviewPoints,
  pausePipeline,
  resumePipeline,
  recoverPipeline,
  retryEscalatedPipeline,
  stopPipeline,
  loadPipelineOrThrow,
} from './checkpoint.js'

export type { RetryEscalatedOptions } from './checkpoint.js'

// Usage Tracker
export {
  takeSnapshot,
  computeDelta,
  loadUsage,
  saveUsage,
  recordStageUsage,
  updateRunUsageSnapshot,
} from './usage-tracker.js'
export type { TokenSnapshot, StageUsage, PipelineUsage } from './usage-tracker.js'

// Learning Store
export {
  loadLearnings,
  appendLearning,
  recordPipelineOutcome,
  getRelevantHints,
} from './learning-store.js'
export type { PipelineOutcomeRecord, LearningHint } from './learning-store.js'

// Events
export { pipelineEvents } from './events.js'
export type { PipelineStateChangeEvent, PipelineAgentStatusEvent, PipelineProgressEvent } from './events.js'

// Progress
export { appendProgress, readProgress } from './progress.js'
export type { ProgressEntry, ProgressType } from './progress.js'

// Gate Agents
export { runTestRunner } from './gate-agents/test-runner.js'
export { runLintRunner } from './gate-agents/lint-runner.js'
export { runBuildRunner } from './gate-agents/build-runner.js'
export { runAcValidator } from './gate-agents/ac-validator.js'
export type { AcValidatorOptions } from './gate-agents/ac-validator.js'
export { runAdversary } from './gate-agents/adversary.js'
export type { AdversaryOptions } from './gate-agents/adversary.js'
export { runSecurityReview } from './gate-agents/security-review.js'
export type { SecurityReviewOptions } from './gate-agents/security-review.js'
export { runCodeReview } from './gate-agents/code-review.js'
export type { CodeReviewOptions } from './gate-agents/code-review.js'
