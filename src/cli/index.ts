#!/usr/bin/env node
/**
 * Orcha CLI - Main entry point
 *
 * Commands:
 *   start   - Start N sessions in tmux
 *   stop    - Stop all sessions
 *   status  - Show status of all sessions
 *   kill    - Kill a specific session
 *   send    - Send input to a session
 *   focus   - Focus on a session pane
 *   demo    - Run demo with mock sessions
 *   mcp     - Start MCP server
 */

import { Command } from 'commander'
import { resolve } from 'path'
import {
  SessionManager,
  StatusMonitor,
  ConfigLoader,
  getStatusDirForInstance,
  registerInstance,
  unregisterInstance,
  findInstanceFromCwd,
  listInstances,
  cleanupStaleInstances,
  generateInstanceId,
  saveSessionStore,
  loadSessionStore,
} from '../core/index.js'
import type { SessionMetadata } from '../core/index.js'
import type { InstanceInfo } from '../core/index.js'
import { formatStatus } from './format.js'
import { TmuxRenderer } from './tmux-renderer.js'
import { startMcpServer } from '../mcp/index.js'
import { runDashboard } from './dashboard.js'
import { StatusBar } from './status-bar.js'
import { WorktreeManager } from '../core/worktree-manager.js'

const program = new Command()

// State file for persisting session info across CLI invocations
const ORCHA_STATE_FILE = '/tmp/orcha/state.json'

/**
 * Helper to get the current instance from cwd or require explicit specification
 */
async function getCurrentInstance(): Promise<InstanceInfo | null> {
  // Clean up stale instances first
  await cleanupStaleInstances()

  // Try to find instance from current directory
  return findInstanceFromCwd()
}

/**
 * Helper to get instance-specific tmux session name
 */
function getSessionName(repoPath: string): string {
  return generateInstanceId(repoPath)
}

/**
 * Generate an auto-branch name for a session
 */
function generateAutoBranch(sessionIndex: number): string {
  const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  return `orcha/session-${sessionIndex + 1}-${timestamp}`
}

program
  .name('orcha')
  .description('Parallel AI session orchestrator')
  .version('0.1.0')

// =============================================================================
// orcha start
// =============================================================================
program
  .command('start')
  .description('Start N AI sessions in tmux')
  .requiredOption('-n, --count <number>', 'Number of sessions to start', parseInt)
  .option('-r, --repo <path>', 'Repository path (default: current directory)')
  .option('-b, --branches <branches>', 'Comma-separated branch names')
  .option('-m, --mode <mode>', 'AI mode: claude, gemini, codex, shell', 'claude')
  .option('--no-worktree', 'Disable automatic worktree creation')
  .option('--no-attach', 'Do not attach to tmux session after starting')
  .action(async (options) => {
    const { count, repo, branches, mode, attach, worktree } = options

    // Validate inputs
    if (count < 1 || count > 12) {
      console.error('Error: Session count must be between 1 and 12')
      process.exit(1)
    }

    // Default to current directory if not specified
    const repoPath = resolve(repo || '.')
    const useWorktrees = worktree !== false // default true

    // Check if tmux is available
    if (!TmuxRenderer.isAvailable()) {
      console.error('Error: tmux is not installed or not in PATH')
      console.error('Install with: apt install tmux (Linux) or brew install tmux (macOS)')
      process.exit(1)
    }

    // Parse branches if provided
    const branchList = branches ? branches.split(',').map((b: string) => b.trim()) : []

    // Generate instance-specific session name
    const instanceId = getSessionName(repoPath)

    console.log(`Starting ${count} session(s) in ${repoPath}...`)
    console.log(`Instance: ${instanceId}`)
    if (useWorktrees) {
      console.log(`Worktrees: enabled (use --no-worktree to disable)`)
    }

    // Create tmux renderer with instance-specific name
    const tmux = new TmuxRenderer({ sessionName: instanceId })

    // Kill existing session for THIS repo if it exists
    if (tmux.sessionExists()) {
      console.log(`Stopping existing ${instanceId} session...`)
      await unregisterInstance(instanceId)
      tmux.killSession()
    }

    // Create session manager with instance-specific status directory
    const statusDir = getStatusDirForInstance(instanceId)
    const manager = new SessionManager({ repoPath, statusDir })
    await manager.start()

    // Create tmux session
    tmux.createSession()

    // Create sessions
    const sessions = []
    for (let i = 0; i < count; i++) {
      // Determine branch: explicit > auto-generated > none
      let branch: string | undefined
      if (branchList[i]) {
        branch = branchList[i]
      } else if (useWorktrees) {
        branch = generateAutoBranch(i)
      }

      const branchDisplay = branch || `session-${i + 1} (no worktree)`

      console.log(`  Creating #${i + 1}: ${branchDisplay}...`)

      try {
        // Create session first (this creates the worktree if branch specified)
        const session = await manager.createSession({
          branch,
          mode: mode as 'claude' | 'gemini' | 'codex' | 'shell',
          workingDirectory: repoPath,
          repoPath,
        })

        sessions.push(session)

        // Use worktree path if available, otherwise repo path
        const workDir = session.worktreePath || repoPath

        // Create tmux pane at the correct working directory
        tmux.createPane(`session-${i}`, workDir)

        // Run the AI command in the tmux pane
        const cmd = mode === 'shell' ? '' : mode
        if (cmd) {
          tmux.runInPane(`session-${i}`, cmd)
        }

        if (session.worktreePath) {
          console.log(`    Worktree: ${session.worktreePath}`)
        }
      } catch (err) {
        console.error(`  Error creating session ${i + 1}:`, (err as Error).message)
      }
    }

    console.log(`\nStarted ${sessions.length} session(s)`)

    // Save session metadata for status display
    const sessionMetadata: SessionMetadata[] = sessions.map((s, idx) => ({
      id: s.id,
      displayId: s.displayId,
      branch: s.branch,
      mode: s.mode,
      worktreePath: s.worktreePath,
      createdAt: s.createdAt.toISOString(),
    }))
    await saveSessionStore(instanceId, sessionMetadata)

    // Register instance in registry
    await registerInstance(repoPath, sessions.length)

    // Start status bar updates - use manager's monitor (already started)
    const statusBar = new StatusBar({ sessionName: instanceId })
    await statusBar.start(manager.status)

    console.log('\nCommands:')
    console.log('  orcha status      - View session status')
    console.log('  orcha list        - List all running instances')
    console.log('  orcha watch       - Interactive dashboard')
    console.log('  orcha focus <n>   - Focus on session #n')
    console.log('  orcha send <n> "text" - Send input to session #n')
    console.log('  orcha kill <n>    - Kill session #n')
    console.log('  orcha stop        - Stop this instance')
    console.log('  orcha stop --all  - Stop all instances')

    if (attach) {
      console.log('\nAttaching to tmux session...')
      tmux.attach()
    } else {
      console.log(`\nTo attach to tmux session: tmux attach -t ${instanceId}`)
    }
  })

