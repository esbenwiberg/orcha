/**
 * Blessed Dashboard - Maestro-style TUI for Orcha
 *
 * Layout:
 * ┌──────────┬──────────────────────────────────────────────┐
 * │ Sessions │  ┌──────────────┐  ┌──────────────┐          │
 * │          │  │ #1 auth ●    │  │ #2 api  ●    │          │
 * │ ● #1 auth│  │ Working on   │  │ Reading      │          │
 * │ ● #2 api │  │ login flow   │  │ routes.ts    │          │
 * │ ○ #3 test│  └──────────────┘  └──────────────┘          │
 * │          │  ┌──────────────┐  ┌──────────────┐          │
 * │          │  │ #3 test ○    │  │ #4 docs ◐    │          │
 * │          │  │ Idle         │  │ Waiting...   │          │
 * │          │  └──────────────┘  └──────────────┘          │
 * └──────────┴──────────────────────────────────────────────┘
 * [1-9] Focus  [y/n] Reply  [r] Refresh  [q] Quit
 */

import blessed from 'blessed'
import { StatusMonitor, getStatusDirForInstance } from '../core/status-monitor.js'
import { loadSessionStore } from '../core/session-store.js'
import { listInstances } from '../core/instance-registry.js'
import type { SessionMetadata } from '../core/session-store.js'
import { TmuxRenderer } from './tmux-renderer.js'
import type { SessionStatus, SessionState, InstanceInfo } from '../core/types.js'
import { STATE_ICONS, STATE_COLORS } from '../core/types.js'

// Blessed color mapping
const BLESSED_COLORS: Record<SessionState, string> = {
  initializing: 'gray',
  idle: 'white',
  working: 'green',
  waiting: 'yellow',
  done: 'cyan',
  error: 'red',
}

interface SessionRef {
  instanceId: string
  tmuxSession: string
  paneIndex: number
  sessionId: string
  displayId: number
  status: SessionStatus
  metadata?: SessionMetadata
  repoName: string
}

interface InstanceData {
  instance: InstanceInfo
  statuses: Map<string, SessionStatus>
  metadata: SessionMetadata[]
}

export interface BlessedDashboardConfig {
  refreshInterval: number
  singleInstance?: InstanceInfo
}

const DEFAULT_CONFIG: BlessedDashboardConfig = {
  refreshInterval: 2000,
  singleInstance: undefined,
}

export class BlessedDashboard {
  private config: BlessedDashboardConfig
  private screen: blessed.Widgets.Screen | null = null
  private sidebar: blessed.Widgets.ListElement | null = null
  private mainPanel: blessed.Widgets.BoxElement | null = null
  private statusBar: blessed.Widgets.BoxElement | null = null
  private sessionPanels: blessed.Widgets.BoxElement[] = []
  private sessionRefs: SessionRef[] = []
  private selectedIndex = 0
  private refreshTimer: NodeJS.Timeout | null = null

