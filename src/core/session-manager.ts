/**
 * SessionManager - Manages session lifecycle
 *
 * Creates, destroys, and tracks AI coding sessions.
 * Coordinates with WorktreeManager, ProcessRegistry, and StatusMonitor.
 */

import { EventEmitter } from 'events'
import { spawn } from 'child_process'
import type {
  Session,
  SessionConfig,
  SessionStatus,
  SessionState,
  SessionMode,
  SessionEvent,
} from './types.js'
import { WorktreeManager } from './worktree-manager.js'
import { ProcessRegistry } from './process-registry.js'
import { StatusMonitor } from './status-monitor.js'

interface SessionManagerConfig {
  repoPath: string
  statusDir?: string
}

// Commands to launch for each mode
const MODE_COMMANDS: Record<SessionMode, { command: string; args: string[] }> = {
  claude: { command: 'claude', args: [] },
  gemini: { command: 'gemini', args: [] },
  codex: { command: 'codex', args: [] },
  shell: { command: process.env.SHELL || 'bash', args: [] },
}

export class SessionManager extends EventEmitter {
  private sessions: Map<string, Session> = new Map()
  private nextDisplayId = 1
  private repoPath: string

  readonly worktrees: WorktreeManager
  readonly processes: ProcessRegistry
  readonly status: StatusMonitor

  constructor(config: SessionManagerConfig) {
    super()
    this.repoPath = config.repoPath

    this.worktrees = new WorktreeManager(config.repoPath)
    this.processes = new ProcessRegistry()
    this.status = new StatusMonitor({ statusDir: config.statusDir })

    this.setupEventForwarding()
  }

  /**
   * Initialize the session manager (start status monitoring)
   */
  async start(): Promise<void> {
    await this.status.start()
  }

  /**
   * Shutdown the session manager (cleanup all sessions)
   */
  async stop(): Promise<void> {
    // Kill all processes
    await this.processes.killAll()

    // Stop status monitoring
    await this.status.stop()
  }

  /**
   * Create a new session
   */
  async createSession(config: SessionConfig): Promise<Session> {
    const id = this.generateSessionId()
    const displayId = this.nextDisplayId++

    // Create initial session object
    const session: Session = {
      id,
      displayId,
      branch: config.branch || null,
      worktreePath: null,
      status: {
        state: 'initializing',
        message: 'Setting up session...',
        lastActivity: new Date(),
      },
      mode: config.mode || 'claude',
      pid: null,
      createdAt: new Date(),
      repoPath: config.repoPath,
    }

    this.sessions.set(id, session)
    this.status.registerSession(id)
    this.emitSessionEvent('created', session)

    try {
      // Create worktree if branch specified
      if (config.branch) {
        session.status.message = 'Creating worktree...'
        session.worktreePath = await this.worktrees.create(id, config.branch)
      }

      // Spawn the AI process
      session.status.message = `Starting ${session.mode}...`
      const workDir = session.worktreePath || config.workingDirectory
      const { command, args } = MODE_COMMANDS[session.mode]

      const proc = this.processes.spawn(id, command, args, {
        cwd: workDir,
        env: {
          ...process.env,
          ORCHA_SESSION_ID: id,
          ORCHA_DISPLAY_ID: String(displayId),
        },
      })

      session.pid = proc.pid || null

      // Update status to idle once started
      await this.status.updateStatus(id, {
        state: 'idle',
        message: 'Ready',
      })

      this.emitSessionEvent('updated', session)

      return session
    } catch (err) {
      // Cleanup on failure
      await this.destroySession(id)
      throw err
    }
  }

  /**
   * Destroy a session
   */
  async destroySession(id: string): Promise<void> {
    const session = this.sessions.get(id)
    if (!session) return

    // Kill process
    await this.processes.kill(id)

    // Remove worktree
    if (session.worktreePath) {
      try {
        await this.worktrees.remove(id)
      } catch {
        // Ignore worktree removal errors
      }
    }

    // Unregister from status monitor
    await this.status.unregisterSession(id)

    // Remove from sessions
    this.sessions.delete(id)

    this.emitSessionEvent('destroyed', session)
  }

