/**
 * Dashboard - Interactive TUI for Orcha (Ink version)
 *
 * Provides a live-updating dashboard showing all session statuses
 * with keyboard controls for interaction.
 */

import React, { useState, useEffect } from 'react'
import { render, Box, Text, useInput, useApp } from 'ink'
import { StatusMonitor, getStatusDirForInstance } from '../core/status-monitor.js'
import { loadSessionStore } from '../core/session-store.js'
import { listInstances } from '../core/instance-registry.js'
import type { SessionMetadata } from '../core/session-store.js'
import { TmuxRenderer } from './tmux-renderer.js'
import type { SessionStatus, SessionState, InstanceInfo } from '../core/types.js'
import { STATE_ICONS } from '../core/types.js'

// Color mapping for states
const STATE_COLORS: Record<SessionState, string> = {
  initializing: 'gray',
  idle: 'white',
  working: 'green',
  waiting: 'yellow',
  done: 'cyan',
  error: 'red',
}

// Instance data with its sessions
interface InstanceData {
  instance: InstanceInfo
  statuses: Map<string, SessionStatus>
  metadata: SessionMetadata[]
}

interface SessionRowProps {
  globalIndex: number
  displayId: number
  status: SessionStatus
  metadata?: SessionMetadata
  repoName: string
  showRepo: boolean
}

function SessionRow({ globalIndex, displayId, status, metadata, repoName, showRepo }: SessionRowProps) {
  const icon = STATE_ICONS[status.state]
  const color = STATE_COLORS[status.state]
  // Show branch name if available, otherwise session number
  const label = metadata?.branch
    ? metadata.branch.replace(/^orcha\//, '').slice(0, 18)
    : `session-${displayId}`
  const activity = formatRelativeTime(status.lastActivity)

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={color}
      paddingX={1}
      marginBottom={1}
    >
      <Box>
        <Text bold color="cyan">[{globalIndex}]</Text>
        {showRepo && <Text color="magenta"> {repoName.slice(0, 12)}</Text>}
        <Text> #{displayId} {label}  </Text>
        <Text color={color}>{icon} {status.state.toUpperCase()}</Text>
      </Box>
      <Text dimColor>"{status.message}" - {activity}</Text>
      {status.state === 'waiting' && status.needsInput && (
        <Text color="yellow" bold>
          {'\u26A0\uFE0F'}  NEEDS INPUT: {status.needsInput}
        </Text>
      )}
    </Box>
  )
}

interface GlobalSummaryProps {
  instances: InstanceData[]
}

function GlobalSummary({ instances }: GlobalSummaryProps) {
  let totalSessions = 0
  let working = 0, waiting = 0, idle = 0, done = 0, error = 0

  for (const inst of instances) {
    for (const status of inst.statuses.values()) {
      totalSessions++
      switch (status.state) {
        case 'working': working++; break
        case 'waiting': waiting++; break
        case 'idle':
        case 'initializing': idle++; break
        case 'done': done++; break
        case 'error': error++; break
      }
    }
  }

  return (
    <Box marginTop={1}>
      <Text bold>{instances.length} instance(s), {totalSessions} session(s): </Text>
      {working > 0 && <Text color="green">{working} working </Text>}
      {waiting > 0 && <Text color="yellow">{waiting} waiting </Text>}
      {idle > 0 && <Text>{idle} idle </Text>}
      {done > 0 && <Text color="cyan">{done} done </Text>}
      {error > 0 && <Text color="red">{error} error</Text>}
    </Box>
  )
}

interface ControlsProps {
  hasWaiting: boolean
  waitingIdx: number
  sessionCount: number
}

function Controls({ hasWaiting, waitingIdx, sessionCount }: ControlsProps) {
  return (
    <Box
      borderStyle="single"
      borderColor="gray"
      paddingX={1}
      marginTop={1}
    >
      {sessionCount > 0 && <Text dimColor>[1-9] Focus  </Text>}
      {hasWaiting && <Text color="yellow">[y/n] Reply to [{waitingIdx}]  </Text>}
      <Text dimColor>[r] Refresh  </Text>
      <Text dimColor>[q] Quit</Text>
    </Box>
  )
}

// Map global index to instance + pane index
interface SessionRef {
  instanceId: string
  tmuxSession: string
  paneIndex: number
  sessionId: string
}

interface DashboardAppProps {
  singleInstance?: InstanceInfo  // If set, only show this instance
}