// =============================================================================
// orcha stop
// =============================================================================
program
  .command('stop')
  .description('Stop sessions for current repo (or all with --all)')
  .option('--all', 'Stop all running orcha instances')
  .option('-i, --instance <id>', 'Stop specific instance by ID')
  .action(async (options) => {
    const { all, instance: instanceId } = options

    if (all) {
      // Stop all instances
      const instances = await listInstances()
      if (instances.length === 0) {
        console.log('No orcha instances running.')
        return
      }

      console.log(`Stopping ${instances.length} instance(s)...`)
      for (const inst of instances) {
        const tmux = new TmuxRenderer({ sessionName: inst.tmuxSession })
        if (tmux.sessionExists()) {
          tmux.killSession()
        }
        await unregisterInstance(inst.instanceId)
        console.log(`  Stopped ${inst.instanceId} (${inst.repoPath})`)
      }
      console.log('All instances stopped.')
      return
    }

    // Find instance to stop
    let targetInstance: InstanceInfo | null = null

    if (instanceId) {
      // Stop specific instance
      const instances = await listInstances()
      targetInstance = instances.find((i) => i.instanceId === instanceId) || null
    } else {
      // Auto-detect from cwd
      targetInstance = await getCurrentInstance()
    }

    if (!targetInstance) {
      if (instanceId) {
        console.log(`Instance not found: ${instanceId}`)
      } else {
        console.log('No orcha instance found for current directory.')
        console.log('Use --all to stop all instances, or -i <id> to stop a specific one.')
        console.log('Run "orcha list" to see running instances.')
      }
      return
    }

    const tmux = new TmuxRenderer({ sessionName: targetInstance.tmuxSession })

    if (!tmux.sessionExists()) {
      console.log(`Tmux session not found: ${targetInstance.tmuxSession}`)
      await unregisterInstance(targetInstance.instanceId)
      return
    }

    console.log(`Stopping ${targetInstance.instanceId}...`)

    // Kill the tmux session (this kills all processes in it)
    tmux.killSession()

    // Cleanup status files
    const statusDir = getStatusDirForInstance(targetInstance.instanceId)
    const monitor = new StatusMonitor({ statusDir })
    await monitor.start()
    const statuses = monitor.getAllStatuses()
    await monitor.stop()

    // Unregister from registry
    await unregisterInstance(targetInstance.instanceId)

    console.log(`Stopped ${statuses.size} session(s) in ${targetInstance.instanceId}.`)
  })

