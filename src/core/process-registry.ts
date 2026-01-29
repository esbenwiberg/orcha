/**
 * ProcessRegistry - Tracks spawned processes and handles cleanup
 *
 * Ensures all child processes are properly terminated on exit.
 * Uses tree-kill to handle process trees (important for shell processes).
 */

import { EventEmitter } from 'events'
import { spawn, ChildProcess, SpawnOptions } from 'child_process'
import treeKill from 'tree-kill'
import type { ProcessInfo } from './types.js'

interface ProcessEntry extends ProcessInfo {
  process: ChildProcess
  exitCode: number | null
  exited: boolean
}

export class ProcessRegistry extends EventEmitter {
  private processes: Map<string, ProcessEntry> = new Map()
  private cleanupRegistered = false

  constructor() {
    super()
    this.registerCleanupHandlers()
  }

  /**
   * Spawn a new process and track it
   */
  spawn(
    sessionId: string,
    command: string,
    args: string[] = [],
    options: SpawnOptions = {}
  ): ChildProcess {
    // Check if session already has a process
    const existing = this.processes.get(sessionId)
    if (existing && !existing.exited) {
      throw new Error(`Session ${sessionId} already has an active process`)
    }

    const proc = spawn(command, args, {
      stdio: 'pipe',
      ...options,
    })

    if (!proc.pid) {
      throw new Error(`Failed to spawn process for session ${sessionId}`)
    }

    const entry: ProcessEntry = {
      pid: proc.pid,
      sessionId,
      command: `${command} ${args.join(' ')}`.trim(),
      startedAt: new Date(),
      process: proc,
      exitCode: null,
      exited: false,
    }

    this.processes.set(sessionId, entry)

    // Handle process exit
    proc.on('exit', (code, signal) => {
      entry.exitCode = code
      entry.exited = true
      this.emit('exit', sessionId, code, signal)
    })

    proc.on('error', (err) => {
      this.emit('error', sessionId, err)
    })

    this.emit('spawn', sessionId, proc.pid)

    return proc
  }

  /**
   * Kill a process by session ID
   */
  async kill(sessionId: string, signal: NodeJS.Signals = 'SIGTERM'): Promise<boolean> {
    const entry = this.processes.get(sessionId)
    if (!entry || entry.exited) {
      return false
    }

    return new Promise((resolve) => {
      treeKill(entry.pid, signal, (err) => {
        if (err) {
          // Process might already be dead
          resolve(false)
        } else {
          resolve(true)
        }
      })
    })
  }

  /**
   * Kill all tracked processes
   */
  async killAll(signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
    const kills = Array.from(this.processes.keys()).map((id) => this.kill(id, signal))
    await Promise.all(kills)
  }

  /**
   * Get process info by session ID
   */
  get(sessionId: string): ProcessInfo | undefined {
    const entry = this.processes.get(sessionId)
    if (!entry) return undefined

    return {
      pid: entry.pid,
      sessionId: entry.sessionId,
      command: entry.command,
      startedAt: entry.startedAt,
    }
  }

  /**
   * Get all tracked processes
   */
  getAll(): ProcessInfo[] {
    return Array.from(this.processes.values()).map((entry) => ({
      pid: entry.pid,
      sessionId: entry.sessionId,
      command: entry.command,
      startedAt: entry.startedAt,
    }))
  }

  /**
   * Get all active (non-exited) processes
   */
  getActive(): ProcessInfo[] {
    return Array.from(this.processes.values())
      .filter((entry) => !entry.exited)
      .map((entry) => ({
        pid: entry.pid,
        sessionId: entry.sessionId,
        command: entry.command,
        startedAt: entry.startedAt,
      }))
  }

  /**
   * Check if a session has an active process
   */
  isActive(sessionId: string): boolean {
    const entry = this.processes.get(sessionId)
    return entry !== undefined && !entry.exited
  }

  /**
   * Get the raw ChildProcess for a session
   */
  getProcess(sessionId: string): ChildProcess | undefined {
    return this.processes.get(sessionId)?.process
  }

  /**
   * Send input to a process
   */
  sendInput(sessionId: string, input: string): boolean {
    const entry = this.processes.get(sessionId)
    if (!entry || entry.exited || !entry.process.stdin) {
      return false
    }

    entry.process.stdin.write(input)
    return true
  }

  /**
   * Unregister a session (remove from tracking, doesn't kill)
   */
  unregister(sessionId: string): void {
    this.processes.delete(sessionId)
  }

  /**
   * Get count of active processes
   */
  get activeCount(): number {
    return Array.from(this.processes.values()).filter((e) => !e.exited).length
  }

  /**
   * Get count of all tracked processes
   */
  get totalCount(): number {
    return this.processes.size
  }

  /**
   * Cleanup exited processes from tracking
   */
  prune(): number {
    let pruned = 0
    for (const [id, entry] of this.processes) {
      if (entry.exited) {
        this.processes.delete(id)
        pruned++
      }
    }
    return pruned
  }

  /**
   * Register cleanup handlers for process exit
   */
  private registerCleanupHandlers(): void {
    if (this.cleanupRegistered) return

    const cleanup = async () => {
      await this.killAll()
    }

    process.on('exit', () => {
      // Synchronous cleanup on exit
      for (const entry of this.processes.values()) {
        if (!entry.exited) {
          try {
            process.kill(entry.pid, 'SIGKILL')
          } catch {
            // Ignore errors
          }
        }
      }
    })

    process.on('SIGINT', async () => {
      await cleanup()
      process.exit(130)
    })

    process.on('SIGTERM', async () => {
      await cleanup()
      process.exit(143)
    })

    this.cleanupRegistered = true
  }
}

// Type-safe event emitter interface
export interface ProcessRegistry {
  on(event: 'spawn', listener: (sessionId: string, pid: number) => void): this
  on(event: 'exit', listener: (sessionId: string, code: number | null, signal: string | null) => void): this
  on(event: 'error', listener: (sessionId: string, error: Error) => void): this

  emit(event: 'spawn', sessionId: string, pid: number): boolean
  emit(event: 'exit', sessionId: string, code: number | null, signal: string | null): boolean
  emit(event: 'error', sessionId: string, error: Error): boolean
}
