/**
 * Pipeline Configuration Schema
 *
 * Zod schema for PipelineConfig with sensible defaults for per-stage
 * model selection and budget limits.
 */

import { z } from 'zod'
import type { PipelineConfig } from './types.js'

// ============================================================================
// Zod Schemas
// ============================================================================

const ModelConfigSchema = z.object({
  default: z.string().default('sonnet'),
  architect: z.string().optional(),
  dev: z.string().optional(),
  gate: z.string().optional(),
  'gate:adversary': z.string().optional(),
  'gate:test-runner': z.string().optional(),
  'gate:lint-runner': z.string().optional(),
  'gate:security': z.string().optional(),
  'gate:code-review': z.string().optional(),
  fix: z.string().optional(),
  ship: z.string().optional(),
})

const BudgetConfigSchema = z.object({
  default: z.number().nonnegative().default(5.0),
  architect: z.number().nonnegative().optional(),
  dev: z.number().nonnegative().optional(),
  gate: z.number().nonnegative().optional(),
  fix: z.number().nonnegative().optional(),
  ship: z.number().nonnegative().optional(),
})

export const PipelineConfigSchema = z.object({
  models: ModelConfigSchema.default({
    default: 'sonnet',
    architect: 'opus',
    dev: 'opus',
    gate: 'sonnet',
    'gate:adversary': 'opus',
    'gate:test-runner': 'shell',
    'gate:lint-runner': 'shell',
    fix: 'opus',
    ship: 'haiku',
  }),
  budgets: BudgetConfigSchema.default({
    default: 5.0,
    architect: 3.0,
    dev: 10.0,
    gate: 2.0,
    fix: 5.0,
    ship: 1.0,
  }),
  maxFixLoops: z.number().int().nonnegative().default(3),
})

// ============================================================================
// Helpers
// ============================================================================

/**
 * Parse and validate a raw config object, applying defaults for any missing fields.
 * Throws a ZodError if the input is structurally invalid.
 */
export function parsePipelineConfig(raw: unknown): PipelineConfig {
  return PipelineConfigSchema.parse(raw) as PipelineConfig
}

/**
 * Return the full default PipelineConfig (all defaults applied).
 */
export function defaultPipelineConfig(): PipelineConfig {
  return PipelineConfigSchema.parse({}) as PipelineConfig
}

/**
 * Resolve the model to use for a given stage key.
 * Falls back to config.models.default if the stage key is not explicitly set.
 */
export function resolveModel(config: PipelineConfig, stageKey: string): string {
  const models = config.models as Record<string, string | undefined>
  return models[stageKey] ?? config.models.default
}

/**
 * Resolve the budget (USD) for a given stage key.
 * Falls back to config.budgets.default if the stage key is not explicitly set.
 */
export function resolveBudget(config: PipelineConfig, stageKey: string): number {
  const budgets = config.budgets as Record<string, number | undefined>
  return budgets[stageKey] ?? config.budgets.default
}