// =============================================================================
// orcha status
// =============================================================================
program
  .command('status')
  .description('Show status of all sessions')
  .option('-w, --watch', 'Watch for changes')
  .option('-i, --instance <id>', 'Show status for specific instance')
  .action(async (options) => {
    const { instance: instanceId } = options

    // Find which instance to show status for
    let targetInstance: InstanceInfo | null = null

    if (instanceId) {
      const instances = await listInstances()
      targetInstance = instances.find((i) => i.instanceId === instanceId) || null
      if (!targetInstance) {
        console.log(`Instance not found: ${instanceId}`)
        console.log('Run "orcha list" to see running instances.')
        return
      }
    } else {
      targetInstance = await getCurrentInstance()
    }

    // Get status dir for this instance
    const statusDir = targetInstance
      ? getStatusDirForInstance(targetInstance.instanceId)
      : getStatusDirForInstance()

    const monitor = new StatusMonitor({ statusDir })

    // Suppress internal events
    monitor.on('error', () => {})
    monitor.on('needs-input', () => {})
    monitor.on('done', () => {})

    await monitor.start()

    const statuses = monitor.getAllStatuses()

    if (statuses.size === 0) {
      if (targetInstance) {
        console.log(`No active sessions in ${targetInstance.instanceId}.`)
      } else {
        console.log('No active sessions.')
        console.log('\nStart sessions with: orcha start -n <count> -r <repo>')
      }
      await monitor.stop()
      return
    }

    // Load session metadata for display
    const metadata = targetInstance
      ? await loadSessionStore(targetInstance.instanceId)
      : []

    // Use tmux pane detection as fallback when status files show "idle"
    if (targetInstance) {
      const tmux = new TmuxRenderer({ sessionName: targetInstance.tmuxSession })
      if (tmux.sessionExists()) {
        const panes = tmux.listPanes()
        let paneIdx = 0
        for (const [sessionId, status] of statuses) {
          // Only override if status file shows idle/initializing
          if (status.state === 'idle' || status.state === 'initializing') {
            const detected = tmux.detectClaudeStatus(paneIdx)
            if (detected && detected.state !== 'idle') {
              // Update the status in place
              status.state = detected.state as any
              status.message = detected.message
              status.lastActivity = new Date()
            }
          }
          paneIdx++
        }
      }
    }

    if (targetInstance) {
      console.log(`Instance: ${targetInstance.instanceId} (${targetInstance.repoPath})\n`)
    }

    console.log(formatStatus(statuses, metadata))

    if (options.watch) {
      // Poll tmux panes periodically for real-time status
      const refreshDisplay = () => {
        const currentStatuses = monitor.getAllStatuses()

        // Apply tmux detection
        if (targetInstance) {
          const tmux = new TmuxRenderer({ sessionName: targetInstance.tmuxSession })
          if (tmux.sessionExists()) {
            let paneIdx = 0
            for (const [sessionId, status] of currentStatuses) {
              const detected = tmux.detectClaudeStatus(paneIdx)
              if (detected) {
                status.state = detected.state as any
                status.message = detected.message
                status.lastActivity = new Date()
              }
              paneIdx++
            }
          }
        }

        console.clear()
        if (targetInstance) {
          console.log(`Instance: ${targetInstance.instanceId} (${targetInstance.repoPath})\n`)
        }
        console.log(formatStatus(currentStatuses, metadata))
        console.log('\nWatching for changes... (Ctrl+C to exit)')
      }

      // Initial display
      refreshDisplay()

      // Poll every 2 seconds
      setInterval(refreshDisplay, 2000)
    } else {
      await monitor.stop()
    }
  })

// =============================================================================
// orcha kill
// =============================================================================
program
  .command('kill <n>')
  .description('Kill session #n')
  .option('-i, --instance <id>', 'Target specific instance')
  .action(async (n, options) => {
    const displayId = parseInt(n, 10)
    if (isNaN(displayId) || displayId < 1) {
      console.error('Error: Invalid session number')
      process.exit(1)
    }

    // Find target instance
    let targetInstance: InstanceInfo | null = null
    if (options.instance) {
      const instances = await listInstances()
      targetInstance = instances.find((i) => i.instanceId === options.instance) || null
    } else {
      targetInstance = await getCurrentInstance()
    }

    if (!targetInstance) {
      console.log('No orcha instance found. Use -i <id> to specify.')
      return
    }

    const tmux = new TmuxRenderer({ sessionName: targetInstance.tmuxSession })

    if (!tmux.sessionExists()) {
      console.log(`No tmux session: ${targetInstance.tmuxSession}`)
      return
    }

    // Find session by display ID from status files
    const statusDir = getStatusDirForInstance(targetInstance.instanceId)
    const monitor = new StatusMonitor({ statusDir })
    await monitor.start()
    const statuses = monitor.getAllStatuses()

    let targetSessionId: string | null = null
    let idx = 1
    for (const sessionId of statuses.keys()) {
      if (idx === displayId) {
        targetSessionId = sessionId
        break
      }
      idx++
    }

    await monitor.stop()

    if (!targetSessionId) {
      console.error(`Error: Session #${displayId} not found`)
      process.exit(1)
    }

    // Kill the pane
    try {
      tmux.killPane(targetSessionId)
      console.log(`Killed session #${displayId}`)
    } catch (err) {
      console.error(`Error killing session:`, (err as Error).message)
    }
  })