  /**
   * Get a session by ID
   */
  getSession(id: string): Session | undefined {
    return this.sessions.get(id)
  }

  /**
   * Get a session by display ID (#1, #2, etc.)
   */
  getSessionByDisplayId(displayId: number): Session | undefined {
    for (const session of this.sessions.values()) {
      if (session.displayId === displayId) {
        return session
      }
    }
    return undefined
  }

  /**
   * List all sessions
   */
  listSessions(): Session[] {
    return Array.from(this.sessions.values()).sort((a, b) => a.displayId - b.displayId)
  }

  /**
   * Get count of active sessions
   */
  get activeCount(): number {
    return this.sessions.size
  }

  /**
   * Send input to a session
   */
  sendInput(id: string, input: string): boolean {
    return this.processes.sendInput(id, input + '\n')
  }

  /**
   * Send input to a session by display ID
   */
  sendInputByDisplayId(displayId: number, input: string): boolean {
    const session = this.getSessionByDisplayId(displayId)
    if (!session) return false
    return this.sendInput(session.id, input)
  }

  /**
   * Get sessions that need user input
   */
  getWaitingSessions(): Session[] {
    return this.listSessions().filter((s) => {
      const status = this.status.getStatus(s.id)
      return status?.state === 'waiting'
    })
  }

  /**
   * Get sessions grouped by state
   */
  getSessionsByState(): Record<SessionState, Session[]> {
    const result: Record<SessionState, Session[]> = {
      initializing: [],
      idle: [],
      working: [],
      waiting: [],
      done: [],
      error: [],
    }

    for (const session of this.sessions.values()) {
      const status = this.status.getStatus(session.id)
      const state = status?.state || 'idle'
      result[state].push(session)
    }

    return result
  }

  /**
   * Cleanup orphaned resources
   */
  async cleanup(): Promise<{ worktrees: string[]; processes: number }> {
    const activeIds = Array.from(this.sessions.keys())

    // Cleanup orphaned worktrees
    const removedWorktrees = await this.worktrees.cleanup(activeIds)

    // Prune exited processes
    const prunedProcesses = this.processes.prune()

    return {
      worktrees: removedWorktrees,
      processes: prunedProcesses,
    }
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  private generateSessionId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).slice(2, 6)
    return `session-${timestamp}-${random}`
  }

  private setupEventForwarding(): void {
    // Forward status events to session events
    this.status.on('status-change', (event) => {
      const session = this.sessions.get(event.sessionId)
      if (session) {
        session.status = event.status
        this.emitSessionEvent('updated', session)
      }
    })

    // Forward process exit events
    this.processes.on('exit', (sessionId, code) => {
      const session = this.sessions.get(sessionId)
      if (session) {
        const state: SessionState = code === 0 ? 'done' : 'error'
        const message = code === 0 ? 'Process exited' : `Process exited with code ${code}`
        this.status.updateStatus(sessionId, { state, message })
      }
    })

    this.processes.on('error', (sessionId, error) => {
      this.status.updateStatus(sessionId, {
        state: 'error',
        message: error.message,
      })
    })
  }

  private emitSessionEvent(type: SessionEvent['type'], session: Session): void {
    const event: SessionEvent = {
      type,
      sessionId: session.id,
      session: type !== 'destroyed' ? session : undefined,
      timestamp: new Date(),
    }
    // Use type assertion for dynamic event name
    ;(this as EventEmitter).emit(type, event)
    ;(this as EventEmitter).emit('session', event)
  }
}

// Type-safe event emitter interface
export interface SessionManager {
  on(event: 'created', listener: (event: SessionEvent) => void): this
  on(event: 'updated', listener: (event: SessionEvent) => void): this
  on(event: 'destroyed', listener: (event: SessionEvent) => void): this
  on(event: 'session', listener: (event: SessionEvent) => void): this

  emit(event: 'created', data: SessionEvent): boolean
  emit(event: 'updated', data: SessionEvent): boolean
  emit(event: 'destroyed', data: SessionEvent): boolean
  emit(event: 'session', data: SessionEvent): boolean
}
