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
  migrateStatusFromLegacyPaths,
  discoverOrphanedTmuxSessions,
  registerInstance,
  unregisterInstance,
  findInstanceFromCwd,
  listInstances,
  cleanupStaleInstances,
  generateInstanceId,
  saveSessionStore,
  loadSessionStore,
  clearSessionStore,
  ensureHooksInstalled,
} from '../core/index.js'
import { detectDeadSessions, cleanupDeadSessions } from '../core/cleanup.js'
import type { SessionMetadata } from '../core/index.js'
import type { InstanceInfo } from '../core/index.js'
import { formatStatus } from './format.js'
import { TmuxRenderer } from './tmux-renderer.js'
import { startMcpServer } from '../mcp/index.js'
import { startWebDashboard } from '../web/server.js'
import { runDashboard } from './dashboard.js'
import { runBlessedDashboard } from './blessed-dashboard.js'
import { StatusBar } from './status-bar.js'
import { WorktreeManager } from '../core/worktree-manager.js'
import {
  defaultPipelineConfig,
  parsePipelineConfig,
  createPipelineRun,
  executeArchitectStage,
  executeDevStage,
  executeGateStage,
  executeFixLoopStage,
  executeShipStage,
  getPipelineDir,
} from '../pipeline/index.js'
import { parseAcceptanceCriteria } from '../pipeline/prompt-builder.js'
import {
  approveCheckpoint,
  rejectCheckpoint,
  feedbackArchitectCheckpoint,
  pausePipeline,
  resumePipeline,
  recoverPipeline,
  loadPipelineOrThrow,
} from '../pipeline/checkpoint.js'

import { rm } from 'fs/promises'
import { existsSync } from 'fs'

const program = new Command()

// State file for persisting session info across CLI invocations
const ORCHA_STATE_FILE = '/tmp/orcha/state.json'

/**
 * Clean up all status files in a status directory
 */
async function cleanupStatusDir(statusDir: string): Promise<void> {
  if (existsSync(statusDir)) {
    try {
      await rm(statusDir, { recursive: true, force: true })
    } catch {
      // Ignore errors during cleanup
    }
  }
}

/**
 * Check if an instance has recoverable sessions
 * Returns session metadata if recovery is possible, null otherwise
 *
 * This function also:
 * - Migrates status files from legacy /tmp locations to ~/.orcha
 * - Discovers orphaned tmux sessions (orcha-ui-*) and reconstructs metadata
 */
async function checkRecoverableSessions(
  instanceId: string,
  repoPath: string
): Promise<SessionMetadata[] | null> {
  // Step 1: Migrate any status files from legacy /tmp locations
  const migratedCount = await migrateStatusFromLegacyPaths(instanceId)
  if (migratedCount > 0) {
    console.log(`  Migrated ${migratedCount} status file(s) from legacy location`)
  }

  // Step 2: Load existing session metadata
  let sessions = await loadSessionStore(instanceId)

  // Step 3: Discover orphaned tmux sessions that aren't in sessions.json
  const orphanedTmux = discoverOrphanedTmuxSessions()
  const trackedSessionIds = new Set(sessions.map(s => s.id))

  // Find orphans that belong to this instance (by checking if tmux session exists)
  const orphansToAdd: SessionMetadata[] = []
  for (const orphan of orphanedTmux) {
    // Skip if already tracked
    if (trackedSessionIds.has(orphan.sessionId)) continue

    // Check if this tmux session actually exists and is alive
    const orphanTmux = new TmuxRenderer({ sessionName: orphan.tmuxSession })
    if (!orphanTmux.sessionExists()) continue

    // Reconstruct metadata for this orphaned session
    // We have limited info, so we use sensible defaults
    const nextDisplayId = sessions.length > 0
      ? Math.max(...sessions.map(s => s.displayId)) + 1
      : orphansToAdd.length + 1

    const metadata: SessionMetadata = {
      id: orphan.sessionId,
      displayId: nextDisplayId + orphansToAdd.length,
      paneIndex: 0, // UI sessions always use pane 0 in their own tmux session
      branch: null,
      mode: 'claude', // Assume claude mode for orphaned sessions
      worktreePath: null, // Unknown, will be null
      createdAt: new Date().toISOString(),
      tmuxSession: orphan.tmuxSession,
    }

    orphansToAdd.push(metadata)
    console.log(`  Discovered orphaned tmux session: ${orphan.tmuxSession} -> ${orphan.sessionId}`)
  }

  // Add orphaned sessions to the store
  if (orphansToAdd.length > 0) {
    sessions = [...sessions, ...orphansToAdd]
    await saveSessionStore(instanceId, sessions)
    console.log(`  Added ${orphansToAdd.length} orphaned session(s) to metadata store`)
  }

  // Step 4: Validate sessions
  if (sessions.length === 0) {
    return null
  }

  // Check if main tmux session exists OR if any UI sessions exist
  const tmux = new TmuxRenderer({ sessionName: instanceId })
  const hasMainTmux = tmux.sessionExists()
  const hasUiSessions = sessions.some(s => {
    if (!s.tmuxSession) return false
    const uiTmux = new TmuxRenderer({ sessionName: s.tmuxSession })
    return uiTmux.sessionExists()
  })

  if (!hasMainTmux && !hasUiSessions) {
    return null
  }

  // Check if at least some sessions have valid tmux sessions
  let validSessions = 0
  for (const session of sessions) {
    // Check if UI session's tmux exists
    if (session.tmuxSession) {
      const sessionTmux = new TmuxRenderer({ sessionName: session.tmuxSession })
      if (sessionTmux.sessionExists()) {
        validSessions++
        continue
      }
    }

    // Check if worktree exists (for sessions without dedicated tmux)
    if (session.worktreePath && existsSync(session.worktreePath)) {
      validSessions++
    } else if (!session.worktreePath) {
      // Sessions without worktrees (main branch) are valid if main tmux exists
      if (hasMainTmux) validSessions++
    }
  }

  // If at least half the sessions are valid, allow recovery
  if (validSessions >= sessions.length / 2) {
    return sessions
  }

  return null
}