// =============================================================================
// orcha send
// =============================================================================
program
  .command('send <n> <input>')
  .description('Send input to session #n')
  .option('-i, --instance <id>', 'Target specific instance')
  .action(async (n, input, options) => {
    const displayId = parseInt(n, 10)
    if (isNaN(displayId) || displayId < 1) {
      console.error('Error: Invalid session number')
      process.exit(1)
    }

    // Find target instance
    let targetInstance: InstanceInfo | null = null
    if (options.instance) {
      const instances = await listInstances()
      targetInstance = instances.find((i) => i.instanceId === options.instance) || null
    } else {
      targetInstance = await getCurrentInstance()
    }

    if (!targetInstance) {
      console.log('No orcha instance found. Use -i <id> to specify.')
      return
    }

    const tmux = new TmuxRenderer({ sessionName: targetInstance.tmuxSession })

    if (!tmux.sessionExists()) {
      console.log(`No tmux session: ${targetInstance.tmuxSession}`)
      return
    }

    // Find session by display ID
    const statusDir = getStatusDirForInstance(targetInstance.instanceId)
    const monitor = new StatusMonitor({ statusDir })
    await monitor.start()
    const statuses = monitor.getAllStatuses()

    let targetSessionId: string | null = null
    let idx = 1
    for (const sessionId of statuses.keys()) {
      if (idx === displayId) {
        targetSessionId = sessionId
        break
      }
      idx++
    }

    await monitor.stop()

    if (!targetSessionId) {
      console.error(`Error: Session #${displayId} not found`)
      process.exit(1)
    }

    try {
      tmux.sendInput(targetSessionId, input)
      console.log(`Sent to session #${displayId}: ${input}`)
    } catch (err) {
      console.error(`Error sending input:`, (err as Error).message)
    }
  })

// =============================================================================
// orcha focus
// =============================================================================
program
  .command('focus <n>')
  .description('Focus on session #n in tmux')
  .option('-i, --instance <id>', 'Target specific instance')
  .action(async (n, options) => {
    const displayId = parseInt(n, 10)
    if (isNaN(displayId) || displayId < 1) {
      console.error('Error: Invalid session number')
      process.exit(1)
    }

    // Find target instance
    let targetInstance: InstanceInfo | null = null
    if (options.instance) {
      const instances = await listInstances()
      targetInstance = instances.find((i) => i.instanceId === options.instance) || null
    } else {
      targetInstance = await getCurrentInstance()
    }

    if (!targetInstance) {
      console.log('No orcha instance found. Use -i <id> to specify.')
      console.log('Start sessions with: orcha start -n <count> -r <repo>')
      return
    }

    const tmux = new TmuxRenderer({ sessionName: targetInstance.tmuxSession })

    if (!tmux.sessionExists()) {
      console.log(`No tmux session: ${targetInstance.tmuxSession}`)
      return
    }

    // Find session by display ID
    const statusDir = getStatusDirForInstance(targetInstance.instanceId)
    const monitor = new StatusMonitor({ statusDir })
    await monitor.start()
    const statuses = monitor.getAllStatuses()

    let targetSessionId: string | null = null
    let idx = 1
    for (const sessionId of statuses.keys()) {
      if (idx === displayId) {
        targetSessionId = sessionId
        break
      }
      idx++
    }

    await monitor.stop()

    if (!targetSessionId) {
      console.error(`Error: Session #${displayId} not found`)
      process.exit(1)
    }

    try {
      tmux.focusPane(targetSessionId)
      // Attach if not already in tmux
      if (!TmuxRenderer.isInsideTmux()) {
        tmux.attach()
      }
    } catch (err) {
      console.error(`Error focusing session:`, (err as Error).message)
    }
  })

