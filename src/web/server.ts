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
import { execSync, exec } from 'child_process'
import { existsSync } from 'fs'
import { listInstances, getInstance, getInstanceByPath, registerInstance } from '../core/instance-registry.js'
import { StatusMonitor, getStatusDirForInstance } from '../core/status-monitor.js'
import { loadSessionStore } from '../core/session-store.js'

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
}

interface PtySession {
  pty: pty.IPty
  ws: WebSocket
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

    // API: Kill a session (tmux session)
    this.app.delete('/api/sessions/:sessionKey', async (req, res) => {
      const { sessionKey } = req.params

      try {
        // Close any active PTY connection
        const ptySession = this.ptySessions.get(sessionKey)
        if (ptySession) {
          ptySession.pty.kill()
          ptySession.ws?.close()
          this.ptySessions.delete(sessionKey)
        }

        // Kill the tmux session
        try {
          execSync(`tmux kill-session -t "${sessionKey}"`, { stdio: 'ignore' })
        } catch {
          // Session may already be dead
        }

        res.json({ success: true, message: `Session ${sessionKey} killed` })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Create new session (placeholder - requires orcha CLI integration)
    this.app.use(express.json())
    this.app.post('/api/sessions', async (req, res) => {
      const { action, repo } = req.body

      try {
        if (action === 'new') {
          // Add a new pane to an existing tmux session
          // For now, find the first active instance and add a pane
          const instances = await listInstances()
          if (instances.length === 0) {
            return res.status(400).json({ error: 'No active orcha instances. Start one with: orcha start' })
          }

          const inst = instances[0]
          // Create new pane in the tmux session
          execSync(`tmux split-window -t "${inst.tmuxSession}" -v`, { stdio: 'ignore' })
          execSync(`tmux select-layout -t "${inst.tmuxSession}" tiled`, { stdio: 'ignore' })

          res.json({ success: true, message: 'New pane created' })
        } else if (action === 'repo' && repo) {
          // Clone/create worktree for a repo - would need deeper integration
          res.status(501).json({ error: 'Repo creation via web not yet implemented. Use CLI: orcha add <repo>' })
        } else {
          res.status(400).json({ error: 'Invalid action. Use action: "new" or "repo"' })
        }
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Register a new instance (add local repo to dashboard)
    this.app.post('/api/instances', async (req, res) => {
      try {
        const { repoPath } = req.body as { repoPath: string }

        if (!repoPath) {
          res.status(400).json({ error: 'repoPath is required' })
          return
        }

        const absolutePath = resolve(repoPath)

        if (!existsSync(absolutePath)) {
          res.status(400).json({ error: `Path does not exist: ${absolutePath}` })
          return
        }

        // Check it's a git repository
        const { spawnSync } = await import('child_process')
        const gitCheck = spawnSync('git', ['-C', absolutePath, 'rev-parse', '--git-dir'], { stdio: 'pipe' })
        if (gitCheck.status !== 0) {
          res.status(400).json({ error: `Not a git repository: ${absolutePath}` })
          return
        }

        const existing = await getInstanceByPath(absolutePath)
        if (existing) {
          res.status(409).json({ error: `Repository already registered as: ${existing.instanceId}` })
          return
        }

        const instance = await registerInstance(absolutePath, 0)

        // Create tmux session
        try {
          execSync(`tmux has-session -t "${instance.tmuxSession}" 2>/dev/null`, { stdio: 'ignore' })
        } catch {
          execSync(`tmux new-session -d -s "${instance.tmuxSession}" -x 200 -y 50`, { stdio: 'pipe' })
        }

        console.log(`[API] Instance registered: ${instance.instanceId}`)

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

    // API: Clone from GitHub and register as instance
    this.app.post('/api/instances/clone', async (req, res) => {
      try {
        const { githubUrl } = req.body as { githubUrl: string }

        if (!githubUrl) {
          res.status(400).json({ error: 'githubUrl is required' })
          return
        }

        // Parse GitHub URL
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

        const cloneBaseDir = '/mnt/c/repos/.workspace/clones'
        const clonePath = join(cloneBaseDir, repo)

        const { mkdir: mkdirAsync } = await import('fs/promises')
        await mkdirAsync(cloneBaseDir, { recursive: true })

        let cloned = false
        if (!existsSync(clonePath)) {
          const { spawnSync } = await import('child_process')
          console.log(`[API] Cloning ${owner}/${repo} to ${clonePath}...`)

          const cloneResult = spawnSync('gh', ['repo', 'clone', `${owner}/${repo}`, clonePath], {
            stdio: 'pipe',
            timeout: 300000,
          })

          if (cloneResult.status !== 0) {
            const stderr = cloneResult.stderr?.toString() || 'Unknown error'
            res.status(500).json({ error: `Clone failed: ${stderr.slice(0, 200)}` })
            return
          }

          cloned = true
          console.log(`[API] Clone complete: ${clonePath}`)
        }

        const existing = await getInstanceByPath(clonePath)
        if (existing) {
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

        const instance = await registerInstance(clonePath, 0)

        try {
          execSync(`tmux has-session -t "${instance.tmuxSession}" 2>/dev/null`, { stdio: 'ignore' })
        } catch {
          execSync(`tmux new-session -d -s "${instance.tmuxSession}" -x 200 -y 50`, { stdio: 'pipe' })
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

      if (!sessionKey || !tmuxSession) {
        ws.close(1008, 'Missing session or tmux parameter')
        return
      }

      console.log(`[WS] Client connected: ${sessionKey} (tmux=${tmuxSession})`)

      // Create PTY attached to tmux session (shows all panes via tmux's native layout)
      const ptyProcess = this.createTmuxPty(tmuxSession)

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

  private createTmuxPty(tmuxSession: string): pty.IPty | null {
    try {
      // Check if session exists
      try {
        execSync(`tmux has-session -t ${tmuxSession} 2>/dev/null`, { stdio: 'ignore' })
      } catch {
        console.error(`[PTY] Tmux session not found: ${tmuxSession}`)
        return null
      }

      // Create PTY that attaches to tmux session (shows all panes via tmux's native layout)
      const ptyProcess = pty.spawn('tmux', ['attach-session', '-t', tmuxSession], {
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
          tmuxSession: inst.tmuxSession,
          paneIndex: meta.paneIndex,
          branch: meta.branch?.replace(/^orcha\//, ''),
          state: status.state,
          message: status.message,
        })
      }
    }

    return sessions
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
