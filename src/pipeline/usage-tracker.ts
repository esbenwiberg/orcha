/**
 * Usage Tracker
 *
 * Tracks token consumption per pipeline stage using a snapshot-diff approach.
 *
 * Strategy:
 * 1. Before a stage runs, snapshot ~/.claude/stats-cache.json
 * 2. After the stage completes, snapshot again and compute the delta
 * 3. Store the delta per stage in the pipeline's usage.json
 *
 * Limitations:
 * - If non-pipeline Claude sessions run concurrently, usage is approximate
 * - Good enough for cost estimation and trend analysis
 */

import { readFile, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import type { PipelineRun, UsageSnapshot } from './types.js'
import { savePipelineRun } from './pipeline-store.js'
import { getPipelineDir } from './pipeline-store.js'

// ============================================================================
// Types
// ============================================================================

/** Raw stats from Claude CLI's stats-cache.json */
interface ClaudeStatsCache {
  [model: string]: {
    inputTokens?: number
    outputTokens?: number
    cacheReadTokens?: number
    cacheCreationTokens?: number
    totalCostUsd?: number
  }
}

/** A point-in-time snapshot of token stats. */
export interface TokenSnapshot {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  totalCostUsd: number
  timestamp: string
}

/** Per-stage usage record. */
export interface StageUsage {
  stage: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheCreationTokens: number
  costUsd: number
  durationMs: number
}

/** Full pipeline usage data stored in usage.json. */
export interface PipelineUsage {
  stages: Record<string, StageUsage>
  total: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheCreationTokens: number
    costUsd: number
    durationMs: number
  }
  estimatedCostUSD: number
}

// ============================================================================
// Stats Cache Path
// ============================================================================

const STATS_CACHE_PATH = join(homedir(), '.claude', 'stats-cache.json')

// ============================================================================
// Snapshot Operations
// ============================================================================

/**
 * Read the current Claude CLI stats-cache.json and return an aggregated snapshot.
 * Returns a zero snapshot if the file doesn't exist or can't be read.
 */
export async function takeSnapshot(): Promise<TokenSnapshot> {
  const now = new Date().toISOString()

  try {
    const raw = await readFile(STATS_CACHE_PATH, 'utf-8')
    const stats: ClaudeStatsCache = JSON.parse(raw)

    let inputTokens = 0
    let outputTokens = 0
    let cacheReadTokens = 0
    let cacheCreationTokens = 0
    let totalCostUsd = 0

    // Aggregate across all models
    for (const model of Object.values(stats)) {
      if (typeof model === 'object' && model !== null) {
        inputTokens += model.inputTokens ?? 0
        outputTokens += model.outputTokens ?? 0
        cacheReadTokens += model.cacheReadTokens ?? 0
        cacheCreationTokens += model.cacheCreationTokens ?? 0
        totalCostUsd += model.totalCostUsd ?? 0
      }
    }

    return { inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, totalCostUsd, timestamp: now }
  } catch {
    // File doesn't exist or is unreadable — return zero snapshot
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalCostUsd: 0,
      timestamp: now,
    }
  }
}

/**
 * Compute the delta between two snapshots (after - before).
 */
export function computeDelta(
  before: TokenSnapshot,
  after: TokenSnapshot,
  stage: string,
  durationMs: number,
): StageUsage {
  return {
    stage,
    inputTokens: Math.max(0, after.inputTokens - before.inputTokens),
    outputTokens: Math.max(0, after.outputTokens - before.outputTokens),
    cacheReadTokens: Math.max(0, after.cacheReadTokens - before.cacheReadTokens),
    cacheCreationTokens: Math.max(0, after.cacheCreationTokens - before.cacheCreationTokens),
    costUsd: Math.max(0, after.totalCostUsd - before.totalCostUsd),
    durationMs,
  }
}

// ============================================================================
// Usage Persistence
// ============================================================================

/**
 * Load the current pipeline usage from disk.
 * Returns a fresh empty usage if file doesn't exist.
 */
export async function loadUsage(pipelineId: string): Promise<PipelineUsage> {
  try {
    const usagePath = join(getPipelineDir(pipelineId), 'usage.json')
    const raw = await readFile(usagePath, 'utf-8')
    return JSON.parse(raw) as PipelineUsage
  } catch {
    return {
      stages: {},
      total: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: 0,
      },
      estimatedCostUSD: 0,
    }
  }
}

/**
 * Save pipeline usage to disk.
 */
export async function saveUsage(pipelineId: string, usage: PipelineUsage): Promise<void> {
  const dir = getPipelineDir(pipelineId)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'usage.json'),
    JSON.stringify(usage, null, 2),
    'utf-8',
  )
}

/**
 * Record a stage's usage delta into the pipeline's usage.json.
 * Updates both the per-stage entry and the running totals.
 */
export async function recordStageUsage(
  pipelineId: string,
  stageUsage: StageUsage,
): Promise<PipelineUsage> {
  const usage = await loadUsage(pipelineId)

  // Record per-stage
  usage.stages[stageUsage.stage] = stageUsage

  // Recompute totals from all stages
  let totalInput = 0
  let totalOutput = 0
  let totalCacheRead = 0
  let totalCacheCreation = 0
  let totalCost = 0
  let totalDuration = 0

  for (const s of Object.values(usage.stages)) {
    totalInput += s.inputTokens
    totalOutput += s.outputTokens
    totalCacheRead += s.cacheReadTokens
    totalCacheCreation += s.cacheCreationTokens
    totalCost += s.costUsd
    totalDuration += s.durationMs
  }

  usage.total = {
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead,
    cacheCreationTokens: totalCacheCreation,
    costUsd: totalCost,
    durationMs: totalDuration,
  }
  usage.estimatedCostUSD = totalCost

  await saveUsage(pipelineId, usage)
  return usage
}

// ============================================================================
// Pipeline Run Integration
// ============================================================================

/**
 * Update the PipelineRun's usageSnapshot from the current usage.json data.
 */
export async function updateRunUsageSnapshot(run: PipelineRun): Promise<PipelineRun> {
  const usage = await loadUsage(run.id)

  const snapshot: UsageSnapshot = {
    totalCostUsd: usage.estimatedCostUSD,
    perStage: {},
    inputTokens: usage.total.inputTokens,
    outputTokens: usage.total.outputTokens,
    timestamp: new Date().toISOString(),
  }

  // Build per-stage cost map
  for (const [key, stageUsage] of Object.entries(usage.stages)) {
    // Map stage keys to PipelineState where possible
    const stateKey = key as keyof typeof snapshot.perStage
    snapshot.perStage[stateKey] = stageUsage.costUsd
  }

  const updated: PipelineRun = {
    ...run,
    usageSnapshot: snapshot,
    updatedAt: new Date().toISOString(),
  }

  await savePipelineRun(updated)
  return updated
}