// =============================================================================
// orcha list
// =============================================================================
program
  .command('list')
  .alias('ls')
  .description('List all running orcha instances')
  .action(async () => {
    // Clean up stale instances first
    const removed = await cleanupStaleInstances()
    if (removed.length > 0) {
      console.log(`Cleaned up ${removed.length} stale instance(s).\n`)
    }

    const instances = await listInstances()

    if (instances.length === 0) {
      console.log('No orcha instances running.')
      console.log('\nStart an instance with: orcha start -n <count> -r <repo>')
      return
    }

    // Table header
    console.log('INSTANCE'.padEnd(25) + 'REPO'.padEnd(40) + 'SESSIONS'.padEnd(10) + 'STARTED')
    console.log('-'.repeat(85))

    for (const inst of instances) {
      // Get session statuses to show active count
      const statusDir = getStatusDirForInstance(inst.instanceId)
      const monitor = new StatusMonitor({ statusDir })
      await monitor.start()
      const statuses = monitor.getAllStatuses()
      await monitor.stop()

      // Count working sessions
      let working = 0
      let waiting = 0
      for (const status of statuses.values()) {
        if (status.state === 'working') working++
        if (status.state === 'waiting') waiting++
      }

      const sessionInfo =
        statuses.size > 0 ? `${statuses.size} (${working}w/${waiting}i)` : `${inst.sessionCount}`

      // Format started time
      const startedAt = new Date(inst.startedAt)
      const started = formatRelativeTime(startedAt)

      // Shorten repo path for display
      const shortRepo =
        inst.repoPath.length > 38 ? '...' + inst.repoPath.slice(-35) : inst.repoPath

      console.log(
        inst.instanceId.padEnd(25) + shortRepo.padEnd(40) + sessionInfo.padEnd(10) + started
      )
    }

    console.log('\nCommands:')
    console.log('  orcha attach <instance>  - Attach to instance tmux session')
    console.log('  orcha stop -i <instance> - Stop specific instance')
    console.log('  orcha stop --all         - Stop all instances')
  })

/**
 * Format relative time like "5m ago", "2h ago"
 */
function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// =============================================================================
// orcha attach
// =============================================================================
program
  .command('attach [instance]')
  .description('Attach to an orcha tmux session')
  .action(async (instanceId?: string) => {
    let targetInstance: InstanceInfo | null = null

    if (instanceId) {
      // Find specific instance
      const instances = await listInstances()
      targetInstance = instances.find((i) => i.instanceId === instanceId) || null
      if (!targetInstance) {
        console.log(`Instance not found: ${instanceId}`)
        console.log('Run "orcha list" to see running instances.')
        return
      }
    } else {
      // Auto-detect from cwd
      targetInstance = await getCurrentInstance()
      if (!targetInstance) {
        // If no instance for cwd, list available ones
        const instances = await listInstances()
        if (instances.length === 0) {
          console.log('No orcha instances running.')
          console.log('Start an instance with: orcha start -n <count> -r <repo>')
          return
        }
        if (instances.length === 1) {
          targetInstance = instances[0]
        } else {
          console.log('Multiple instances running. Specify which one:')
          for (const inst of instances) {
            console.log(`  orcha attach ${inst.instanceId}`)
          }
          return
        }
      }
    }

    const tmux = new TmuxRenderer({ sessionName: targetInstance.tmuxSession })

    if (!tmux.sessionExists()) {
      console.log(`Tmux session not found: ${targetInstance.tmuxSession}`)
      await unregisterInstance(targetInstance.instanceId)
      return
    }

    console.log(`Attaching to ${targetInstance.instanceId}...`)
    tmux.attach()
  })

