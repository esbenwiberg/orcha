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
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { existsSync } from 'fs'
import { listInstances } from '../core/instance-registry.js'
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
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws, req) => {
      const url = new URL(req.url || '', `http://localhost:${this.port}`)
      const sessionKey = url.searchParams.get('session')
      const tmuxSession = url.searchParams.get('tmux')
      const paneIndex = parseInt(url.searchParams.get('pane') || '0', 10)

      if (!sessionKey || !tmuxSession) {
        ws.close(1008, 'Missing session or tmux parameter')
        return
      }

      console.log(`[WS] Client connected: ${sessionKey} (tmux=${tmuxSession}, pane=${paneIndex})`)

      // Create PTY attached to tmux pane
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

  private createTmuxPty(tmuxSession: string, paneIndex: number): pty.IPty | null {
    try {
      // Attach to specific tmux pane
      const target = `${tmuxSession}:0.${paneIndex}`

      // Check if session exists
      try {
        execSync(`tmux has-session -t ${tmuxSession} 2>/dev/null`, { stdio: 'ignore' })
      } catch {
        console.error(`[PTY] Tmux session not found: ${tmuxSession}`)
        return null
      }

      // Create PTY that attaches to tmux session with target pane selected
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

      let paneIdx = 0
      for (const [sessionId, status] of statuses) {
        const meta = metadata.find(m => m.id === sessionId)
        sessions.push({
          id: sessionId,
          displayId: meta?.displayId ?? paneIdx + 1,
          instanceId: inst.instanceId,
          tmuxSession: inst.tmuxSession,
          paneIndex: paneIdx,
          branch: meta?.branch?.replace(/^orcha\//, ''),
          state: status.state,
          message: status.message,
        })
        paneIdx++
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
