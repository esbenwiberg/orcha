/**
 * StatusMonitor - Watches for agent status updates and emits events
 *
 * Status sources (in priority order):
 * 1. MCP orcha_status tool - Agent self-reports (best)
 * 2. Status file watch - JSON files in statusDir
 * 3. Process activity - CPU/IO checks (fallback)
 * 4. Idle timeout - No activity for N seconds (fallback)
 */

import { EventEmitter } from 'events'
import { watch, FSWatcher } from 'chokidar'
import { readFile, mkdir, writeFile, readdir, unlink } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import type {
  SessionStatus,
  SessionState,
  StatusFileContent,
  StatusMonitorConfig,
  StatusEvent,
} from './types.js'

const DEFAULT_CONFIG: StatusMonitorConfig = {
  statusDir: '/tmp/orcha/agents',
  pollInterval: 1000,
  idleTimeout: 30000,
}

interface StatusEntry {
  status: SessionStatus
  lastFileUpdate: Date
}

export class StatusMonitor extends EventEmitter {
  private config: StatusMonitorConfig
  private statuses: Map<string, StatusEntry> = new Map()
  private watcher: FSWatcher | null = null
  private pollTimer: NodeJS.Timeout | null = null
  private idleTimers: Map<string, NodeJS.Timeout> = new Map()
  private running = false

  constructor(config: Partial<StatusMonitorConfig> = {}) {
    super()
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async start(): Promise<void> {
    if (this.running) return

    // Ensure status directory exists
    await mkdir(this.config.statusDir, { recursive: true })

    // Load existing status files
    await this.loadExistingStatuses()

    // Start file watcher
    this.watcher = watch(join(this.config.statusDir, '*.json'), {
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    })

    this.watcher.on('add', (path) => this.handleFileChange(path))
    this.watcher.on('change', (path) => this.handleFileChange(path))
    this.watcher.on('unlink', (path) => this.handleFileRemove(path))

    // Start idle check polling
    this.pollTimer = setInterval(() => this.checkIdleTimeouts(), this.config.pollInterval)

    this.running = true
  }

  async stop(): Promise<void> {
    if (!this.running) return

    if (this.watcher) {
      await this.watcher.close()
      this.watcher = null
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }

    for (const timer of this.idleTimers.values()) {
      clearTimeout(timer)
    }
    this.idleTimers.clear()

    this.running = false
  }

  getStatus(sessionId: string): SessionStatus | undefined {
    return this.statuses.get(sessionId)?.status
  }

  getAllStatuses(): Map<string, SessionStatus> {
    const result = new Map<string, SessionStatus>()
    for (const [id, entry] of this.statuses) {
      result.set(id, entry.status)
    }
    return result
  }

  /**
   * Update status programmatically (used by MCP server)
   */
  async updateStatus(sessionId: string, status: Partial<SessionStatus>): Promise<void> {
    const current = this.statuses.get(sessionId)?.status
    const newStatus: SessionStatus = {
      state: status.state ?? current?.state ?? 'idle',
      message: status.message ?? current?.message ?? '',
      lastActivity: new Date(),
      needsInput: status.needsInput,
      progress: status.progress,
    }

    await this.setStatus(sessionId, newStatus)
  }

  /**
   * Register a new session (initializes with 'initializing' state)
   */
  registerSession(sessionId: string): void {
    if (this.statuses.has(sessionId)) return

    const status: SessionStatus = {
      state: 'initializing',
      message: 'Starting up...',
      lastActivity: new Date(),
    }

    this.statuses.set(sessionId, {
      status,
      lastFileUpdate: new Date(),
    })

    this.emitStatusChange(sessionId, status)
    this.resetIdleTimer(sessionId)
  }

  /**
   * Unregister a session (cleanup)
   */
  async unregisterSession(sessionId: string): Promise<void> {
    const timer = this.idleTimers.get(sessionId)
    if (timer) {
      clearTimeout(timer)
      this.idleTimers.delete(sessionId)
    }

    this.statuses.delete(sessionId)

    // Remove status file if exists
    const filePath = this.getStatusFilePath(sessionId)
    if (existsSync(filePath)) {
      await unlink(filePath)
    }
  }

  /**
   * Write status to file (for testing or manual updates)
   */
  async writeStatusFile(sessionId: string, status: SessionStatus): Promise<void> {
    const content: StatusFileContent = {
      agentId: sessionId,
      state: status.state,
      message: status.message,
      timestamp: status.lastActivity.toISOString(),
      needsInputPrompt: status.needsInput,
      progress: status.progress,
    }

    const filePath = this.getStatusFilePath(sessionId)
    await writeFile(filePath, JSON.stringify(content, null, 2))
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private getStatusFilePath(sessionId: string): string {
    return join(this.config.statusDir, `${sessionId}.json`)
  }

  private getSessionIdFromPath(filePath: string): string {
    return basename(filePath, '.json')
  }

  private async loadExistingStatuses(): Promise<void> {
    if (!existsSync(this.config.statusDir)) return

    const files = await readdir(this.config.statusDir)
    for (const file of files) {
      if (file.endsWith('.json')) {
        const filePath = join(this.config.statusDir, file)
        await this.handleFileChange(filePath)
      }
    }
  }

  private async handleFileChange(filePath: string): Promise<void> {
    const sessionId = this.getSessionIdFromPath(filePath)

    try {
      const content = await readFile(filePath, 'utf-8')
      const data = JSON.parse(content) as StatusFileContent

      const status: SessionStatus = {
        state: data.state,
        message: data.message,
        lastActivity: new Date(data.timestamp),
        needsInput: data.needsInputPrompt,
        progress: data.progress,
      }

      await this.setStatus(sessionId, status)
    } catch (err) {
      // Invalid JSON or read error - ignore
    }
  }

  private handleFileRemove(filePath: string): void {
    const sessionId = this.getSessionIdFromPath(filePath)
    // Don't remove from statuses - session might still be running
    // Just mark as unknown state if we had it
    const entry = this.statuses.get(sessionId)
    if (entry) {
      entry.status.message = 'Status file removed'
    }
  }

  private async setStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const previous = this.statuses.get(sessionId)?.status
    const previousState = previous?.state

    this.statuses.set(sessionId, {
      status,
      lastFileUpdate: new Date(),
    })

    // Reset idle timer on any activity
    this.resetIdleTimer(sessionId)

    // Emit appropriate events
    if (previousState !== status.state) {
      this.emitStatusChange(sessionId, status, previousState)

      // Special events for specific state transitions
      if (status.state === 'waiting' && status.needsInput) {
        this.emit('needs-input', sessionId, status.needsInput)
      }
      if (status.state === 'error') {
        this.emit('error', sessionId, status.message)
      }
      if (status.state === 'done') {
        this.emit('done', sessionId)
      }
    }
  }

  private emitStatusChange(
    sessionId: string,
    status: SessionStatus,
    previousState?: SessionState
  ): void {
    const event: StatusEvent = {
      type: 'status-change',
      sessionId,
      status,
      previousState,
      timestamp: new Date(),
    }
    this.emit('status-change', event)
  }

  private resetIdleTimer(sessionId: string): void {
    // Clear existing timer
    const existing = this.idleTimers.get(sessionId)
    if (existing) {
      clearTimeout(existing)
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.handleIdleTimeout(sessionId)
    }, this.config.idleTimeout)

    this.idleTimers.set(sessionId, timer)
  }