// =============================================================================
// orcha add
// =============================================================================
program
  .command('add')
  .description('Add a new session to existing orcha instance')
  .option('-b, --branch <branch>', 'Branch name for the new session')
  .option('-m, --mode <mode>', 'AI mode: claude, gemini, codex, shell', 'claude')
  .option('-i, --instance <id>', 'Target specific instance')
  .option('--no-worktree', 'Disable automatic worktree creation')
  .action(async (options) => {
    const { branch, mode, instance: instanceId, worktree } = options
    const useWorktree = worktree !== false

    // Find target instance
    let targetInstance: InstanceInfo | null = null
    if (instanceId) {
      const instances = await listInstances()
      targetInstance = instances.find((i) => i.instanceId === instanceId) || null
    } else {
      targetInstance = await getCurrentInstance()
    }

    if (!targetInstance) {
      console.log('No orcha instance found. Use -i <id> to specify.')
      console.log('Start sessions with: orcha start -n <count> -r <repo>')
      return
    }

    const tmux = new TmuxRenderer({ sessionName: targetInstance.tmuxSession })

    if (!tmux.sessionExists()) {
      console.log(`Tmux session not found: ${targetInstance.tmuxSession}`)
      return
    }

    // Create session manager for this repo with instance-specific status dir
    const statusDir = getStatusDirForInstance(targetInstance.instanceId)
    const manager = new SessionManager({ repoPath: targetInstance.repoPath, statusDir })
    await manager.start()

    // Find next session number - manager's monitor is already started
    const existingCount = manager.status.getAllStatuses().size
    const sessionIdx = existingCount

    // Determine branch: explicit > auto-generated > none
    let sessionBranch: string | undefined = branch
    if (!sessionBranch && useWorktree) {
      sessionBranch = generateAutoBranch(sessionIdx)
    }

    const branchDisplay = sessionBranch || `session-${sessionIdx + 1} (no worktree)`

    console.log(`Adding session #${sessionIdx + 1}: ${branchDisplay}...`)

    try {
      // Create session first (creates worktree if branch specified)
      const session = await manager.createSession({
        branch: sessionBranch,
        mode: (mode as 'claude' | 'gemini' | 'codex' | 'shell') || 'claude',
        workingDirectory: targetInstance.repoPath,
        repoPath: targetInstance.repoPath,
      })

      // Use worktree path if available
      const workDir = session.worktreePath || targetInstance.repoPath
      const sessionId = `session-${sessionIdx}`

      // Create tmux pane at correct location
      tmux.createPane(sessionId, workDir)

      // Run the AI command in the tmux pane
      const cmd = mode === 'shell' ? '' : mode || 'claude'
      if (cmd) {
        tmux.runInPane(sessionId, cmd)
      }

      // Update session metadata store
      const existingMetadata = await loadSessionStore(targetInstance.instanceId)
      existingMetadata.push({
        id: session.id,
        displayId: session.displayId,
        branch: session.branch,
        mode: session.mode,
        worktreePath: session.worktreePath,
        createdAt: session.createdAt.toISOString(),
      })
      await saveSessionStore(targetInstance.instanceId, existingMetadata)

      console.log(`Added session #${sessionIdx + 1}`)
      if (session.worktreePath) {
        console.log(`  Worktree: ${session.worktreePath}`)
      }
    } catch (err) {
      console.error(`Error adding session:`, (err as Error).message)
    }
  })

// =============================================================================
// orcha demo
// =============================================================================
program
  .command('demo')
  .description('Run demo with mock sessions')
  .action(async () => {
    const monitor = new StatusMonitor()

    monitor.on('status-change', () => {})
    monitor.on('needs-input', (id, prompt) => {
      console.log(`\n  Session ${id} needs input: ${prompt}`)
    })
    monitor.on('error', (id, msg) => {
      console.log(`\n  Session ${id} error: ${msg}`)
    })
    monitor.on('done', (id) => {
      console.log(`\n  Session ${id} completed`)
    })

    await monitor.start()

    // Register mock sessions
    const sessions = [
      { id: 'session-1', branch: 'feature/auth', state: 'working' as const, message: 'Implementing OAuth2 flow' },
      { id: 'session-2', branch: 'feature/api', state: 'waiting' as const, message: 'Delete 47 files?', needsInput: 'Delete files? (y/n)' },
      { id: 'session-3', branch: 'feature/ui', state: 'idle' as const, message: 'Ready for instructions' },
      { id: 'session-4', branch: 'fix/login-bug', state: 'done' as const, message: 'Task complete' },
      { id: 'session-5', branch: 'feature/tests', state: 'error' as const, message: 'Build failed: missing dependency' },
    ]

    for (const s of sessions) {
      monitor.registerSession(s.id)
      await monitor.updateStatus(s.id, {
        state: s.state,
        message: s.message,
        needsInput: s.needsInput,
      })
      const status = monitor.getStatus(s.id)!
      await monitor.writeStatusFile(s.id, status)
    }

    console.log(formatStatus(monitor.getAllStatuses()))

    monitor.on('status-change', () => {
      console.clear()
      console.log(formatStatus(monitor.getAllStatuses()))
    })

    console.log('\nDemo running. Edit files in /tmp/orcha/agents/ to see changes.')
    console.log('Press Ctrl+C to exit.')
  })

// =============================================================================
// orcha watch (dashboard)
// =============================================================================
program
  .command('watch')
  .alias('dashboard')
  .description('Launch interactive TUI dashboard')
  .action(async () => {
    await runDashboard()
  })

// =============================================================================
// orcha mcp
// =============================================================================
program
  .command('mcp')
  .description('Start the MCP server (for AI agent status reporting)')
  .action(async () => {
    await startMcpServer()
  })

// =============================================================================
// orcha mcp-config
// =============================================================================
program
  .command('mcp-config')
  .description('Output MCP server configuration for claude_desktop_config.json')
  .action(() => {
    const config = {
      mcpServers: {
        orcha: {
          command: 'orcha-mcp',
          args: [],
        },
      },
    }
    console.log(JSON.stringify(config, null, 2))
    console.log('\nAdd the "orcha" entry to your claude_desktop_config.json mcpServers section.')
  })