/**
 * Recover existing sessions instead of starting fresh
 * Handles both:
 * - CLI sessions: panes in the main tmux session
 * - UI sessions: separate tmux sessions (orcha-ui-*)
 */
async function recoverSessions(
  instanceId: string,
  repoPath: string,
  sessions: SessionMetadata[],
  statusDir: string
): Promise<{ recovered: number; failed: number }> {
  const mainTmux = new TmuxRenderer({ sessionName: instanceId })
  const mainPanes = mainTmux.sessionExists() ? mainTmux.listPanes() : []

  let recovered = 0
  let failed = 0

  for (const session of sessions) {
    // Determine which tmux session this session belongs to
    const isUiSession = !!session.tmuxSession && session.tmuxSession !== instanceId
    const sessionTmux = isUiSession
      ? new TmuxRenderer({ sessionName: session.tmuxSession! })
      : mainTmux

    // Check if the tmux session exists
    if (!sessionTmux.sessionExists()) {
      console.log(`  Session #${session.displayId}: tmux session missing (${session.tmuxSession || instanceId}), skipping`)
      failed++
      continue
    }

    // Check if worktree still exists (if applicable)
    if (session.worktreePath && !existsSync(session.worktreePath)) {
      console.log(`  Session #${session.displayId}: worktree missing at ${session.worktreePath}`)
      failed++
      continue
    }

    // For UI sessions, use pane 0. For CLI sessions, use paneIndex
    const paneIndex = isUiSession ? 0 : session.paneIndex

    // Check if the pane has a running AI process
    const detected = sessionTmux.detectClaudeStatus(paneIndex)
    const hasRunningProcess = detected && detected.state !== 'idle'

    if (hasRunningProcess) {
      console.log(`  Session #${session.displayId}: already running (${detected?.state || 'active'})`)
      recovered++
      continue
    }

    // Session exists but AI process isn't running - restart it
    const workDir = session.worktreePath || repoPath
    const cmd = session.mode === 'shell' ? '' : session.mode

    if (cmd) {
      // Use --continue to resume Claude's conversation context when recovering
      const resumeFlag = session.mode === 'claude' ? ' --continue' : ''
      console.log(`  Session #${session.displayId}: restarting ${session.mode}${resumeFlag ? ' (resuming conversation)' : ''}...`)

      // Build command with correct env vars pointing to new status dir
      const envCmd = `ORCHA_SESSION_ID='${session.id}' ORCHA_STATUS_DIR='${statusDir}' ${cmd}${resumeFlag}`

      if (isUiSession) {
        // UI sessions: send command to pane 0 of their dedicated tmux session
        sessionTmux.runInPane(session.id, envCmd)
      } else {
        // CLI sessions: send command to the appropriate pane in main session
        sessionTmux.runInPane(session.id, envCmd)
      }
    }

    recovered++
  }

  return { recovered, failed }
}

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
  .option('-s, --source <branch>', 'Source branch to create worktrees from (e.g. release/2.2.0)')
  .option('-m, --mode <mode>', 'AI mode: claude, gemini, codex, shell', 'claude')
  .option('--main', 'Work directly on main branch (no worktree)')
  .option('--no-worktree', 'Disable automatic worktree creation')
  .option('--no-attach', 'Do not attach to tmux session after starting')
  .option('--fresh', 'Force fresh start, skipping session recovery')
  .action(async (options) => {
    const { count, repo, branches, source, mode, attach, worktree, main, fresh } = options

    // Validate inputs
    if (count < 1 || count > 12) {
      console.error('Error: Session count must be between 1 and 12')
      process.exit(1)
    }

    // Default to current directory if not specified
    const repoPath = resolve(repo || '.')
    const useWorktrees = worktree !== false && !main // default true, disabled by --main or --no-worktree

    // Check if tmux is available
    if (!TmuxRenderer.isAvailable()) {
      console.error('Error: tmux is not installed or not in PATH')
      console.error('Install with: apt install tmux (Linux) or brew install tmux (macOS)')
      process.exit(1)
    }

    // Ensure Claude Code hooks are installed for status updates
    await ensureHooksInstalled()

    // Parse branches if provided
    const branchList = branches ? branches.split(',').map((b: string) => b.trim()) : []

    // Generate instance-specific session name
    const instanceId = getSessionName(repoPath)
    const statusDir = getStatusDirForInstance(instanceId)

    // Check for recoverable sessions first (unless --fresh is specified)
    const recoverableSessions = fresh ? null : await checkRecoverableSessions(instanceId, repoPath)
    if (recoverableSessions) {
      console.log(`Found ${recoverableSessions.length} recoverable session(s) in ${instanceId}`)
      console.log(`Attempting auto-recovery...`)

      const { recovered, failed } = await recoverSessions(
        instanceId,
        repoPath,
        recoverableSessions,
        statusDir
      )

      if (recovered > 0) {
        console.log(`\nRecovered ${recovered} session(s)${failed > 0 ? `, ${failed} failed` : ''}`)
        console.log(`Instance: ${instanceId}`)

        // Start status bar updates
        const monitor = new StatusMonitor({ statusDir })
        await monitor.start()
        const statusBar = new StatusBar({ sessionName: instanceId })
        await statusBar.start(monitor)

        console.log('\nCommands:')
        console.log('  orcha status      - View session status')
        console.log('  orcha watch       - Interactive dashboard')
        console.log('  orcha stop        - Stop this instance')
        console.log('  orcha start --fresh - Force fresh start (clears sessions)')

        if (attach) {
          console.log('\nAttaching to tmux session...')
          const tmux = new TmuxRenderer({ sessionName: instanceId })
          tmux.attach()
        } else {
          console.log(`\nTo attach to tmux session: tmux attach -t ${instanceId}`)
        }
        return
      } else {
        console.log(`Recovery failed, starting fresh...`)
      }
    }

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

    // Always clean up old status files and session store for fresh start
    await clearSessionStore(instanceId)
    await cleanupStatusDir(statusDir)

    // Clean up orphaned worktrees from previous runs
    const worktrees = new WorktreeManager(repoPath)
    const removedWorktrees = await worktrees.cleanup([])
    if (removedWorktrees.length > 0) {
      console.log(`Cleaned up ${removedWorktrees.length} orphaned worktree(s)`)
    }
    await worktrees.prune()

    // Create session manager with instance-specific status directory
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
          sourceBranch: source || undefined,
          mode: mode as 'claude' | 'gemini' | 'codex' | 'shell',
          workingDirectory: repoPath,
          repoPath,
        })

        sessions.push(session)

        // Write status file so dashboard can see it
        const status = manager.status.getStatus(session.id)
        if (status) {
          await manager.status.writeStatusFile(session.id, status)
        }

        // Use worktree path if available, otherwise repo path
        const workDir = session.worktreePath || repoPath

        // Create tmux pane at the correct working directory (use actual session ID)
        tmux.createPane(session.id, workDir)

        // Run the AI command in the tmux pane with orcha env vars (inline syntax)
        const cmd = mode === 'shell' ? '' : mode
        if (cmd) {
          const envCmd = `ORCHA_SESSION_ID='${session.id}' ORCHA_STATUS_DIR='${statusDir}' ${cmd}`
          tmux.runInPane(session.id, envCmd)
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
      paneIndex: idx,
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

    if (!targetSessionId) {
      await monitor.stop()
      console.error(`Error: Session #${displayId} not found`)
      process.exit(1)
    }

    // Kill the pane
    try {
      tmux.killPane(targetSessionId)

      // Clean up the status file so dashboard doesn't show stale entry
      await monitor.unregisterSession(targetSessionId)

      // Also update the session store to remove this session
      const metadata = await loadSessionStore(targetInstance.instanceId)
      const updatedMetadata = metadata.filter((m) => m.id !== targetSessionId)
      await saveSessionStore(targetInstance.instanceId, updatedMetadata)

      console.log(`Killed session #${displayId}`)
    } catch (err) {
      console.error(`Error killing session:`, (err as Error).message)
    }

    await monitor.stop()
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

    // Use index-based focus (displayId is 1-based, pane index is 0-based)
    const paneIndex = displayId - 1

    try {
      tmux.focusPaneByIndex(paneIndex)
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
  .option('-s, --source <branch>', 'Source branch to create worktree from (e.g. release/2.2.0)')
  .option('-m, --mode <mode>', 'AI mode: claude, gemini, codex, shell', 'claude')
  .option('-i, --instance <id>', 'Target specific instance')
  .option('--no-worktree', 'Disable automatic worktree creation')
  .action(async (options) => {
    const { branch, source, mode, instance: instanceId, worktree } = options
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
        sourceBranch: source || undefined,
        mode: (mode as 'claude' | 'gemini' | 'codex' | 'shell') || 'claude',
        workingDirectory: targetInstance.repoPath,
        repoPath: targetInstance.repoPath,
      })

      // Write status file so dashboard can see it
      const status = manager.status.getStatus(session.id)
      if (status) {
        await manager.status.writeStatusFile(session.id, status)
      }

      // Use worktree path if available
      const workDir = session.worktreePath || targetInstance.repoPath

      // Create tmux pane at correct location (use actual session ID)
      tmux.createPane(session.id, workDir)

      // Run the AI command in the tmux pane with orcha env vars (inline syntax)
      const cmd = mode === 'shell' ? '' : mode || 'claude'
      if (cmd) {
        const envCmd = `ORCHA_SESSION_ID='${session.id}' ORCHA_STATUS_DIR='${statusDir}' ${cmd}`
        tmux.runInPane(session.id, envCmd)
      }

      // Update session metadata store
      const existingMetadata = await loadSessionStore(targetInstance.instanceId)
      const newPaneIndex = existingMetadata.length
      existingMetadata.push({
        id: session.id,
        displayId: session.displayId,
        paneIndex: newPaneIndex,
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
  .description('Launch interactive TUI dashboard (shows all instances by default)')
  .option('-r, --repo', 'Show only current repo instance')
  .option('-i, --instance <id>', 'Target specific instance')
  .option('-u, --ui <type>', 'Dashboard UI: blessed (Maestro-style) or ink (default)', 'blessed')
  .action(async (options) => {
    const { instance: instanceId, repo: repoOnly, ui } = options

    // Find target instance if filtering
    let singleInstance: InstanceInfo | undefined = undefined

    if (instanceId) {
      // Specific instance requested
      const instances = await listInstances()
      const found = instances.find((i) => i.instanceId === instanceId)
      if (!found) {
        console.log(`Instance not found: ${instanceId}`)
        console.log('Run "orcha list" to see running instances.')
        return
      }
      singleInstance = found
    } else if (repoOnly) {
      // Current repo only
      const current = await getCurrentInstance()
      if (!current) {
        console.log('No orcha instance found for current directory.')
        console.log('Use "orcha watch" without -r to see all instances.')
        return
      }
      singleInstance = current
    }
    // Otherwise: show all instances (singleInstance remains undefined)

    if (ui === 'ink') {
      await runDashboard({ singleInstance })
    } else {
      // Default to Blessed (Maestro-style)
      await runBlessedDashboard({ singleInstance })
    }
  })

// =============================================================================
// orcha web
// =============================================================================
program
  .command('web')
  .description('Launch web-based dashboard with interactive terminals')
  .option('-p, --port <port>', 'Server port', '3847')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (options) => {
    const port = parseInt(options.port, 10)
    const open = options.open !== false

    console.log('Starting Orcha Web Dashboard...')
    await startWebDashboard(port, open)
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
  .description('Remove orphaned worktrees, dead tmux sessions, and clean up temp files')
  .option('-r, --repo <path>', 'Repository path (default: current directory)')
  .option('--dry-run', 'Show what would be cleaned without removing')
  .option('--sessions-only', 'Only clean up dead tmux sessions, skip worktrees')
  .action(async (options) => {
    const { repo, dryRun, sessionsOnly } = options

    // Clean up dead tmux sessions
    console.log('Scanning for dead tmux sessions...')
    const deadSessions = await detectDeadSessions()

    if (deadSessions.length > 0) {
      console.log(`\nFound ${deadSessions.length} dead tmux session(s):`)
      for (const session of deadSessions) {
        console.log(`  - ${session.name}`)
        console.log(`    Reason: ${session.reason}`)
        console.log(`    Created: ${new Date(session.created).toLocaleString()}`)
      }

      if (dryRun) {
        console.log('\n[Dry run] Would kill the above tmux sessions.')
      } else {
        const result = await cleanupDeadSessions(false)
        console.log(`\nKilled ${result.deadSessions.length} dead tmux session(s).`)

        if (result.cleanedInstances.length > 0) {
          console.log(`Cleaned ${result.cleanedInstances.length} instance(s) from registry:`)
          for (const instanceId of result.cleanedInstances) {
            console.log(`  - ${instanceId}`)
          }
        }

        if (result.cleanedTempDirs.length > 0) {
          console.log(`Removed ${result.cleanedTempDirs.length} temp director(ies):`)
          for (const dir of result.cleanedTempDirs) {
            console.log(`  - ${dir}`)
          }
        }
      }
    } else {
      console.log('No dead tmux sessions found.')
    }

    // Skip worktree cleanup if --sessions-only flag is set
    if (sessionsOnly) {
      console.log('\nCleanup complete (sessions only).')
      return
    }

    // Clean up worktrees
    const repoPath = resolve(repo || '.')
    console.log(`\nCleaning up orphaned worktrees for ${repoPath}...`)

    const worktrees = new WorktreeManager(repoPath)

    // Get all managed worktrees
    const managed = await worktrees.listManaged()

    if (managed.length === 0) {
      console.log('No orcha-managed worktrees found.')
    } else {
      console.log(`Found ${managed.length} orcha-managed worktree(s):`)
      for (const wt of managed) {
        console.log(`  - ${wt.sessionId}: ${wt.branch} (${wt.path})`)
      }

      if (dryRun) {
        console.log('\n[Dry run] Would remove all above worktrees.')
      } else {
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
      }
    }

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

      // Always clean up old status files and session store for fresh start
      await clearSessionStore(instanceId)
      const statusDir = getStatusDirForInstance(instanceId)
      await cleanupStatusDir(statusDir)

      // Clean up orphaned worktrees from previous runs
      const worktreeMgr = new WorktreeManager(repoPath)
      const removedWorktrees = await worktreeMgr.cleanup([])
      if (removedWorktrees.length > 0) {
        console.log(`Cleaned up ${removedWorktrees.length} orphaned worktree(s)`)
      }
      await worktreeMgr.prune()

      // Create session manager with instance-specific status directory
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

          // Write status file so dashboard can see it
          const status = manager.status.getStatus(session.id)
          if (status) {
            await manager.status.writeStatusFile(session.id, status)
          }

          // Use worktree path if available
          const workDir = session.worktreePath || repoPath
          tmux.createPane(session.id, workDir)

          const cmd = presetSession.mode === 'shell' ? '' : presetSession.mode || 'claude'
          if (cmd) {
            const envCmd = `ORCHA_SESSION_ID='${session.id}' ORCHA_STATUS_DIR='${statusDir}' ${cmd}`
            tmux.runInPane(session.id, envCmd)
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
      const sessionMetadata: SessionMetadata[] = sessions.map((s, idx) => ({
        id: s.id,
        displayId: s.displayId,
        paneIndex: idx,
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

// =============================================================================
// orcha pipeline (parent command)
// =============================================================================
const pipelineCmd = program
  .command('pipeline')
  .description('Manage pipeline runs')

// orcha pipeline run
pipelineCmd
  .command('run')
  .description('Run a pipeline (architect stage only for now)')
  .option('--work-item <id>', 'GitHub issue number or ADO work item ID')
  .option('--title <text>', 'Short display title for the pipeline')
  .option('--description <text>', 'Inline description of the work')
  .option('--ac <criteria>', 'Inline acceptance criteria (comma-separated)')
  .option('--source-branch <branch>', 'Source branch (default: main)')
  .option('--worktree-path <path>', 'Path to an existing worktree to use')
  .option('--model-architect <model>', 'Override model for architect stage')
  .option('--model-dev <model>', 'Override model for dev stage')
  .option('--model-gate <model>', 'Override model for gate stage')
  .option('--model-fix <model>', 'Override model for fix stage')
  .option('--model-ship <model>', 'Override model for ship stage')
  .option('--max-budget-usd <amount>', 'Override default budget per stage', parseFloat)
  .option('--competing <count>', 'Run N competing dev agents in parallel', parseInt)
  .action(async (options) => {
    const {
      workItem,
      title,
      description,
      ac,
      sourceBranch,
      worktreePath,
      modelArchitect,
      modelDev,
      modelGate,
      modelFix,
      modelShip,
      maxBudgetUsd,
      competing,
    } = options

    // Require at least a description or work item
    if (!description && !workItem) {
      console.error('Error: Provide at least --description or --work-item')
      process.exit(1)
    }

    // Determine the worktree path (required for now)
    const resolvedWorktreePath = worktreePath ? resolve(worktreePath) : resolve('.')
    const resolvedSourceBranch = sourceBranch || 'main'
    const resolvedDescription = description || `Work item ${workItem}`

    // Parse acceptance criteria
    let acceptanceCriteria: string[] = []
    if (ac) {
      acceptanceCriteria = ac.split(',').map((c: string) => c.trim()).filter(Boolean)
    }

    // Build pipeline config with overrides
    const configOverrides: Record<string, unknown> = {}
    const modelOverrides: Record<string, string> = {}
    const budgetOverrides: Record<string, number> = {}

    if (modelArchitect) modelOverrides.architect = modelArchitect
    if (modelDev) modelOverrides.dev = modelDev
    if (modelGate) modelOverrides.gate = modelGate
    if (modelFix) modelOverrides.fix = modelFix
    if (modelShip) modelOverrides.ship = modelShip

    if (Object.keys(modelOverrides).length > 0) {
      configOverrides.models = modelOverrides
    }

    if (maxBudgetUsd !== undefined) {
      budgetOverrides.default = maxBudgetUsd
      configOverrides.budgets = budgetOverrides
    }

    if (competing !== undefined) {
      if (isNaN(competing) || competing < 1 || competing > 10) {
        console.error('Error: --competing must be between 1 and 10')
        process.exit(1)
      }
      if (competing > 1) {
        configOverrides.competingAgents = competing
      }
    }

    if (maxBudgetUsd !== undefined && isNaN(maxBudgetUsd)) {
      console.error('Error: --max-budget-usd must be a number')
      process.exit(1)
    }

    let config
    try {
      const defaults = defaultPipelineConfig()
      if (Object.keys(configOverrides).length > 0) {
        // Deep-merge overrides onto defaults so unspecified fields keep their defaults
        const merged = {
          ...defaults,
          models: { ...defaults.models, ...((configOverrides.models as object) || {}) },
          budgets: { ...defaults.budgets, ...((configOverrides.budgets as object) || {}) },
          ...(configOverrides.competingAgents !== undefined
            ? { competingAgents: configOverrides.competingAgents }
            : {}),
        }
        config = parsePipelineConfig(merged)
      } else {
        config = defaults
      }
    } catch (err) {
      console.error('Error parsing pipeline config:', (err as Error).message)
      process.exit(1)
    }

    console.log('Creating pipeline run...')
    console.log(`  Description: ${resolvedDescription}`)
    console.log(`  Source branch: ${resolvedSourceBranch}`)
    console.log(`  Worktree: ${resolvedWorktreePath}`)
    if (workItem) console.log(`  Work item: ${workItem}`)
    if (acceptanceCriteria.length > 0) {
      console.log(`  Acceptance criteria: ${acceptanceCriteria.length} item(s)`)
    }

    try {
      // Create the pipeline run
      let run = await createPipelineRun({
        config,
        description: resolvedDescription,
        acceptanceCriteria,
        sourceBranch: resolvedSourceBranch,
        worktreePath: resolvedWorktreePath,
        workItemId: workItem,
        title: title || undefined,
      })

      console.log(`\nPipeline created: ${run.id}`)
      console.log(`  State dir: ${getPipelineDir(run.id)}`)
      console.log(`\nStarting architect stage...`)

      // Execute the architect stage
      run = await executeArchitectStage(run, {
        modelOverride: modelArchitect,
      })

      if (run.state === 'error') {
        console.error(`\nArchitect stage failed: ${run.error}`)
        process.exit(1)
      }

      console.log(`\nArchitect stage completed successfully.`)
      console.log(`  State: ${run.state}`)
      if (run.blueprintPath) {
        console.log(`  Blueprint: ${run.blueprintPath}`)
      }
      console.log(`  Pipeline dir: ${getPipelineDir(run.id)}`)
      console.log(`\nPipeline is now at checkpoint:arch.`)
      console.log(`Review the blueprint and proceed with: orcha pipeline approve ${run.id}`)
    } catch (err) {
      console.error('Pipeline error:', (err as Error).message)
      process.exit(1)
    }
  })

// orcha pipeline status
pipelineCmd
  .command('status [id]')
  .description('Show pipeline status')
  .action(async (id?: string) => {
    const { listPipelineRuns, loadPipelineRun } = await import('../pipeline/index.js')

    if (id) {
      const run = await loadPipelineRun(id)
      if (!run) {
        console.error(`Pipeline not found: ${id}`)
        process.exit(1)
      }
      console.log(`Pipeline: ${run.id}`)
      console.log(`  State: ${run.state}`)
      console.log(`  Description: ${run.description}`)
      console.log(`  Source branch: ${run.sourceBranch}`)
      console.log(`  Worktree: ${run.worktreePath}`)
      console.log(`  Created: ${run.createdAt}`)
      console.log(`  Updated: ${run.updatedAt}`)
      if (run.blueprintPath) console.log(`  Blueprint: ${run.blueprintPath}`)
      if (run.error) console.log(`  Error: ${run.error}`)
      if (run.competingResults && run.competingResults.length > 0) {
        console.log(`  Competing agents: ${run.competingResults.length}`)
        for (const c of run.competingResults) {
          const status = c.winner ? ' (WINNER)' : c.gateScore >= 0 ? '' : ' (pending)'
          console.log(`    Agent #${c.agentIndex}: score=${c.gateScore}${status}`)
        }
      }
      if (run.stageHistory.length > 0) {
        console.log(`  Stage history:`)
        for (const stage of run.stageHistory) {
          console.log(`    - ${stage.stage}: ${stage.startedAt} -> ${stage.completedAt} (model: ${stage.model || 'N/A'})`)
        }
      }
    } else {
      const runs = await listPipelineRuns()
      if (runs.length === 0) {
        console.log('No pipeline runs found.')
        console.log('\nStart a pipeline with: orcha pipeline run --description "..."')
        return
      }
      console.log('PIPELINE'.padEnd(25) + 'STATE'.padEnd(20) + 'DESCRIPTION'.padEnd(40) + 'UPDATED')
      console.log('-'.repeat(95))
      for (const run of runs) {
        const shortDesc = run.description.length > 38
          ? run.description.slice(0, 35) + '...'
          : run.description
        console.log(
          run.id.padEnd(25) +
          run.state.padEnd(20) +
          shortDesc.padEnd(40) +
          run.updatedAt
        )
      }
    }
  })

// orcha pipeline list
pipelineCmd
  .command('list')
  .alias('ls')
  .description('List all pipeline runs')
  .action(async () => {
    const { listPipelineRuns } = await import('../pipeline/index.js')
    const runs = await listPipelineRuns()

    if (runs.length === 0) {
      console.log('No pipeline runs found.')
      return
    }

    console.log('PIPELINE'.padEnd(25) + 'STATE'.padEnd(20) + 'DESCRIPTION')
    console.log('-'.repeat(75))
    for (const run of runs) {
      const shortDesc = run.description.length > 38
        ? run.description.slice(0, 35) + '...'
        : run.description
      console.log(
        run.id.padEnd(25) +
        run.state.padEnd(20) +
        shortDesc
      )
    }
  })

// orcha pipeline approve <id>
pipelineCmd
  .command('approve <id>')
  .description('Approve the current checkpoint (architect or ship)')
  .option('--continue', 'Continue executing the pipeline after approval')
  .action(async (id: string, options: { continue?: boolean }) => {
    try {
      let run = await loadPipelineOrThrow(id)

      console.log(`Approving checkpoint for pipeline ${run.id} (state: ${run.state})...`)
      run = await approveCheckpoint(run)
      console.log(`  New state: ${run.state}`)

      if (options.continue) {
        // Auto-continue: run the next stage(s)
        run = await continuePipeline(run)
      } else if (run.state === 'dev') {
        console.log(`\nTo continue the pipeline, run:`)
        console.log(`  orcha pipeline approve ${run.id} --continue`)
        console.log(`  (or manually: the pipeline is now in 'dev' state)`)
      } else if (run.state === 'ship') {
        console.log(`\nExecuting ship stage...`)
        run = await executeShipStage(run)
        if (run.state === 'completed') {
          console.log(`  Pipeline completed successfully!`)
          // Show PR info if available
          const { readFile } = await import('fs/promises')
          const { join } = await import('path')
          try {
            const prJson = await readFile(join(getPipelineDir(run.id), 'ship', 'pr.json'), 'utf-8')
            const pr = JSON.parse(prJson)
            if (pr.url) {
              console.log(`  PR: ${pr.url}`)
            }
          } catch { /* no PR info available */ }
        } else if (run.state === 'error') {
          console.error(`  Ship stage failed: ${run.error}`)
        }
      }
    } catch (err) {
      console.error('Error:', (err as Error).message)
      process.exit(1)
    }
  })

// orcha pipeline reject <id>
pipelineCmd
  .command('reject <id>')
  .description('Reject the current checkpoint and cancel the pipeline')
  .action(async (id: string) => {
    try {
      let run = await loadPipelineOrThrow(id)

      console.log(`Rejecting checkpoint for pipeline ${run.id} (state: ${run.state})...`)
      run = await rejectCheckpoint(run)
      console.log(`  Pipeline cancelled.`)
    } catch (err) {
      console.error('Error:', (err as Error).message)
      process.exit(1)
    }
  })

// orcha pipeline feedback <id> <text>
pipelineCmd
  .command('feedback <id> <text>')
  .description('Provide feedback on the architect blueprint and re-run architect')
  .action(async (id: string, text: string) => {
    try {
      let run = await loadPipelineOrThrow(id)

      console.log(`Sending feedback for pipeline ${run.id}...`)
      console.log(`  Feedback: ${text}`)
      console.log(`  Re-running architect stage with feedback...`)

      run = await feedbackArchitectCheckpoint(run, text)

      if (run.state === 'error') {
        console.error(`\nArchitect re-run failed: ${run.error}`)
        process.exit(1)
      }

      console.log(`\nArchitect re-run completed.`)
      console.log(`  State: ${run.state}`)
      if (run.blueprintPath) {
        console.log(`  Updated blueprint: ${run.blueprintPath}`)
      }
      console.log(`\nReview the updated blueprint and proceed with: orcha pipeline approve ${run.id}`)
    } catch (err) {
      console.error('Error:', (err as Error).message)
      process.exit(1)
    }
  })

// orcha pipeline resume <id>
pipelineCmd
  .command('resume <id>')
  .description('Resume a paused pipeline')
  .option('--continue', 'Continue executing the resumed stage')
  .action(async (id: string, options: { continue?: boolean }) => {
    try {
      let run = await loadPipelineOrThrow(id)

      console.log(`Resuming pipeline ${run.id} (paused at: ${run.pausedStage})...`)
      run = await resumePipeline(run)
      console.log(`  Resumed to state: ${run.state}`)

      if (options.continue) {
        run = await continuePipeline(run)
      } else {
        console.log(`\nPipeline resumed. Use --continue to auto-execute the current stage.`)
      }
    } catch (err) {
      console.error('Error:', (err as Error).message)
      process.exit(1)
    }
  })

// orcha pipeline recover <id>
pipelineCmd
  .command('recover <id>')
  .description('Recover a pipeline stuck in error state')
  .option('--continue', 'Continue executing the recovered stage')
  .action(async (id: string, options: { continue?: boolean }) => {
    try {
      let run = await loadPipelineOrThrow(id)

      if (run.state !== 'error') {
        console.error(`Pipeline ${run.id} is in '${run.state}' state, not 'error'. Nothing to recover.`)
        process.exit(1)
      }

      console.log(`Recovering pipeline ${run.id} from error state...`)
      if (run.error) {
        console.log(`  Previous error: ${run.error}`)
      }

      run = await recoverPipeline(run)
      console.log(`  Recovered to state: ${run.state}`)

      if (options.continue) {
        run = await continuePipeline(run)
      } else {
        console.log(`\nPipeline recovered to '${run.state}'. Re-run with --continue to auto-execute:`)
        console.log(`  orcha pipeline recover ${run.id} --continue`)
      }
    } catch (err) {
      console.error('Error:', (err as Error).message)
      process.exit(1)
    }
  })

/**
 * Continue executing a pipeline from its current state.
 * Drives through dev → gate → fix-loop cycles automatically,
 * pausing at checkpoints.
 */
async function continuePipeline(run: import('../pipeline/index.js').PipelineRun): Promise<import('../pipeline/index.js').PipelineRun> {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (run.state === 'created') {
      console.log(`\nExecuting architect stage...`)
      run = await executeArchitectStage(run)
      if (run.state === 'error') {
        console.error(`Architect stage failed: ${run.error}`)
        return run
      }
      console.log(`  Architect stage complete. State: ${run.state}`)
      if (run.state === 'checkpoint:arch') {
        console.log(`\nPipeline is at checkpoint:arch.`)
        console.log(`Review the blueprint and approve with: orcha pipeline approve ${run.id}`)
        return run
      }
    }

    if (run.state === 'checkpoint:arch') {
      console.log(`\nPipeline is at checkpoint:arch.`)
      console.log(`Review the blueprint and approve with: orcha pipeline approve ${run.id}`)
      return run
    }

    if (run.state === 'dev') {
      console.log(`\nExecuting dev stage...`)
      run = await executeDevStage(run)
      if (run.state === 'error') {
        console.error(`Dev stage failed: ${run.error}`)
        return run
      }
      console.log(`  Dev stage complete. State: ${run.state}`)
    }

    if (run.state === 'gate') {
      console.log(`\nExecuting gate stage...`)
      run = await executeGateStage(run)
      if (run.state === 'error') {
        console.error(`Gate stage failed: ${run.error}`)
        return run
      }
      console.log(`  Gate stage complete. State: ${run.state}`)
    }

    if (run.state === 'fix-loop') {
      console.log(`\nGate failed. Executing fix loop (attempt ${run.fixLoopCount + 1})...`)
      run = await executeFixLoopStage(run)
      if (run.state === 'error') {
        console.error(`Fix loop failed: ${run.error}`)
        return run
      }
      if (run.state === 'escalated') {
        console.log(`\nMax fix attempts reached. Pipeline escalated for human intervention.`)
        return run
      }
      console.log(`  Fix loop complete. State: ${run.state}`)
      // Loop continues: if state is 'gate' from fix, re-run gate
      continue
    }

    if (run.state === 'checkpoint:ship') {
      console.log(`\nGate passed! Pipeline is at checkpoint:ship.`)
      console.log(`Review the changes and approve with: orcha pipeline approve ${run.id}`)
      return run
    }

    if (run.state === 'ship') {
      console.log(`\nExecuting ship stage...`)
      run = await executeShipStage(run)
      if (run.state === 'error') {
        console.error(`Ship stage failed: ${run.error}`)
        return run
      }
      console.log(`  Ship stage complete. State: ${run.state}`)
      if (run.state === 'completed') {
        console.log(`\nPipeline completed successfully!`)
        return run
      }
    }

    // Any other terminal or checkpoint state: stop
    console.log(`\nPipeline at state: ${run.state}`)
    return run
  }
}

program.parse()