function DashboardApp({ singleInstance }: DashboardAppProps) {
  const { exit } = useApp()
  const [instancesData, setInstancesData] = useState<InstanceData[]>([])
  const [sessionRefs, setSessionRefs] = useState<SessionRef[]>([])
  const [waitingRef, setWaitingRef] = useState<SessionRef | null>(null)

  // Refresh all instances
  const refresh = async () => {
    const instances = singleInstance ? [singleInstance] : await listInstances()
    const data: InstanceData[] = []
    const refs: SessionRef[] = []
    let firstWaiting: SessionRef | null = null

    for (const inst of instances) {
      const statusDir = getStatusDirForInstance(inst.instanceId)
      const monitor = new StatusMonitor({ statusDir })
      await monitor.start()
      const statuses = monitor.getAllStatuses()
      await monitor.stop()

      const metadata = await loadSessionStore(inst.instanceId)

      data.push({ instance: inst, statuses, metadata })

      // Build session refs for focus
      let paneIdx = 0
      for (const [sessionId, status] of statuses) {
        refs.push({
          instanceId: inst.instanceId,
          tmuxSession: inst.tmuxSession,
          paneIndex: paneIdx,
          sessionId,
        })
        if (status.state === 'waiting' && !firstWaiting) {
          firstWaiting = refs[refs.length - 1]
        }
        paneIdx++
      }
    }

    setInstancesData(data)
    setSessionRefs(refs)
    if (firstWaiting) {
      setWaitingRef(firstWaiting)
    }
  }

  useEffect(() => {
    // Clear terminal and set title
    process.stdout.write('\x1b[2J\x1b[H')  // Clear screen and move cursor to top
    process.stdout.write('\x1b]0;Orcha Dashboard\x07')  // Set title

    refresh()
    const interval = setInterval(refresh, 2000)
    return () => clearInterval(interval)
  }, [singleInstance])

  // Find waiting session
  let hasWaiting = false
  let waitingIdx = 0
  if (waitingRef) {
    hasWaiting = true
    waitingIdx = sessionRefs.findIndex(r => r.sessionId === waitingRef.sessionId) + 1
  }

  // Handle keyboard input
  useInput((input, key) => {
    if (input === 'q' || input === 'Q') {
      // Reset terminal title
      process.stdout.write('\x1b]0;\x07')
      exit()
      return
    }

    if (input === 'r' || input === 'R') {
      refresh()
      return
    }

    // Number keys to focus (1-9)
    if (input >= '1' && input <= '9') {
      const idx = parseInt(input, 10) - 1
      if (idx < sessionRefs.length) {
        const ref = sessionRefs[idx]
        const tmux = new TmuxRenderer({ sessionName: ref.tmuxSession })
        try {
          tmux.focusPaneByIndex(ref.paneIndex)
          process.stdout.write('\x1b]0;\x07')  // Reset title
          exit()
          setTimeout(() => tmux.attach(), 100)
        } catch {
          // Pane might not exist
        }
      }
      return
    }

    // y/n for waiting session
    if (waitingRef && (input === 'y' || input === 'Y')) {
      const tmux = new TmuxRenderer({ sessionName: waitingRef.tmuxSession })
      try {
        tmux.sendInput(waitingRef.sessionId, 'y')
      } catch {}
      setWaitingRef(null)
      return
    }
    if (waitingRef && (input === 'n' || input === 'N')) {
      const tmux = new TmuxRenderer({ sessionName: waitingRef.tmuxSession })
      try {
        tmux.sendInput(waitingRef.sessionId, 'n')
      } catch {}
      setWaitingRef(null)
      return
    }
  })

  const showRepo = !singleInstance && instancesData.length > 1
  let globalIdx = 1
  let totalSessions = 0
  for (const inst of instancesData) {
    totalSessions += inst.statuses.size
  }

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box
        borderStyle="double"
        borderColor="cyan"
        justifyContent="center"
        paddingX={2}
        marginBottom={1}
      >
        <Text bold color="cyan"> ORCHA DASHBOARD </Text>
        {singleInstance && <Text color="magenta"> - {singleInstance.instanceId.replace('orcha-', '')}</Text>}
      </Box>

      {/* Sessions */}
      {totalSessions === 0 ? (
        <Box flexDirection="column" padding={2}>
          <Text dimColor>No active sessions.</Text>
          <Text> </Text>
          <Text>Start sessions with: orcha start -n {'<count>'} -r {'<repo>'}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {instancesData.map((instData) => {
            const repoName = instData.instance.instanceId.replace('orcha-', '')
            return Array.from(instData.statuses.entries()).map(([sessionId, status]) => {
              const sessionMeta = instData.metadata.find((m) => m.id === sessionId)
              const currentIdx = globalIdx++
              return (
                <SessionRow
                  key={`${instData.instance.instanceId}-${sessionId}`}
                  globalIndex={currentIdx}
                  displayId={sessionMeta?.displayId ?? currentIdx}
                  status={status}
                  metadata={sessionMeta}
                  repoName={repoName}
                  showRepo={showRepo}
                />
              )
            })
          })}
          <GlobalSummary instances={instancesData} />
        </Box>
      )}

      {/* Controls */}
      <Controls
        hasWaiting={hasWaiting}
        waitingIdx={waitingIdx}
        sessionCount={totalSessions}
      />
    </Box>
  )
}

function formatRelativeTime(date: Date): string {
  const now = Date.now()
  const elapsed = now - date.getTime()

  if (elapsed < 1000) return 'now'
  if (elapsed < 60000) return `${Math.floor(elapsed / 1000)}s ago`
  if (elapsed < 3600000) return `${Math.floor(elapsed / 60000)}m ago`
  return `${Math.floor(elapsed / 3600000)}h ago`
}

export interface DashboardConfig {
  refreshInterval: number
  singleInstance?: InstanceInfo  // If set, only show this instance
}

const DEFAULT_CONFIG: DashboardConfig = {
  refreshInterval: 2000,
  singleInstance: undefined,
}

/**
 * Run the dashboard (for CLI integration)
 */
export async function runDashboard(config?: Partial<DashboardConfig>): Promise<void> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  const { waitUntilExit } = render(
    <DashboardApp singleInstance={cfg.singleInstance} />
  )

  await waitUntilExit()
}

// Legacy class export for backwards compatibility
export class Dashboard {
  private config: DashboardConfig

  constructor(config: Partial<DashboardConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async start(): Promise<void> {
    await runDashboard(this.config)
  }

  async stop(): Promise<void> {
    // Ink handles cleanup automatically
  }
}