// =============================================================================
// orcha cleanup
// =============================================================================
program
  .command('cleanup')
  .description('Remove orphaned worktrees and clean up temp files')
  .option('-r, --repo <path>', 'Repository path (default: current directory)')
  .option('--dry-run', 'Show what would be cleaned without removing')
  .action(async (options) => {
    const { repo, dryRun } = options

    // Default to current directory
    const repoPath = resolve(repo || '.')
    console.log(`Cleaning up orphaned resources for ${repoPath}...`)

    const worktrees = new WorktreeManager(repoPath)

    // Get all managed worktrees
    const managed = await worktrees.listManaged()

    if (managed.length === 0) {
      console.log('No orcha-managed worktrees found.')
      return
    }

    console.log(`Found ${managed.length} orcha-managed worktree(s):`)
    for (const wt of managed) {
      console.log(`  - ${wt.sessionId}: ${wt.branch} (${wt.path})`)
    }

    if (dryRun) {
      console.log('\n[Dry run] Would remove all above worktrees.')
      return
    }

    // Remove all managed worktrees (they're orphaned since no session is running)
    const removed = await worktrees.cleanup([])

    if (removed.length > 0) {
      console.log(`\nRemoved ${removed.length} orphaned worktree(s):`)
      for (const id of removed) {
        console.log(`  - ${id}`)
      }
    }

    // Prune git worktree references
    await worktrees.prune()
    console.log('Pruned stale git worktree references.')

    // Clean up status files
    const monitor = new StatusMonitor()
    await monitor.start()
    const statuses = monitor.getAllStatuses()
    await monitor.stop()

    console.log(`\nCleanup complete.`)
    if (statuses.size > 0) {
      console.log(`Note: ${statuses.size} status file(s) found in /tmp/orcha/agents/`)
    }
  })

// =============================================================================
// orcha preset (parent command)
// =============================================================================
const presetCmd = program
  .command('preset')
  .description('Manage session presets')

// orcha preset save
presetCmd
  .command('save <name>')
  .description('Save current configuration as a preset')
  .option('-r, --repo <path>', 'Repository path (default: current directory)')
  .option('-n, --count <number>', 'Number of sessions', parseInt)
  .option('-b, --branches <branches>', 'Comma-separated branch names')
  .option('-m, --mode <mode>', 'AI mode for all sessions', 'claude')
  .option('-d, --description <text>', 'Preset description')
  .action(async (name, options) => {
    const { repo, count, branches, mode, description } = options

    // Default to current directory
    const repoPath = resolve(repo || '.')
    const configLoader = new ConfigLoader()

    // Build sessions array
    const branchList = branches ? branches.split(',').map((b: string) => b.trim()) : []
    const sessionCount = count || branchList.length || 3

    const sessions = []
    for (let i = 0; i < sessionCount; i++) {
      sessions.push({
        branch: branchList[i] || undefined,
        mode: mode as 'claude' | 'gemini' | 'codex' | 'shell',
      })
    }

    const preset = configLoader.createPresetFromSessions(name, sessions, repoPath, description)

    try {
      const filePath = await configLoader.savePreset(preset)
      console.log(`Preset saved: ${name}`)
      console.log(`  File: ${filePath}`)
      console.log(`  Sessions: ${sessions.length}`)
      console.log(`  Repo: ${repoPath}`)
    } catch (err) {
      console.error('Error saving preset:', (err as Error).message)
      process.exit(1)
    }
  })

// orcha preset list
presetCmd
  .command('list')
  .description('List all saved presets')
  .action(async () => {
    const configLoader = new ConfigLoader()

    try {
      const presets = await configLoader.listPresets()

      if (presets.length === 0) {
        console.log('No presets saved.')
        console.log('\nSave a preset with: orcha preset save <name> -r <repo>')
        return
      }

      console.log('Saved presets:\n')
      for (const preset of presets) {
        console.log(`  ${preset.name}`)
        if (preset.description) {
          console.log(`    ${preset.description}`)
        }
        console.log(`    Sessions: ${preset.sessionCount}, Repo: ${preset.repoPath}`)
        console.log()
      }
    } catch (err) {
      console.error('Error listing presets:', (err as Error).message)
      process.exit(1)
    }
  })

