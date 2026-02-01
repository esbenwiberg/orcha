/**
 * Orcha Web Dashboard Server
 *
 * Provides a web-based multi-terminal interface for orcha sessions.
 * Each terminal panel connects to a tmux pane via WebSocket + PTY.
 */

import express from 'express'
import { createServer } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import * as pty from 'node-pty'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { listInstances, getInstance, getInstanceByPath, registerInstance } from '../core/instance-registry.js'
import { StatusMonitor, getStatusDirForInstance } from '../core/status-monitor.js'
import { loadSessionStore, updateSessionName, saveSessionStore } from '../core/session-store.js'
import type { SessionMetadata } from '../core/session-store.js'
import { SessionManager } from '../core/session-manager.js'
import { TmuxRenderer } from '../cli/tmux-renderer.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Resolve public directory - check both dist and src locations
function resolvePublicDir(): string {
  const distPublic = join(__dirname, 'public')
  const srcPublic = join(__dirname, '..', '..', 'src', 'web', 'public')

  // Prefer dist if it exists, otherwise use src
  if (existsSync(distPublic)) {
    return distPublic
  }
  return srcPublic
}

interface SessionInfo {
  id: string
  displayId: number
  instanceId: string
  tmuxSession: string
  paneIndex: number
  branch?: string
  state: string
  message: string
  customName?: string // User-defined name
}

interface PtySession {
  pty: pty.IPty
  ws: WebSocket
}

interface UsageStats {
  date: string
  tokens: number
  messages: number
  sessions: number
}

export class WebDashboardServer {
  private app = express()
  private server = createServer(this.app)
  private wss: WebSocketServer
  private ptySessions = new Map<string, PtySession>()
  private port: number

  constructor(port = 3847) {
    this.port = port
    this.wss = new WebSocketServer({ server: this.server })
    this.setupRoutes()
    this.setupWebSocket()
  }

