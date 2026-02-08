/**
 * Stage Runner
 *
 * Spawns ephemeral Claude CLI sessions for pipeline stages.
 * Each stage gets its own subprocess with:
 *   --model, --append-system-prompt, --max-budget-usd,
 *   --dangerously-skip-permissions, -p (print mode), etc.
 *
 * Does NOT use SessionManager — directly invokes `claude` CLI via child_process.
 */

import { spawn } from 'child_process'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import type { PipelineConfig } from './types.js'
import { resolveModel, resolveBudget } from './pipeline-config.js'
import { getPipelineDir } from './pipeline-store.js'

// ============================================================================
// Types
// ============================================================================

export interface StageRunnerOptions {
  /** Pipeline run ID (for log file paths). */
  pipelineId: string
  /** Stage key for model/budget resolution (e.g. 'architect', 'dev'). */
  stageKey: string
  /** Pipeline configuration (models, budgets). */
  config: PipelineConfig
  /** Working directory for the subprocess (typically the worktree path). */
  cwd: string
  /** The user prompt to pass to `claude -p`. */
  prompt: string
  /** System prompt appended via --append-system-prompt. */
  systemPrompt: string
  /** Allowed tools (e.g. 'Read,Grep,Glob' for architect). If omitted, no restriction. */
  allowedTools?: string
  /** JSON schema string for structured output via --json-schema. */
  jsonSchema?: string
  /** Override model (takes precedence over config resolution). */
  modelOverride?: string
  /** Override budget (takes precedence over config resolution). */
  budgetOverride?: number
}

export interface StageRunnerResult {
  /** Exit code of the subprocess. */
  exitCode: number
  /** Captured stdout (the -p output). */
  stdout: string
  /** Captured stderr. */
  stderr: string
  /** Whether the process completed successfully (exit code 0). */
  success: boolean
  /** Path to the log file. */
  logPath: string
  /** Model that was used. */
  model: string
  /** Budget that was configured. */
  budget: number
}

// ============================================================================
// Runner
// ============================================================================

/**
 * Run a pipeline stage by spawning an ephemeral Claude CLI subprocess.
 *
 * The subprocess runs in print mode (-p) with --dangerously-skip-permissions
 * for fully autonomous operation. Output is captured in memory and also
 * written to a log file at ~/.orcha/pipelines/{id}/logs/{stage}.log.
 */
export async function runStage(options: StageRunnerOptions): Promise<StageRunnerResult> {
  const {
    pipelineId,
    stageKey,
    config,
    cwd,
    prompt,
    systemPrompt,
    allowedTools,
    jsonSchema,
    modelOverride,
    budgetOverride,
  } = options

  // Resolve model and budget
  const model = modelOverride ?? resolveModel(config, stageKey)
  const budget = budgetOverride ?? resolveBudget(config, stageKey)

  // Ensure logs directory exists
  const logsDir = join(getPipelineDir(pipelineId), 'logs')
  await mkdir(logsDir, { recursive: true })
  const logPath = join(logsDir, `${stageKey}.log`)

  // Build the CLI arguments
  const args = buildCliArgs({
    model,
    budget,
    systemPrompt,
    allowedTools,
    jsonSchema,
    prompt,
  })

  // Spawn the process
  const result = await spawnClaude(args, cwd)

  // Write log file
  const logContent = [
    `=== Stage: ${stageKey} ===`,
    `Model: ${model}`,
    `Budget: $${budget}`,
    `Exit code: ${result.exitCode}`,
    `Timestamp: ${new Date().toISOString()}`,
    `CWD: ${cwd}`,
    '',
    '=== STDOUT ===',
    result.stdout,
    '',
    '=== STDERR ===',
    result.stderr,
  ].join('\n')

  await writeFile(logPath, logContent, 'utf-8')

  return {
    ...result,
    logPath,
    model,
    budget,
  }
}

// ============================================================================
// Internals
// ============================================================================

interface CliArgs {
  model: string
  budget: number
  systemPrompt: string
  allowedTools?: string
  jsonSchema?: string
  prompt: string
}

function buildCliArgs(args: CliArgs): string[] {
  const cliArgs: string[] = [
    '--model', args.model,
    '--append-system-prompt', args.systemPrompt,
    '--dangerously-skip-permissions',
    '--max-budget-usd', String(args.budget),
    '-p', args.prompt,
  ]

  if (args.allowedTools) {
    cliArgs.push('--allowedTools', args.allowedTools)
  }

  if (args.jsonSchema) {
    cliArgs.push('--output-format', 'json')
  }

  return cliArgs
}

/**
 * Spawn `claude` CLI as a child process and capture its output.
 */
function spawnClaude(
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string; success: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure non-interactive
        CI: '1',
      },
    })

    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`))
    })

    proc.on('close', (code) => {
      const exitCode = code ?? 1
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8')
      const stderr = Buffer.concat(stderrChunks).toString('utf-8')
      resolve({
        exitCode,
        stdout,
        stderr,
        success: exitCode === 0,
      })
    })
  })
}