// orcha preset load
presetCmd
  .command('load <name>')
  .description('Load and start a preset')
  .option('--no-attach', 'Do not attach to tmux session after starting')
  .option('--no-worktree', 'Disable automatic worktree creation')
  .action(async (name, options) => {
    const { attach, worktree } = options
    const useWorktrees = worktree !== false
    const configLoader = new ConfigLoader()

    try {
      const preset = await configLoader.loadPreset(name)

      console.log(`Loading preset: ${preset.name}`)
      if (preset.description) {
        console.log(`  ${preset.description}`)
      }

      const repoPath = resolve(preset.repoPath)

      // Check if tmux is available
      if (!TmuxRenderer.isAvailable()) {
        console.error('Error: tmux is not installed or not in PATH')
        process.exit(1)
      }

      // Generate instance-specific session name
      const instanceId = getSessionName(repoPath)

      console.log(`Instance: ${instanceId}`)
      if (useWorktrees) {
        console.log(`Worktrees: enabled`)
      }

      // Create tmux renderer with instance-specific name
      const tmux = new TmuxRenderer({ sessionName: instanceId })

      // Kill existing session for THIS repo if it exists
      if (tmux.sessionExists()) {
        console.log(`Stopping existing ${instanceId} session...`)
        await unregisterInstance(instanceId)
        tmux.killSession()
      }

      // Create session manager with instance-specific status directory
      const statusDir = getStatusDirForInstance(instanceId)
      const manager = new SessionManager({ repoPath, statusDir })
      await manager.start()

      // Create tmux session
      tmux.createSession()

      // Create sessions from preset
      const sessions = []
      for (let i = 0; i < preset.sessions.length; i++) {
        const presetSession = preset.sessions[i]

        // Determine branch: preset > auto-generated > none
        let branch: string | undefined = presetSession.branch
        if (!branch && useWorktrees) {
          branch = generateAutoBranch(i)
        }

        const branchDisplay = branch || `session-${i + 1} (no worktree)`

        console.log(`  Creating #${i + 1}: ${branchDisplay}...`)

        try {
          // Create session first (creates worktree if branch specified)
          const session = await manager.createSession({
            branch,
            mode: presetSession.mode || 'claude',
            workingDirectory: repoPath,
            repoPath,
          })

          sessions.push(session)

          // Use worktree path if available
          const workDir = session.worktreePath || repoPath
          tmux.createPane(`session-${i}`, workDir)

          const cmd = presetSession.mode === 'shell' ? '' : presetSession.mode || 'claude'
          if (cmd) {
            tmux.runInPane(`session-${i}`, cmd)
          }

          if (session.worktreePath) {
            console.log(`    Worktree: ${session.worktreePath}`)
          }
        } catch (err) {
          console.error(`  Error creating session ${i + 1}:`, (err as Error).message)
        }
      }

      console.log(`\nStarted ${sessions.length} session(s) from preset "${name}"`)

      // Save session metadata for status display
      const sessionMetadata: SessionMetadata[] = sessions.map((s) => ({
        id: s.id,
        displayId: s.displayId,
        branch: s.branch,
        mode: s.mode,
        worktreePath: s.worktreePath,
        createdAt: s.createdAt.toISOString(),
      }))
      await saveSessionStore(instanceId, sessionMetadata)

      // Register instance in registry
      await registerInstance(repoPath, sessions.length)

      // Start status bar updates - use manager's monitor (already started)
      const statusBar = new StatusBar({ sessionName: instanceId })
      await statusBar.start(manager.status)

      if (attach) {
        console.log('\nAttaching to tmux session...')
        tmux.attach()
      } else {
        console.log(`\nTo attach to tmux session: tmux attach -t ${instanceId}`)
      }
    } catch (err) {
      console.error('Error loading preset:', (err as Error).message)
      process.exit(1)
    }
  })

// orcha preset delete
presetCmd
  .command('delete <name>')
  .description('Delete a saved preset')
  .action(async (name) => {
    const configLoader = new ConfigLoader()

    try {
      const deleted = await configLoader.deletePreset(name)
      if (deleted) {
        console.log(`Preset deleted: ${name}`)
      } else {
        console.log(`Preset not found: ${name}`)
      }
    } catch (err) {
      console.error('Error deleting preset:', (err as Error).message)
      process.exit(1)
    }
  })

// orcha preset show
presetCmd
  .command('show <name>')
  .description('Show details of a preset')
  .action(async (name) => {
    const configLoader = new ConfigLoader()

    try {
      const preset = await configLoader.loadPreset(name)

      console.log(`Preset: ${preset.name}`)
      if (preset.description) {
        console.log(`Description: ${preset.description}`)
      }
      console.log(`Repository: ${preset.repoPath}`)
      console.log(`\nSessions (${preset.sessions.length}):`)

      for (let i = 0; i < preset.sessions.length; i++) {
        const s = preset.sessions[i]
        console.log(`  #${i + 1}: ${s.branch || '(no branch)'} [${s.mode || 'claude'}]`)
      }
    } catch (err) {
      console.error('Error:', (err as Error).message)
      process.exit(1)
    }
  })

program.parse()
