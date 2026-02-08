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
import { takeSnapshot, computeDelta, recordStageUsage } from './usage-tracker.js'
import { pipelineEvents } from './events.js'

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
  /** Output format (e.g. 'json' for --output-format json). */
  outputFormat?: string
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
    outputFormat,
    modelOverride,
    budgetOverride,
  } = options

  // Take usage snapshot before stage execution
  const usageBefore = await takeSnapshot()
  const stageStartTime = Date.now()

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
    outputFormat,
    prompt,
  })

  // Spawn the process with live log streaming
  const onData = (stream: 'stdout' | 'stderr', chunk: string) => {
    pipelineEvents.emitLog({
      pipelineId,
      stage: stageKey,
      stream,
      data: chunk,
      timestamp: new Date().toISOString(),
    })
  }
  const result = await spawnClaude(args, cwd, onData)

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

  // Take usage snapshot after stage execution and record delta
  const usageAfter = await takeSnapshot()
  const durationMs = Date.now() - stageStartTime
  const usageDelta = computeDelta(usageBefore, usageAfter, stageKey, durationMs)
  await recordStageUsage(pipelineId, usageDelta)

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
  outputFormat?: string
  prompt: string
}

function buildCliArgs(args: CliArgs): string[] {
  const cliArgs: string[] = [
    '--model', args.model,
    '--append-system-prompt', args.systemPrompt,
    '--dangerously-skip-permissions',
    '--max-budget-usd', String(args.budget),
    '-p', args.prompt,
    // Always use stream-json for live progress streaming
    '--output-format', 'stream-json',
    '--verbose',
  ]

  if (args.allowedTools) {
    cliArgs.push('--allowedTools', args.allowedTools)
  }

  return cliArgs
}

/**
 * Spawn `claude` CLI as a child process and capture its output.
 */
/**
 * Parse a stream-json line into a readable log message.
 * Returns null for events that don't need logging.
 */
function formatStreamEvent(line: string): string | null {
  try {
    const evt = JSON.parse(line)
    if (evt.type === 'system' && evt.subtype === 'init') {
      return `[init] model=${evt.model} tools=${(evt.tools || []).length}`
    }
    if (evt.type === 'assistant' && evt.message?.content) {
      const parts: string[] = []
      for (const block of evt.message.content) {
        if (block.type === 'text' && block.text) {
          // Truncate long text
          const text = block.text.length > 200 ? block.text.slice(0, 200) + '...' : block.text
          parts.push(text)
        }
        if (block.type === 'tool_use') {
          const input = block.input || {}
          let summary = block.name
          if (block.name === 'Read' && input.file_path) summary += ` ${input.file_path}`
          else if (block.name === 'Grep' && input.pattern) summary += ` "${input.pattern}"`
          else if (block.name === 'Glob' && input.pattern) summary += ` ${input.pattern}`
          else if (block.name === 'Edit' && input.file_path) summary += ` ${input.file_path}`
          else if (block.name === 'Write' && input.file_path) summary += ` ${input.file_path}`
          else if (block.name === 'Bash' && input.command) summary += ` ${input.command.slice(0, 80)}`
          parts.push(`[tool] ${summary}`)
        }
      }
      return parts.length > 0 ? parts.join('\n') : null
    }
    if (evt.type === 'result') {
      const cost = evt.total_cost_usd ? `$${evt.total_cost_usd.toFixed(3)}` : ''
      const turns = evt.num_turns || 0
      return `[done] ${turns} turns, ${cost}, ${evt.duration_ms ? (evt.duration_ms / 1000).toFixed(1) + 's' : ''}`
    }
    return null
  } catch {
    return null
  }
}

function spawnClaude(
  args: string[],
  cwd: string,
  onData?: (stream: 'stdout' | 'stderr', chunk: string) => void,
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
    let lineBuf = ''
    let resultLine = '' // Store the last 'result' line for final output

    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutChunks.push(chunk)
      // Parse streaming JSON lines for progress reporting
      if (onData) {
        lineBuf += chunk.toString('utf-8')
        const lines = lineBuf.split('\n')
        lineBuf = lines.pop() || '' // Keep incomplete last line in buffer
        for (const line of lines) {
          if (!line.trim()) continue
          // Check if this is a result event (save it)
          try {
            const parsed = JSON.parse(line)
            if (parsed.type === 'result') resultLine = line
          } catch { /* not json */ }
          const msg = formatStreamEvent(line)
          if (msg) onData('stderr', msg + '\n') // Use 'stderr' channel for log display
        }
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
    })

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`))
    })

    proc.on('close', (code) => {
      // Process any remaining buffered line
      if (lineBuf.trim() && onData) {
        try {
          const parsed = JSON.parse(lineBuf)
          if (parsed.type === 'result') resultLine = lineBuf
        } catch { /* not json */ }
        const msg = formatStreamEvent(lineBuf)
        if (msg) onData('stderr', msg + '\n')
      }

      const exitCode = code ?? 1
      const stderr = Buffer.concat(stderrChunks).toString('utf-8')

      // For stream-json, the "stdout" we return should be the result event
      // (which contains the actual output in its .result field), so downstream
      // parsers work the same as with --output-format json
      let stdout: string
      if (resultLine) {
        stdout = resultLine
      } else {
        stdout = Buffer.concat(stdoutChunks).toString('utf-8')
      }

      resolve({
        exitCode,
        stdout,
        stderr,
        success: exitCode === 0,
      })
    })
  })
}
