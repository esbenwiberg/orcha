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
  StageResult,
  Blueprint,
  UsageSnapshot,
  LearningRecord,
  PipelineRun,
} from './types.js'

export { ACTIVE_STATES, TERMINAL_STATES } from './types.js'

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
  createPipelineRun,
  executeArchitectStage,
  executeDevStage,
  executeGateStage,
} from './pipeline-engine.js'

export type { CreatePipelineRunOptions } from './pipeline-engine.js'

// Stage Runner
export { runStage } from './stage-runner.js'
export type { StageRunnerOptions, StageRunnerResult } from './stage-runner.js'

// Prompt Builder
export {
  parseAcceptanceCriteria,
  buildArchitectPrompt,
  buildDevPrompt,
  buildAcValidatorPrompt,
  buildStagePrompt,
} from './prompt-builder.js'
export type { WorkItemContext, CodebaseContext, BlueprintContext, DiffContext, PromptParts } from './prompt-builder.js'

// Stages — Architect
export { runArchitectStage, BLUEPRINT_SCHEMA } from './stages/architect.js'
export type { BlueprintOutput, ArchitectOptions } from './stages/architect.js'

// Stages — Dev
export { runDevStage } from './stages/dev.js'
export type { DevOptions, DevResult } from './stages/dev.js'

// Stages — Gate
export { runGateStage } from './stages/gate.js'
export type { GateOptions, GateStageResult } from './stages/gate.js'

// Gate Agents
export { runTestRunner } from './gate-agents/test-runner.js'
export { runLintRunner } from './gate-agents/lint-runner.js'
export { runAcValidator } from './gate-agents/ac-validator.js'
export type { AcValidatorOptions } from './gate-agents/ac-validator.js'
