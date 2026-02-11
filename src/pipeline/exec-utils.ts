/**
 * Async Exec Utilities
 *
 * Drop-in async replacements for execSync / spawnSync / execFileSync.
 * Using these instead of their sync counterparts prevents the Node.js
 * event loop from being blocked, which keeps the web server responsive
 * while pipeline stages execute git commands, grep, find, etc.
 */

import { exec, execFile, spawn } from 'child_process'
import { promisify } from 'util'

// ============================================================================
// Promisified wrappers (throw on non-zero exit, like execSync)
// ============================================================================

/** Async replacement for `execSync`. Runs command in a shell. */
export const execAsync = promisify(exec)

/** Async replacement for `execFileSync`. Runs command without a shell. */
export const execFileAsync = promisify(execFile)

// ============================================================================
// spawnResult — async replacement for spawnSync that returns status code
// ============================================================================

export interface SpawnResult {
  status: number | null
  stdout: string
  stderr: string
}

/**
 * Async replacement for `spawnSync` that returns `{ status, stdout, stderr }`.
 *
 * Unlike `execAsync` / `execFileAsync`, this does NOT throw on non-zero exit.
 * Use this when the caller checks `.status` to decide what to do (which is
 * the pattern used by the dev stage for git operations).
 */
export function spawnResult(
  cmd: string,
  args: string[],
  opts: { cwd?: string; encoding?: string; timeout?: number; env?: NodeJS.ProcessEnv },
): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: 'pipe',
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined

    proc.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    proc.stderr?.on('data', (d: Buffer) => { stderr += d.toString() })

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer)
      if (!timedOut) {
        resolve({ status: code, stdout, stderr })
      }
    })

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer)
      if (!timedOut) {
        resolve({ status: 1, stdout, stderr: stderr || err.message })
      }
    })

    if (opts.timeout) {
      timer = setTimeout(() => {
        timedOut = true
        proc.kill()
        resolve({ status: 1, stdout, stderr: stderr || 'Process timed out' })
      }, opts.timeout)
    }
  })
}
