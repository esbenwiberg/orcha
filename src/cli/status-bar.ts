/**
 * StatusBar - Manages tmux status bar updates for Orcha
 *
 * Provides real-time status visibility in the tmux status line,
 * showing all session states at a glance.
 */

import { execSync } from 'child_process'
import type { SessionStatus, SessionState } from '../core/types.js'
import { STATE_ICONS } from '../core/types.js'
import { StatusMonitor } from '../core/status-monitor.js'

export interface StatusBarConfig {
  sessionName: string
  updateInterval: number // ms
  maxSessions: number // Max sessions to show in status bar
}

const DEFAULT_CONFIG: StatusBarConfig = {
  sessionName: 'orcha',
  updateInterval: 2000,
  maxSessions: 6,
}

export class StatusBar {
  private config: StatusBarConfig
  private monitor: StatusMonitor | null = null
  private updateTimer: NodeJS.Timeout | null = null
  private running = false

  constructor(config: Partial<StatusBarConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * Start the status bar updater
   */
  async start(monitor?: StatusMonitor): Promise<void> {
    if (this.running) return

    // Use provided monitor or create new one
    this.monitor = monitor || new StatusMonitor()
    if (!monitor) {
      await this.monitor.start()
    }

    // Initial update
    this.update()

    // Start periodic updates
    this.updateTimer = setInterval(() => this.update(), this.config.updateInterval)

    // Listen for status changes for immediate updates
    this.monitor.on('status-change', () => this.update())

    this.running = true
  }

  /**
   * Stop the status bar updater
   */
  async stop(): Promise<void> {
    if (!this.running) return

    if (this.updateTimer) {
      clearInterval(this.updateTimer)
      this.updateTimer = null
    }

    this.running = false
  }

  /**
   * Update the tmux status bar
   */
  private update(): void {
    if (!this.monitor) return

    const statuses = this.monitor.getAllStatuses()
    const statusLine = this.formatStatusLine(statuses)

    this.setTmuxStatus(statusLine)
  }

  /**
   * Format the status line for tmux
   */
  private formatStatusLine(statuses: Map<string, SessionStatus>): string {
    if (statuses.size === 0) {
      return 'orcha: no sessions'
    }

    const parts: string[] = []
    let displayId = 1

    for (const [sessionId, status] of statuses) {
      if (displayId > this.config.maxSessions) {
        parts.push(`+${statuses.size - this.config.maxSessions} more`)
        break
      }

      const icon = STATE_ICONS[status.state]
      const color = this.getTmuxColor(status.state)
      const shortId = sessionId.replace('session-', '')

      // Format: #1●auth (with tmux color codes)
      parts.push(`#[fg=${color}]#${displayId}${icon}#[fg=default]${shortId}`)
      displayId++
    }

    return `orcha: ${parts.join(' ')}`
  }

  /**
   * Get tmux color for a state
   */
  private getTmuxColor(state: SessionState): string {
    const colors: Record<SessionState, string> = {
      initializing: 'colour8', // gray
      idle: 'colour7', // white
      working: 'colour2', // green
      waiting: 'colour3', // yellow
      done: 'colour6', // cyan
      error: 'colour1', // red
    }
    return colors[state] || 'default'
  }

  /**
   * Set the tmux status-right option
   */
  private setTmuxStatus(statusLine: string): void {
    if (!this.tmuxSessionExists()) return

    try {
      // Escape special characters for tmux
      const escaped = statusLine.replace(/"/g, '\\"')

      execSync(
        `tmux set-option -t "${this.config.sessionName}" status-right "${escaped} | %H:%M:%S"`,
        { stdio: 'pipe' }
      )
    } catch {
      // Ignore errors (session might not exist)
    }
  }

  /**
   * Check if tmux session exists
   */
  private tmuxSessionExists(): boolean {
    try {
      execSync(`tmux has-session -t "${this.config.sessionName}" 2>/dev/null`, {
        stdio: 'pipe',
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Get a summary string for external use
   */
  getSummary(statuses: Map<string, SessionStatus>): string {
    let working = 0,
      waiting = 0,
      idle = 0,
      done = 0,
      error = 0

    for (const status of statuses.values()) {
      switch (status.state) {
        case 'working':
          working++
          break
        case 'waiting':
          waiting++
          break
        case 'idle':
        case 'initializing':
          idle++
          break
        case 'done':
          done++
          break
        case 'error':
          error++
          break
      }
    }

    const total = statuses.size
    const parts = [
      `${total} total`,
      working > 0 ? `${working} working` : null,
      waiting > 0 ? `${waiting} waiting` : null,
      idle > 0 ? `${idle} idle` : null,
      done > 0 ? `${done} done` : null,
      error > 0 ? `${error} error` : null,
    ].filter(Boolean)

    return parts.join(', ')
  }
}
