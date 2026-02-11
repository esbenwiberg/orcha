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

import { spawn, type ChildProcess } from 'child_process'
import { mkdir, writeFile, unlink } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import treeKill from 'tree-kill'
import type { PipelineConfig } from './types.js'
import { resolveModel, resolveBudget } from './pipeline-config.js'
import { getPipelineDir } from './pipeline-store.js'
import { takeSnapshot, computeDelta, recordStageUsage } from './usage-tracker.js'
import { pipelineEvents } from './events.js'
import { appendProgress } from './progress.js'

// ============================================================================
// Active process tracking (for stop/kill support)
// ============================================================================

/** Map of pipelineId → active child processes spawned for that pipeline. */
const activeProcesses = new Map<string, ChildProcess[]>()

function registerProcess(pipelineId: string, proc: ChildProcess): void {
  const procs = activeProcesses.get(pipelineId) || []
  procs.push(proc)
  activeProcesses.set(pipelineId, procs)
}

function unregisterProcess(pipelineId: string, proc: ChildProcess): void {
  const procs = activeProcesses.get(pipelineId)
  if (!procs) return
  const filtered = procs.filter(p => p !== proc)
  if (filtered.length === 0) {
    activeProcesses.delete(pipelineId)
  } else {
    activeProcesses.set(pipelineId, filtered)
  }
}

/**
 * Kill all active child processes for a pipeline.
 * Uses tree-kill to ensure the entire process tree is terminated.
 * Returns true if any processes were killed.
 */
export function killPipelineProcesses(pipelineId: string): boolean {
  const procs = activeProcesses.get(pipelineId)
  if (!procs || procs.length === 0) return false

  for (const proc of procs) {
    if (proc.pid && !proc.killed) {
      treeKill(proc.pid, 'SIGTERM')
    }
  }
  activeProcesses.delete(pipelineId)
  return true
}

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

  // Emit stage-start progress
  await appendProgress(pipelineId, {
    type: 'stage-start',
    stage: stageKey,
    title: `Stage "${stageKey}" started`,
    data: { model, budget },
  }).catch(() => { /* best-effort */ })

  // Ensure logs directory exists
  const logsDir = join(getPipelineDir(pipelineId), 'logs')
  await mkdir(logsDir, { recursive: true })
  const logPath = join(logsDir, `${stageKey}.log`)

  // Build the CLI arguments (prompt and system prompt are passed via stdin/file to avoid E2BIG)
  const { cliArgs: args, stdinPrompt, systemPromptFile } = await buildCliArgs({
    model,
    budget,
    systemPrompt,
    allowedTools,
    outputFormat,
    prompt,
    pipelineId,
    stageKey,
  })

  // Spawn the process with live log streaming + activity progress
  let lastActivityTime = 0
  const ACTIVITY_THROTTLE_MS = 3000 // Max 1 activity event per 3 seconds

  const onData = (stream: 'stdout' | 'stderr', chunk: string) => {
    pipelineEvents.emitLog({
      pipelineId,
      stage: stageKey,
      stream,
      data: chunk,
      timestamp: new Date().toISOString(),
    })
  }

  const onActivity = (activityTitle: string) => {
    const now = Date.now()
    if (now - lastActivityTime < ACTIVITY_THROTTLE_MS) return
    lastActivityTime = now
    appendProgress(pipelineId, {
      type: 'stage-activity',
      stage: stageKey,
      title: activityTitle,
    }).catch(() => { /* best-effort */ })
  }

  let result: Awaited<ReturnType<typeof spawnClaude>>
  try {
    result = await spawnClaude(args, cwd, pipelineId, stdinPrompt, onData, onActivity)
  } catch (err) {
    // Clean up temp file on error
    if (systemPromptFile) {
      await unlink(systemPromptFile).catch(() => { /* best-effort */ })
    }
    throw err
  } finally {
    // Clean up temp system prompt file
    if (systemPromptFile) {
      await unlink(systemPromptFile).catch(() => { /* best-effort */ })
    }
  }

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

  // Emit stage-complete or stage-error progress
  // For milestone stages, display one-based numbers for human readability
  const displayStageKey = stageKey.replace(/dev-milestone-(\d+)/, (_, n) => `dev-milestone-${parseInt(n) + 1}`)

  await appendProgress(pipelineId, {
    type: result.success ? 'stage-complete' : 'stage-error',
    stage: stageKey,
    title: result.success
      ? `Stage "${displayStageKey}" completed successfully`
      : `Stage "${displayStageKey}" failed (exit code ${result.exitCode})`,
    detail: result.success ? undefined : result.stderr.slice(0, 500),
    data: { model, budget, exitCode: result.exitCode, durationMs },
  }).catch(() => { /* best-effort */ })

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
  pipelineId: string
  stageKey: string
}