  private handleIdleTimeout(sessionId: string): void {
    const entry = this.statuses.get(sessionId)
    if (!entry) return

    // Only transition to idle from working state
    if (entry.status.state === 'working') {
      const newStatus: SessionStatus = {
        ...entry.status,
        state: 'idle',
        message: 'Idle (no recent activity)',
        lastActivity: entry.status.lastActivity,
      }
      this.setStatus(sessionId, newStatus)
    }
  }

  private checkIdleTimeouts(): void {
    const now = Date.now()

    for (const [sessionId, entry] of this.statuses) {
      const elapsed = now - entry.status.lastActivity.getTime()

      // Check for stale "working" status
      if (entry.status.state === 'working' && elapsed > this.config.idleTimeout) {
        this.handleIdleTimeout(sessionId)
      }
    }
  }
}

// Type-safe event emitter interface
export interface StatusMonitor {
  on(event: 'status-change', listener: (event: StatusEvent) => void): this
  on(event: 'needs-input', listener: (sessionId: string, prompt: string) => void): this
  on(event: 'error', listener: (sessionId: string, message: string) => void): this
  on(event: 'done', listener: (sessionId: string) => void): this

  emit(event: 'status-change', data: StatusEvent): boolean
  emit(event: 'needs-input', sessionId: string, prompt: string): boolean
  emit(event: 'error', sessionId: string, message: string): boolean
  emit(event: 'done', sessionId: string): boolean
}
