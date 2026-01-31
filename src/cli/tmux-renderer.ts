/**
 * TmuxRenderer - tmux session and pane management for Orcha
 *
 * Manages tmux layout for multiple AI coding sessions.
 */

import { execSync, spawn, ChildProcess } from 'child_process'
import type { Session, SessionStatus } from '../core/types.js'
import { STATE_ICONS } from '../core/types.js'

export interface TmuxConfig {
  sessionName: string
  statusUpdateInterval?: number // ms, default 5000
}

export class TmuxRenderer {
  private sessionName: string
  private panes: Map<string, string> = new Map() // sessionId -> paneId
  private statusUpdateInterval: number

  constructor(config: TmuxConfig) {
    this.sessionName = config.sessionName
    this.statusUpdateInterval = config.statusUpdateInterval || 5000
  }

  /**
   * Check if tmux is available
   */
  static isAvailable(): boolean {
    try {
      execSync('which tmux', { stdio: 'pipe' })
      return true
    } catch {
      return false
    }
  }

  /**
   * Check if we're inside a tmux session
   */
  static isInsideTmux(): boolean {
    return !!process.env.TMUX
  }

  /**
   * Create a new tmux session for orcha
   */
  createSession(): void {
    if (this.sessionExists()) {
      throw new Error(`tmux session '${this.sessionName}' already exists`)
    }

    // Create session in detached mode
    execSync(`tmux new-session -d -s "${this.sessionName}" -x 200 -y 50`, {
      stdio: 'pipe',
    })
  }

  /**
   * Check if the orcha tmux session exists
   */
  sessionExists(): boolean {
    try {
      execSync(`tmux has-session -t "${this.sessionName}" 2>/dev/null`, {
        stdio: 'pipe',
      })
      return true
    } catch {
      return false
    }
  }

  /**
   * Kill the orcha tmux session
   */
  killSession(): void {
    if (this.sessionExists()) {
      execSync(`tmux kill-session -t "${this.sessionName}"`, { stdio: 'pipe' })
    }
    this.panes.clear()
  }

  /**
   * Create a new pane for a session
   */
  createPane(sessionId: string, workingDir: string): string {
    if (!this.sessionExists()) {
      this.createSession()
    }

    // Get current pane count
    const paneCount = this.getPaneCount()

    let paneId: string

    if (paneCount === 1 && this.panes.size === 0) {
      // Use the first pane but change to correct directory
      paneId = `${this.sessionName}:0.0`
      execSync(`tmux send-keys -t "${paneId}" "cd '${workingDir}' && clear" Enter`, {
        stdio: 'pipe',
      })
    } else {
      // Split horizontally or vertically based on layout
      const splitDir = paneCount % 2 === 0 ? '-v' : '-h'
      execSync(
        `tmux split-window ${splitDir} -t "${this.sessionName}" -c "${workingDir}"`,
        { stdio: 'pipe' }
      )
      paneId = `${this.sessionName}:0.${paneCount}`
    }

    // Set pane title
    execSync(`tmux select-pane -t "${paneId}" -T "${sessionId}"`, {
      stdio: 'pipe',
    })

    // Balance the layout
    execSync(`tmux select-layout -t "${this.sessionName}" tiled`, {
      stdio: 'pipe',
    })

    this.panes.set(sessionId, paneId)
    return paneId
  }

  /**
   * Run a command in a pane
   */
  runInPane(sessionId: string, command: string): void {
    const paneId = this.panes.get(sessionId)
    if (!paneId) {
      throw new Error(`No pane found for session ${sessionId}`)
    }

    // Send keys to the pane
    execSync(`tmux send-keys -t "${paneId}" "${command}" Enter`, {
      stdio: 'pipe',
    })
  }