  constructor(config: Partial<BlessedDashboardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async start(): Promise<void> {
    this.createScreen()
    this.createLayout()
    this.bindKeys()
    await this.refresh()
    this.startRefreshLoop()
    this.screen?.render()
  }

  async stop(): Promise<void> {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer)
      this.refreshTimer = null
    }
    this.screen?.destroy()
    this.screen = null
  }

  private createScreen(): void {
    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Orcha Dashboard',
      cursor: {
        artificial: true,
        shape: 'block',
        blink: true,
        color: 'white',
      },
    })
  }

  private createLayout(): void {
    if (!this.screen) return

    // Header
    blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 3,
      content: '{center}{bold}{cyan-fg} ORCHA {/cyan-fg}{/bold}{/center}',
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: 'cyan' },
      },
    })

    // Sidebar (session list)
    this.sidebar = blessed.list({
      parent: this.screen,
      label: ' Sessions ',
      top: 3,
      left: 0,
      width: 22,
      height: '100%-6',
      border: { type: 'line' },
      style: {
        border: { fg: 'magenta' },
        selected: { bg: 'blue', bold: true },
        item: { fg: 'white' },
      },
      tags: true,
      keys: true,
      vi: true,
      mouse: true,
      scrollbar: {
        ch: '│',
        style: { fg: 'cyan' },
      },
    })

    // Main panel (session grid)
    this.mainPanel = blessed.box({
      parent: this.screen,
      top: 3,
      left: 22,
      width: '100%-22',
      height: '100%-6',
      border: { type: 'line' },
      style: {
        border: { fg: 'gray' },
      },
    })

    // Status bar
    this.statusBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 3,
      border: { type: 'line' },
      style: {
        border: { fg: 'gray' },
      },
      tags: true,
    })
  }

  private bindKeys(): void {
    if (!this.screen || !this.sidebar) return

    // Quit
    this.screen.key(['q', 'C-c'], () => {
      this.stop()
      process.exit(0)
    })

    // Refresh
    this.screen.key(['r'], () => {
      this.refresh()
    })

    // Number keys 1-9 to focus session
    for (let i = 1; i <= 9; i++) {
      this.screen.key([String(i)], () => {
        this.focusSession(i - 1)
      })
    }

    // y/n for waiting sessions
    this.screen.key(['y'], () => {
      this.replyToWaiting('y')
    })
    this.screen.key(['n'], () => {
      this.replyToWaiting('n')
    })

    // Arrow keys / vim keys to navigate sidebar
    this.sidebar.on('select item', (_item, index) => {
      this.selectedIndex = index
      this.highlightSession(index)
      this.screen?.render()
    })

    // Enter to focus selected
    this.screen.key(['enter'], () => {
      this.focusSession(this.selectedIndex)
    })

    // Tab to cycle through sessions
    this.screen.key(['tab'], () => {
      if (this.sessionRefs.length > 0) {
        this.selectedIndex = (this.selectedIndex + 1) % this.sessionRefs.length
        this.sidebar?.select(this.selectedIndex)
        this.highlightSession(this.selectedIndex)
        this.screen?.render()
      }
    })
  }

  private async refresh(): Promise<void> {
    const instances = this.config.singleInstance
      ? [this.config.singleInstance]
      : await listInstances()

    const data: InstanceData[] = []
    const refs: SessionRef[] = []

    if (instances.length > 0) {
      // Normal mode: read from registered instances
      for (const inst of instances) {
        const statusDir = getStatusDirForInstance(inst.instanceId)
        const monitor = new StatusMonitor({ statusDir })
        await monitor.start()
        const statuses = monitor.getAllStatuses()
        await monitor.stop()

        const metadata = await loadSessionStore(inst.instanceId)
        data.push({ instance: inst, statuses, metadata })

        const repoName = inst.instanceId.replace('orcha-', '')
        let paneIdx = 0
        for (const [sessionId, status] of statuses) {
          const sessionMeta = metadata.find((m) => m.id === sessionId)
          refs.push({
            instanceId: inst.instanceId,
            tmuxSession: inst.tmuxSession,
            paneIndex: paneIdx,
            sessionId,
            displayId: sessionMeta?.displayId ?? paneIdx + 1,
            status,
            metadata: sessionMeta,
            repoName,
          })
          paneIdx++
        }
      }
    } else {
      // Fallback mode: read from default status directory (for demo/testing)
      const statusDir = getStatusDirForInstance()
      const monitor = new StatusMonitor({ statusDir })
      await monitor.start()
      const statuses = monitor.getAllStatuses()
      await monitor.stop()

      let paneIdx = 0
      for (const [sessionId, status] of statuses) {
        refs.push({
          instanceId: 'demo',
          tmuxSession: 'demo',
          paneIndex: paneIdx,
          sessionId,
          displayId: paneIdx + 1,
          status,
          metadata: undefined,
          repoName: 'demo',
        })
        paneIdx++
      }
    }

    this.sessionRefs = refs
    this.updateSidebar()
    this.updateMainPanel()
    this.updateStatusBar()
    this.screen?.render()
  }

  private updateSidebar(): void {
    if (!this.sidebar) return

    const items: string[] = []

    // Simple flat list matching sessionRefs order
    for (let i = 0; i < this.sessionRefs.length; i++) {
      const ref = this.sessionRefs[i]
      const icon = STATE_ICONS[ref.status.state]
      const color = BLESSED_COLORS[ref.status.state]
      // Clean label: prefer short format like "#1 reponame" or just "#1"
      const sessionLabel = this.formatSessionLabel(ref, 10)
      items.push(`{${color}-fg}${icon}{/${color}-fg} [${i + 1}] ${sessionLabel}`)
    }

    if (items.length === 0) {
      items.push('{gray-fg}No sessions{/gray-fg}')
    }

    this.sidebar.setItems(items)
  }

  private formatSessionLabel(ref: SessionRef, maxLen: number): string {
    // If we have a branch, extract just the meaningful part
    if (ref.metadata?.branch) {
      // "orcha/session-1-20260131" -> "s1-0131" (compact)
      const branch = ref.metadata.branch.replace(/^orcha\//, '')
      const match = branch.match(/session-(\d+)-\d{4}(\d{4})/)
      if (match) {
        return `#${match[1]} ${ref.repoName.slice(0, 6)}`
      }
      return branch.slice(0, maxLen)
    }
    return `#${ref.displayId} ${ref.repoName.slice(0, 6)}`
  }

  private updateMainPanel(): void {
    if (!this.mainPanel) return

    // Clear existing panels
    for (const panel of this.sessionPanels) {
      panel.destroy()
    }
    this.sessionPanels = []

    if (this.sessionRefs.length === 0) {
      blessed.text({
        parent: this.mainPanel,
        top: 'center',
        left: 'center',
        content: '{gray-fg}No active sessions.\n\nStart with: orcha start -n <count> -r <repo>{/gray-fg}',
        tags: true,
      })
      return
    }

    // Calculate grid layout
    const cols = Math.min(3, Math.ceil(Math.sqrt(this.sessionRefs.length)))
    const rows = Math.ceil(this.sessionRefs.length / cols)
    const panelWidth = Math.floor(100 / cols)
    const panelHeight = Math.floor(100 / rows)

    this.sessionRefs.forEach((ref, index) => {
      const row = Math.floor(index / cols)
      const col = index % cols
      const color = BLESSED_COLORS[ref.status.state]
      const icon = STATE_ICONS[ref.status.state]
      const label = this.formatSessionLabel(ref, 16)

      const panel = blessed.box({
        parent: this.mainPanel!,
        top: `${row * panelHeight}%`,
        left: `${col * panelWidth}%`,
        width: `${panelWidth}%`,
        height: `${panelHeight}%`,
        label: ` [${index + 1}] ${label} `,
        border: { type: 'line' },
        style: {
          border: { fg: color },
          label: { fg: color, bold: true },
        },
        tags: true,
        padding: { left: 1, right: 1 },
      })

      // Status line
      blessed.text({
        parent: panel,
        top: 0,
        left: 0,
        content: `{${color}-fg}${icon} ${ref.status.state.toUpperCase()}{/${color}-fg}`,
        tags: true,
      })

      // Message
      const message = ref.status.message.slice(0, 60)
      blessed.text({
        parent: panel,
        top: 1,
        left: 0,
        content: `{gray-fg}"${message}"{/gray-fg}`,
        tags: true,
      })

      // Time
      const activity = this.formatRelativeTime(ref.status.lastActivity)
      blessed.text({
        parent: panel,
        top: 2,
        left: 0,
        content: `{gray-fg}${activity}{/gray-fg}`,
        tags: true,
      })

      // Needs input warning
      if (ref.status.state === 'waiting' && ref.status.needsInput) {
        blessed.text({
          parent: panel,
          top: 4,
          left: 0,
          content: `{yellow-fg}{bold}⚠ NEEDS INPUT{/bold}{/yellow-fg}`,
          tags: true,
        })
        blessed.text({
          parent: panel,
          top: 5,
          left: 0,
          content: `{yellow-fg}${ref.status.needsInput.slice(0, 50)}{/yellow-fg}`,
          tags: true,
        })
      }

      this.sessionPanels.push(panel)
    })
  }

  private updateStatusBar(): void {
    if (!this.statusBar) return

    const counts = {
      working: 0,
      waiting: 0,
      idle: 0,
      done: 0,
      error: 0,
    }

    for (const ref of this.sessionRefs) {
      switch (ref.status.state) {
        case 'working':
          counts.working++
          break
        case 'waiting':
          counts.waiting++
          break
        case 'idle':
        case 'initializing':
          counts.idle++
          break
        case 'done':
          counts.done++
          break
        case 'error':
          counts.error++
          break
      }
    }

    const waitingIdx = this.sessionRefs.findIndex((r) => r.status.state === 'waiting')
    const hasWaiting = waitingIdx >= 0

    let content = ` {bold}${this.sessionRefs.length}{/bold} sessions: `
    if (counts.working > 0) content += `{green-fg}${counts.working} working{/green-fg} `
    if (counts.waiting > 0) content += `{yellow-fg}${counts.waiting} waiting{/yellow-fg} `
    if (counts.idle > 0) content += `${counts.idle} idle `
    if (counts.done > 0) content += `{cyan-fg}${counts.done} done{/cyan-fg} `
    if (counts.error > 0) content += `{red-fg}${counts.error} error{/red-fg} `

    content += '\n {gray-fg}[1-9]{/gray-fg} Focus  '
    if (hasWaiting) content += `{yellow-fg}[y/n]{/yellow-fg} Reply [${waitingIdx + 1}]  `
    content += '{gray-fg}[r]{/gray-fg} Refresh  {gray-fg}[q]{/gray-fg} Quit'

    this.statusBar.setContent(content)
  }

  private highlightSession(index: number): void {
    // Update panel borders to highlight selected
    this.sessionPanels.forEach((panel, i) => {
      const ref = this.sessionRefs[i]
      if (!ref) return
      const baseColor = BLESSED_COLORS[ref.status.state]
      panel.style.border = {
        fg: i === index ? 'white' : baseColor,
      }
    })
  }

  private focusSession(index: number): void {
    if (index < 0 || index >= this.sessionRefs.length) return

    const ref = this.sessionRefs[index]
    const tmux = new TmuxRenderer({ sessionName: ref.tmuxSession })

    try {
      tmux.focusPaneByIndex(ref.paneIndex)
      this.stop()
      setTimeout(() => tmux.attach(), 100)
    } catch {
      // Pane might not exist
    }
  }

  private replyToWaiting(response: string): void {
    const waiting = this.sessionRefs.find((r) => r.status.state === 'waiting')
    if (!waiting) return

    const tmux = new TmuxRenderer({ sessionName: waiting.tmuxSession })
    try {
      tmux.sendInput(waiting.sessionId, response)
    } catch {
      // Ignore errors
    }
  }

  private startRefreshLoop(): void {
    this.refreshTimer = setInterval(() => {
      this.refresh()
    }, this.config.refreshInterval)
  }

  private formatRelativeTime(date: Date): string {
    const now = Date.now()
    const elapsed = now - date.getTime()

    if (elapsed < 1000) return 'now'
    if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s ago`
    if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`
    return `${Math.floor(elapsed / 3600000)}h ago`
  }
}

export async function runBlessedDashboard(config?: Partial<BlessedDashboardConfig>): Promise<void> {
  const dashboard = new BlessedDashboard(config)
  await dashboard.start()
}
