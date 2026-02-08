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
} from './pipeline-engine.js'