  /**
   * Send input to a pane
   */
  sendInput(sessionId: string, input: string): void {
    const paneId = this.panes.get(sessionId)
    if (!paneId) {
      throw new Error(`No pane found for session ${sessionId}`)
    }

    // Escape special characters for tmux
    const escaped = input.replace(/"/g, '\\"').replace(/\$/g, '\\$')
    execSync(`tmux send-keys -t "${paneId}" "${escaped}" Enter`, {
      stdio: 'pipe',
    })
  }

  /**
   * Kill a specific pane
   */
  killPane(sessionId: string): void {
    const paneId = this.panes.get(sessionId)
    if (!paneId) return

    try {
      execSync(`tmux kill-pane -t "${paneId}"`, { stdio: 'pipe' })
    } catch {
      // Pane might already be gone
    }

    this.panes.delete(sessionId)

    // Rebalance remaining panes
    if (this.panes.size > 0) {
      try {
        execSync(`tmux select-layout -t "${this.sessionName}" tiled`, {
          stdio: 'pipe',
        })
      } catch {
        // Session might be gone if that was the last pane
      }
    }
  }

  /**
   * Focus on a specific session's pane
   */
  focusPane(sessionId: string): void {
    const paneId = this.panes.get(sessionId)
    if (!paneId) {
      throw new Error(`No pane found for session ${sessionId}`)
    }

    execSync(`tmux select-pane -t "${paneId}"`, { stdio: 'pipe' })
  }

  /**
   * Focus on a pane by its index (0-based)
   */
  focusPaneByIndex(index: number): void {
    if (!this.sessionExists()) {
      throw new Error(`tmux session '${this.sessionName}' does not exist`)
    }

    const paneId = `${this.sessionName}:0.${index}`
    execSync(`tmux select-pane -t "${paneId}"`, { stdio: 'pipe' })
  }

  /**
   * Attach to the orcha tmux session
   */
  attach(): void {
    if (!this.sessionExists()) {
      throw new Error(`tmux session '${this.sessionName}' does not exist`)
    }

    // If we're inside tmux, switch client. Otherwise attach.
    if (TmuxRenderer.isInsideTmux()) {
      execSync(`tmux switch-client -t "${this.sessionName}"`, { stdio: 'inherit' })
    } else {
      // Use spawn with inherit to properly attach
      const child = spawn('tmux', ['attach-session', '-t', this.sessionName], {
        stdio: 'inherit',
      })
      child.on('exit', () => process.exit(0))
    }
  }

  /**
   * Update the tmux status bar with session info
   */
  updateStatusBar(sessions: Session[], statuses: Map<string, SessionStatus>): void {
    if (!this.sessionExists()) return

    const statusParts = sessions.map((s) => {
      const status = statuses.get(s.id)
      const icon = status ? STATE_ICONS[status.state] : '?'
      const branch = s.branch ? s.branch.replace('feature/', '') : s.id.slice(-6)
      return `#${s.displayId}${icon}${branch}`
    })

    const statusLine = statusParts.join(' | ')

    // Set tmux status-right
    try {
      execSync(
        `tmux set-option -t "${this.sessionName}" status-right "${statusLine} | %H:%M:%S"`,
        { stdio: 'pipe' }
      )
    } catch {
      // Ignore errors
    }
  }

  /**
   * Get the number of panes in the session
   */
  private getPaneCount(): number {
    try {
      const output = execSync(
        `tmux list-panes -t "${this.sessionName}" | wc -l`,
        { encoding: 'utf8', stdio: 'pipe' }
      )
      return parseInt(output.trim(), 10)
    } catch {
      return 0
    }
  }

  /**
   * Get the pane map (for debugging)
   */
  getPanes(): Map<string, string> {
    return new Map(this.panes)
  }

  /**
   * Discover existing panes by reading their titles
   * This rebuilds the sessionId -> paneId mapping for panes created in previous runs
   */
  discoverExistingPanes(): Map<string, string> {
    if (!this.sessionExists()) {
      return this.panes
    }

    try {
      const output = execSync(
        `tmux list-panes -t "${this.sessionName}" -F "#{pane_index}:#{pane_title}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      )

      for (const line of output.trim().split('\n')) {
        if (!line) continue
        const [indexStr, title] = line.split(':')
        const index = parseInt(indexStr, 10)

        // Only add if title looks like a session ID and not already tracked
        if (title && title.startsWith('session-') && !this.panes.has(title)) {
          const paneId = `${this.sessionName}:0.${index}`
          this.panes.set(title, paneId)
        }
      }
    } catch {
      // Session might not exist or tmux error
    }

    return this.panes
  }

  /**
   * Get list of active pane session IDs (for cleanup detection)
   */
  getActivePaneSessionIds(): Set<string> {
    const active = new Set<string>()

    if (!this.sessionExists()) {
      return active
    }

    try {
      const output = execSync(
        `tmux list-panes -t "${this.sessionName}" -F "#{pane_title}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      )

      for (const line of output.trim().split('\n')) {
        if (line && line.startsWith('session-')) {
          active.add(line)
        }
      }
    } catch {
      // Ignore errors
    }

    return active
  }

  /**
   * Capture recent content from a pane
   */
  capturePaneContent(paneIndex: number, lines = 50): string {
    try {
      const paneId = `${this.sessionName}:0.${paneIndex}`
      const output = execSync(
        `tmux capture-pane -t "${paneId}" -p -S -${lines}`,
        { encoding: 'utf8', stdio: 'pipe' }
      )
      return output
    } catch {
      return ''
    }
  }

  /**
   * Detect Claude session status from pane content
   * Returns 'working' | 'waiting' | 'idle' | 'error' | null
   */
  detectClaudeStatus(paneIndex: number): { state: string; message: string } | null {
    const content = this.capturePaneContent(paneIndex, 30)
    if (!content) return null

    const lines = content.split('\n')
    const lastLines = lines.slice(-15) // Focus on recent output

    // First pass: check for active working indicators (these take priority)
    for (const line of lastLines.reverse()) {
      // Active computation indicators (highest priority)
      if (line.includes('✢ Computing') || line.includes('✢ ')) {
        const match = line.match(/\(thought for (\d+s)\)/)
        return { state: 'working', message: match ? `Thinking (${match[1]})` : 'Computing...' }
      }
      if (line.includes('Running') && line.includes('agent')) {
        const match = line.match(/Running (\d+) .* agents?/)
        return { state: 'working', message: match ? `Running ${match[1]} agents` : 'Running agents' }
      }
    }

    // Second pass: check most recent lines for state
    for (const line of lastLines.reverse()) {
      // Check for working indicators (Claude is processing)
      if (line.includes('● ') && !line.includes('finished') && !line.includes('completed')) {
        const msg = line.replace(/^[●○◐◌✓✗✢\s]+/, '').trim().slice(0, 40)
        if (msg && !msg.startsWith('Background')) {
          return { state: 'working', message: msg || 'Working...' }
        }
      }

      // Specific tool activity
      if (line.includes('Searching') || line.includes('Reading') ||
          line.includes('Writing') || line.includes('Editing') ||
          line.includes('Moseying') || line.includes('Pondering') ||
          line.includes('Analyzing') || line.includes('Exploring')) {
        const msg = line.replace(/^[●○◐◌✓✗✢\s]+/, '').trim().slice(0, 40)
        return { state: 'working', message: msg || 'Working...' }
      }

      // Check for error indicators
      if (line.includes('Error:') || line.includes('error:') || line.includes('✗ ') ||
          line.includes('API Error:')) {
        const msg = line.replace(/^[●○◐◌✓✗✢\s]+/, '').trim().slice(0, 40)
        return { state: 'error', message: msg || 'Error occurred' }
      }
    }

    // Third pass: check for prompt/waiting state
    for (const line of lastLines.reverse()) {
      // Plan mode prompt
      if (line.includes('plan mode on')) {
        return { state: 'waiting', message: 'Plan mode - awaiting input' }
      }
      // Menu selection
      if (line.match(/❯\s+\d+\.\s+/)) {
        return { state: 'waiting', message: 'Menu selection' }
      }
      // Empty prompt
      if (line.match(/^❯\s*$/) || line.match(/^>\s*$/)) {
        return { state: 'waiting', message: 'Awaiting input' }
      }
      // Prompt with content (user typing)
      if (line.match(/^❯\s+\S/)) {
        return { state: 'waiting', message: 'At prompt' }
      }
    }

    // Check for done indicators
    for (const line of lastLines) {
      if (line.includes('✓ ') || (line.includes('Done') && !line.includes('Undo'))) {
        return { state: 'done', message: 'Task complete' }
      }
    }

    return null // Unable to detect, use file-based status
  }

  /**
   * List all panes in the session with their indices
   */
  listPanes(): Array<{ index: number; title: string }> {
    try {
      const output = execSync(
        `tmux list-panes -t "${this.sessionName}" -F "#{pane_index}:#{pane_title}"`,
        { encoding: 'utf8', stdio: 'pipe' }
      )
      return output.trim().split('\n').map(line => {
        const [index, title] = line.split(':')
        return { index: parseInt(index, 10), title: title || '' }
      })
    } catch {
      return []
    }
  }
}