async function buildCliArgs(args: CliArgs): Promise<{ cliArgs: string[]; stdinPrompt: string; systemPromptFile?: string }> {
  const cliArgs: string[] = [
    '--model', args.model,
    '--dangerously-skip-permissions',
    '--max-budget-usd', String(args.budget),
    // Prompt is passed via stdin to avoid E2BIG when diffs are large
    '-p', '-',
    // Always use stream-json for live progress streaming
    '--output-format', 'stream-json',
    '--verbose',
  ]

  // Write system prompt to a temp file to avoid E2BIG errors with large contexts
  let systemPromptFile: string | undefined
  if (args.systemPrompt && args.systemPrompt.length > 0) {
    const tempDir = join(getPipelineDir(args.pipelineId), 'temp')
    await mkdir(tempDir, { recursive: true })
    systemPromptFile = join(tempDir, `system-prompt-${args.stageKey}-${Date.now()}.txt`)
    await writeFile(systemPromptFile, args.systemPrompt, 'utf-8')
    cliArgs.push('--append-system-prompt-file', systemPromptFile)
  }

  if (args.allowedTools) {
    cliArgs.push('--allowedTools', args.allowedTools)
  }

  return { cliArgs, stdinPrompt: args.prompt, systemPromptFile }
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

/**
 * Extract a concise activity title from a parsed stream-json event.
 * Returns null for events that shouldn't appear in the timeline.
 */
function extractActivityTitle(evt: Record<string, unknown>): string | null {
  if (evt.type === 'system' && evt.subtype === 'init') {
    return `Initialized (${(evt.tools as string[] | undefined)?.length ?? 0} tools)`
  }
  if (evt.type === 'assistant' && evt.message) {
    const message = evt.message as { content?: Array<{ type: string; name?: string; input?: Record<string, unknown> }> }
    const content = message.content
    if (!Array.isArray(content)) return null
    for (const block of content) {
      if (block.type === 'tool_use' && block.name) {
        const input = block.input || {}
        if (block.name === 'Read' && input.file_path) return `Read ${input.file_path}`
        if (block.name === 'Grep' && input.pattern) return `Grep "${input.pattern}"`
        if (block.name === 'Glob' && input.pattern) return `Glob ${input.pattern}`
        if (block.name === 'Edit' && input.file_path) return `Edit ${input.file_path}`
        if (block.name === 'Write' && input.file_path) return `Write ${input.file_path}`
        if (block.name === 'Bash' && input.command) return `Bash: ${(input.command as string).slice(0, 60)}`
        return block.name
      }
    }
    return null
  }
  if (evt.type === 'result') {
    const turns = (evt.num_turns as number) || 0
    const cost = evt.total_cost_usd ? `$${(evt.total_cost_usd as number).toFixed(2)}` : ''
    const dur = evt.duration_ms ? `${((evt.duration_ms as number) / 1000).toFixed(0)}s` : ''
    return `Completed: ${turns} turns, ${cost}, ${dur}`
  }
  return null
}

function spawnClaude(
  args: string[],
  cwd: string,
  pipelineId: string,
  stdinPrompt: string,
  onData?: (stream: 'stdout' | 'stderr', chunk: string) => void,
  onActivity?: (title: string) => void,
): Promise<{ exitCode: number; stdout: string; stderr: string; success: boolean }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Ensure non-interactive
        CI: '1',
      },
    })

    // Write prompt via stdin to avoid E2BIG for large diffs
    proc.stdin.write(stdinPrompt)
    proc.stdin.end()

    registerProcess(pipelineId, proc)

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
          let parsed: Record<string, unknown> | null = null
          try {
            parsed = JSON.parse(line) as Record<string, unknown>
            if (parsed && parsed.type === 'result') resultLine = line
          } catch { /* not json */ }
          const msg = formatStreamEvent(line)
          if (msg) onData('stderr', msg + '\n') // Use 'stderr' channel for log display

          // Emit activity events for timeline
          if (onActivity && parsed) {
            const activityTitle = extractActivityTitle(parsed)
            if (activityTitle) onActivity(activityTitle)
          }
        }
      }
    })

    proc.stderr.on('data', (chunk: Buffer) => {
      stderrChunks.push(chunk)
      // Forward real stderr to the live log so startup errors are visible
      if (onData) {
        const text = chunk.toString('utf-8')
        onData('stderr', text)
      }
    })

    proc.on('error', (err) => {
      // Forward spawn errors to live log so they're visible in the UI
      if (onData) {
        onData('stderr', `[error] Failed to spawn claude CLI: ${err.message}\n`)
      }
      reject(new Error(`Failed to spawn claude CLI: ${err.message}`))
    })

    proc.on('close', (code) => {
      unregisterProcess(pipelineId, proc)
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