  private setupRoutes(): void {
    // Serve static files from public directory
    const publicDir = resolvePublicDir()
    this.app.use(express.static(publicDir))

    // API: Get all sessions
    this.app.get('/api/sessions', async (_req, res) => {
      try {
        const sessions = await this.getAllSessions()
        res.json(sessions)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Get session status
    this.app.get('/api/status', async (_req, res) => {
      try {
        const sessions = await this.getAllSessions()
        const summary = {
          total: sessions.length,
          working: sessions.filter(s => s.state === 'working').length,
          waiting: sessions.filter(s => s.state === 'waiting').length,
          idle: sessions.filter(s => s.state === 'idle' || s.state === 'initializing').length,
          done: sessions.filter(s => s.state === 'done').length,
          error: sessions.filter(s => s.state === 'error').length,
        }
        res.json({ sessions, summary })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Get Claude usage stats
    this.app.get('/api/usage', async (_req, res) => {
      try {
        const usage = await this.getClaudeUsage()
        res.json(usage)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Rename a session
    this.app.use(express.json())
    this.app.put('/api/sessions/:instanceId/:sessionId/name', async (req, res) => {
      try {
        const { instanceId, sessionId } = req.params
        const { name } = req.body as { name?: string }

        const success = await updateSessionName(instanceId, sessionId, name ?? null)

        if (!success) {
          res.status(404).json({ error: 'Session not found' })
          return
        }

        res.json({ success: true, name: name || null })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Close/delete a session
    this.app.delete('/api/sessions/:instanceId/:sessionId', async (req, res) => {
      try {
        const { instanceId, sessionId } = req.params

        // Load session metadata to get tmux info
        const metadata = await loadSessionStore(instanceId)
        const session = metadata.find(m => m.id === sessionId)

        if (!session) {
          res.status(404).json({ error: 'Session not found' })
          return
        }

        // Kill tmux session/pane if it exists
        const tmuxSession = session.tmuxSession
        if (tmuxSession) {
          try {
            // Check if it's a dedicated UI session (orcha-ui-*)
            if (tmuxSession.startsWith('orcha-ui-')) {
              // Kill the entire tmux session
              execSync(`tmux kill-session -t "${tmuxSession}" 2>/dev/null`, { stdio: 'ignore' })
            } else {
              // It's a pane in a shared tmux session - kill just the pane
              const target = `${tmuxSession}:0.${session.paneIndex}`
              execSync(`tmux kill-pane -t "${target}" 2>/dev/null`, { stdio: 'ignore' })
            }
          } catch {
            // Tmux session/pane may already be gone
          }
        }

        // Remove worktree if exists
        if (session.worktreePath) {
          try {
            const instance = await getInstance(instanceId)
            if (instance) {
              execSync(`git -C "${instance.repoPath}" worktree remove --force "${session.worktreePath}" 2>/dev/null`, { stdio: 'ignore' })
            }
          } catch {
            // Worktree may not exist
          }
        }

        // Remove from session store
        const { removeSession } = await import('../core/session-store.js')
        await removeSession(instanceId, sessionId)

        // Remove status file
        const statusDir = getStatusDirForInstance(instanceId)
        const statusFile = join(statusDir, `${sessionId}.json`)
        try {
          const { unlink } = await import('fs/promises')
          await unlink(statusFile)
        } catch {
          // Status file may not exist
        }

        console.log(`[API] Session closed: ${instanceId}/${sessionId}`)
        res.json({ success: true })
      } catch (err) {
        console.error('[API] Error closing session:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Create a new session
    this.app.post('/api/sessions', async (req, res) => {
      try {
        const { instanceId, branch, mode } = req.body as {
          instanceId: string
          branch?: string
          mode?: 'claude' | 'gemini' | 'codex' | 'shell'
        }

        if (!instanceId) {
          res.status(400).json({ error: 'instanceId is required' })
          return
        }

        // Get instance info
        const instance = await getInstance(instanceId)
        if (!instance) {
          res.status(404).json({ error: 'Instance not found' })
          return
        }

        // Check tmux session exists
        const tmux = new TmuxRenderer({ sessionName: instance.tmuxSession })
        if (!tmux.sessionExists()) {
          res.status(404).json({ error: 'Tmux session not found' })
          return
        }

        // Create session manager
        const statusDir = getStatusDirForInstance(instanceId)
        const manager = new SessionManager({ repoPath: instance.repoPath, statusDir })
        await manager.start()

        // Determine branch name
        let sessionBranch = branch?.trim() || undefined
        if (!sessionBranch) {
          // Auto-generate branch name
          const existingMetadata = await loadSessionStore(instanceId)
          const sessionIdx = existingMetadata.length
          const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
          sessionBranch = `orcha/session-${sessionIdx + 1}-${timestamp}`
        }

        console.log(`[API] Creating session: ${sessionBranch} (mode=${mode || 'claude'})`)

        // Create session (this creates worktree)
        const session = await manager.createSession({
          branch: sessionBranch,
          mode: mode || 'claude',
          workingDirectory: instance.repoPath,
          repoPath: instance.repoPath,
        })

        // Write status file
        const status = manager.status.getStatus(session.id)
        if (status) {
          await manager.status.writeStatusFile(session.id, status)
        }

        // Create a NEW tmux session for this UI-created session (separate panel)
        const sessionTmuxName = `orcha-ui-${session.id}`
        const sessionTmux = new TmuxRenderer({ sessionName: sessionTmuxName })
        const workDir = session.worktreePath || instance.repoPath
        sessionTmux.createPane(session.id, workDir)

        // Run AI command
        const cmd = (mode || 'claude') === 'shell' ? '' : (mode || 'claude')
        if (cmd) {
          sessionTmux.runInPane(session.id, cmd)
        }

        // Update session metadata store
        const existingMetadata = await loadSessionStore(instanceId)
        const newMetadata: SessionMetadata = {
          id: session.id,
          displayId: session.displayId,
          paneIndex: 0, // Always pane 0 in its own tmux session
          branch: session.branch,
          mode: session.mode,
          worktreePath: session.worktreePath,
          createdAt: session.createdAt.toISOString(),
          tmuxSession: sessionTmuxName, // Store its own tmux session
        }
        existingMetadata.push(newMetadata)
        await saveSessionStore(instanceId, existingMetadata)

        console.log(`[API] Session created: ${session.id}`)

        res.json({
          success: true,
          session: {
            id: session.id,
            displayId: session.displayId,
            branch: session.branch,
            mode: session.mode,
            worktreePath: session.worktreePath,
          },
        })
      } catch (err) {
        console.error('[API] Error creating session:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Register a new instance (add repo to dashboard)
    this.app.post('/api/instances', async (req, res) => {
      try {
        const { repoPath } = req.body as { repoPath: string }

        // Validate input
        if (!repoPath) {
          res.status(400).json({ error: 'repoPath is required' })
          return
        }

        // Resolve to absolute path
        const absolutePath = resolve(repoPath)

        // Check path exists
        if (!existsSync(absolutePath)) {
          res.status(400).json({ error: `Path does not exist: ${absolutePath}` })
          return
        }

        // Check it's a git repository
        // Use spawnSync for safety (avoids shell injection)
        const { spawnSync } = await import('child_process')
        const gitCheck = spawnSync('git', ['-C', absolutePath, 'rev-parse', '--git-dir'], { stdio: 'pipe' })
        if (gitCheck.status !== 0) {
          res.status(400).json({ error: `Not a git repository: ${absolutePath}` })
          return
        }

        // Check not already registered
        const existing = await getInstanceByPath(absolutePath)
        if (existing) {
          res.status(409).json({ error: `Repository already registered as: ${existing.instanceId}` })
          return
        }

        // Register instance (sessionCount=0 initially)
        const instance = await registerInstance(absolutePath, 0)

        // Create tmux session (empty, ready for future sessions)
        const tmux = new TmuxRenderer({ sessionName: instance.tmuxSession })
        if (!tmux.sessionExists()) {
          tmux.createSession()
        }

        console.log(`[API] Instance registered: ${instance.instanceId} (${absolutePath})`)

        res.json({
          success: true,
          instance: {
            instanceId: instance.instanceId,
            repoPath: instance.repoPath,
            tmuxSession: instance.tmuxSession,
            sessionCount: instance.sessionCount,
          },
        })
      } catch (err) {
        console.error('[API] Error creating instance:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Clone a GitHub repo and register as instance
    this.app.post('/api/instances/clone', async (req, res) => {
      try {
        const { githubUrl } = req.body as { githubUrl: string }

        // Validate input
        if (!githubUrl) {
          res.status(400).json({ error: 'githubUrl is required' })
          return
        }

        // Parse GitHub URL to extract owner/repo
        // Supports: https://github.com/owner/repo, github.com/owner/repo, owner/repo
        const urlPatterns = [
          /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/,
          /^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/,
          /^([^/]+)\/([^/]+)$/,
        ]

        let owner: string | null = null
        let repo: string | null = null

        for (const pattern of urlPatterns) {
          const match = githubUrl.match(pattern)
          if (match) {
            owner = match[1]
            repo = match[2]
            break
          }
        }

        if (!owner || !repo) {
          res.status(400).json({ error: `Invalid GitHub URL: ${githubUrl}` })
          return
        }

        // Build clone path
        const cloneBaseDir = '/mnt/c/repos/.workspace/clones'
        const clonePath = join(cloneBaseDir, repo)

        // Ensure base directory exists
        const { mkdir: mkdirAsync } = await import('fs/promises')
        await mkdirAsync(cloneBaseDir, { recursive: true })

        // Check if already cloned
        let cloned = false
        if (!existsSync(clonePath)) {
          // Clone using gh CLI (safer than git clone for auth)
          const { spawnSync } = await import('child_process')
          console.log(`[API] Cloning ${owner}/${repo} to ${clonePath}...`)

          const cloneResult = spawnSync('gh', ['repo', 'clone', `${owner}/${repo}`, clonePath], {
            stdio: 'pipe',
            timeout: 300000, // 5 minute timeout for large repos
          })

          if (cloneResult.status !== 0) {
            const stderr = cloneResult.stderr?.toString() || 'Unknown error'
            console.error(`[API] Clone failed:`, stderr)
            res.status(500).json({ error: `Clone failed: ${stderr.slice(0, 200)}` })
            return
          }

          cloned = true
          console.log(`[API] Clone complete: ${clonePath}`)
        } else {
          console.log(`[API] Repository already exists at ${clonePath}, skipping clone`)
        }

        // Check not already registered (by path)
        const existing = await getInstanceByPath(clonePath)
        if (existing) {
          // Already registered - return it (not an error)
          res.json({
            success: true,
            cloned,
            message: 'Repository already registered',
            instance: {
              instanceId: existing.instanceId,
              repoPath: existing.repoPath,
              tmuxSession: existing.tmuxSession,
              sessionCount: existing.sessionCount,
            },
          })
          return
        }

        // Register instance
        const instance = await registerInstance(clonePath, 0)

        // Create tmux session
        const tmux = new TmuxRenderer({ sessionName: instance.tmuxSession })
        if (!tmux.sessionExists()) {
          tmux.createSession()
        }

        console.log(`[API] Instance registered: ${instance.instanceId} (cloned from ${owner}/${repo})`)

        res.json({
          success: true,
          cloned,
          instance: {
            instanceId: instance.instanceId,
            repoPath: instance.repoPath,
            tmuxSession: instance.tmuxSession,
            sessionCount: instance.sessionCount,
          },
        })
      } catch (err) {
        console.error('[API] Error cloning repository:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '', `http://localhost:${this.port}`)
      const sessionKey = url.searchParams.get('session')
      const tmuxSession = url.searchParams.get('tmux')
      const paneIndexStr = url.searchParams.get('pane')
      const paneIndex = paneIndexStr !== null ? parseInt(paneIndexStr, 10) : undefined

      if (!sessionKey || !tmuxSession) {
        ws.close(1008, 'Missing session or tmux parameter')
        return
      }

      console.log(`[WS] Client connected: ${sessionKey} (tmux=${tmuxSession}, pane=${paneIndex})`)

      // Create PTY attached to specific tmux pane
      const ptyProcess = this.createTmuxPty(tmuxSession, paneIndex)

      if (!ptyProcess) {
        ws.close(1011, 'Failed to create PTY')
        return
      }

      this.ptySessions.set(sessionKey, { pty: ptyProcess, ws })

      // PTY output -> WebSocket
      ptyProcess.onData((data) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'output', data }))
        }
      })

      ptyProcess.onExit(({ exitCode }) => {
        console.log(`[PTY] Session ${sessionKey} exited with code ${exitCode}`)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'exit', code: exitCode }))
        }
        this.ptySessions.delete(sessionKey)
      })

      // WebSocket input -> PTY
      ws.on('message', (message) => {
        try {
          const msg = JSON.parse(message.toString())
          if (msg.type === 'input' && msg.data) {
            ptyProcess.write(msg.data)
          } else if (msg.type === 'resize' && msg.cols && msg.rows) {
            ptyProcess.resize(msg.cols, msg.rows)
          }
        } catch {
          // Raw input fallback
          ptyProcess.write(message.toString())
        }
      })

      ws.on('close', () => {
        console.log(`[WS] Client disconnected: ${sessionKey}`)
        ptyProcess.kill()
        this.ptySessions.delete(sessionKey)
      })

      ws.on('error', (err) => {
        console.error(`[WS] Error for ${sessionKey}:`, err.message)
      })
    })
  }

  private createTmuxPty(tmuxSession: string, paneIndex?: number): pty.IPty | null {
    try {
      // Check if session exists
      try {
        execSync(`tmux has-session -t ${tmuxSession} 2>/dev/null`, { stdio: 'ignore' })
      } catch {
        console.error(`[PTY] Tmux session not found: ${tmuxSession}`)
        return null
      }

      // Target specific pane if index provided, otherwise whole session
      const target = paneIndex !== undefined
        ? `${tmuxSession}:0.${paneIndex}`  // session:window.pane
        : tmuxSession

      // Create PTY that attaches to specific tmux pane
      const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', target], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: process.env.HOME,
        env: { ...process.env, TERM: 'xterm-256color' },
      })

      return ptyProcess
    } catch (err) {
      console.error(`[PTY] Failed to create PTY:`, (err as Error).message)
      return null
    }
  }

  private async getAllSessions(): Promise<SessionInfo[]> {
    const instances = await listInstances()
    const sessions: SessionInfo[] = []

    for (const inst of instances) {
      const statusDir = getStatusDirForInstance(inst.instanceId)
      const monitor = new StatusMonitor({ statusDir })
      await monitor.start()
      const statuses = monitor.getAllStatuses()
      await monitor.stop()

      const metadata = await loadSessionStore(inst.instanceId)

      for (const [sessionId, status] of statuses) {
        const meta = metadata.find(m => m.id === sessionId)
        // Skip sessions without metadata (orphaned status files)
        if (!meta) continue
        // Skip sessions where paneIndex is undefined (legacy data)
        if (meta.paneIndex === undefined) continue

        sessions.push({
          id: sessionId,
          displayId: meta.displayId,
          instanceId: inst.instanceId,
          // UI-created sessions have their own tmux session; CLI-created use instance tmux
          tmuxSession: meta.tmuxSession || inst.tmuxSession,
          paneIndex: meta.paneIndex,
          branch: meta.branch?.replace(/^orcha\//, ''),
          state: status.state,
          message: status.message,
          customName: meta.customName,
        })
      }
    }

    return sessions
  }

  private async getClaudeUsage(): Promise<UsageStats | { error: string }> {
    const statsPath = join(process.env.HOME || '', '.claude', 'stats-cache.json')

    try {
      const { readFile } = await import('fs/promises')
      const data = JSON.parse(await readFile(statsPath, 'utf-8'))

      const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD

      // Find today's activity
      const activity = data.dailyActivity?.find((d: { date: string }) => d.date === today)
      const tokenData = data.dailyModelTokens?.find((d: { date: string }) => d.date === today)

      // Sum tokens across all models
      const tokens = tokenData?.tokensByModel
        ? Object.values(tokenData.tokensByModel as Record<string, number>).reduce(
            (sum: number, t: number) => sum + (t || 0),
            0
          )
        : 0

      return {
        date: today,
        tokens,
        messages: activity?.messageCount || 0,
        sessions: activity?.sessionCount || 0,
      }
    } catch {
      // File missing or unreadable
      return { error: 'Usage stats not available' }
    }
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`Orcha Web Dashboard running at http://localhost:${this.port}`)
        resolve()
      })
    })
  }

  stop(): void {
    // Kill all PTY sessions
    for (const [key, session] of this.ptySessions) {
      session.pty.kill()
      session.ws?.close()
    }
    this.ptySessions.clear()
    this.server.close()
  }
}

// CLI entry point
export async function startWebDashboard(port = 3847, open = true): Promise<void> {
  const server = new WebDashboardServer(port)
  await server.start()

  if (open) {
    // Open in default browser
    const url = `http://localhost:${port}`
    try {
      // Try different openers for different platforms
      const openers = [
        `xdg-open "${url}"`,           // Linux
        `wslview "${url}"`,            // WSL
        `open "${url}"`,               // macOS
        `start "" "${url}"`,           // Windows
      ]

      for (const cmd of openers) {
        try {
          execSync(cmd, { stdio: 'ignore' })
          break
        } catch {
          continue
        }
      }
    } catch {
      console.log(`Open in browser: ${url}`)
    }
  }

  // Keep running until interrupted
  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    server.stop()
    process.exit(0)
  })
}
