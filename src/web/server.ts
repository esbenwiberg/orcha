/**
 * Orcha Web Dashboard Server
 *
 * Provides a web-based multi-terminal interface for orcha sessions.
 * Each terminal panel connects to a tmux pane via WebSocket + PTY.
 */

import express from 'express'
import { createServer, type IncomingMessage } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import * as pty from 'node-pty'
import { join, dirname, resolve, isAbsolute } from 'path'
import { homedir, cpus, totalmem, freemem, uptime, loadavg } from 'os'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync, rmSync } from 'fs'
import type { Socket } from 'net'
import { listInstances, getInstance, getInstanceByPath, registerInstance, unregisterInstance } from '../core/instance-registry.js'
import { StatusMonitor, getStatusDirForInstance, migrateStatusFromLegacyPaths } from '../core/status-monitor.js'
import { loadSessionStore, updateSessionName, saveSessionStore } from '../core/session-store.js'
import type { SessionMetadata } from '../core/session-store.js'
import { SessionManager } from '../core/session-manager.js'
import { WorktreeManager } from '../core/worktree-manager.js'
import { TmuxRenderer } from '../cli/tmux-renderer.js'
import { getProvider, parseRemoteUrl, detectProvider } from '../core/vcs-provider.js'
import type { RepoInfo, BranchSyncInfo } from '../core/types.js'
import { getActions, getAction, createAction, updateAction, deleteAction, executeAction } from '../core/actions-manager.js'
import oidcPkg from 'express-openid-connect'
const { auth, requiresAuth } = oidcPkg
import { randomBytes } from 'crypto'

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
  worktreePath?: string | null // Path to worktree if using worktrees
}

interface PtySession {
  pty: pty.IPty
  ws: WebSocket
}

interface UsageStats {
  totalSessions: number
  totalMessages: number
  cacheReadTokens: number
  firstSessionDate: string
}

export class WebDashboardServer {
  private app = express()
  private server = createServer(this.app)
  private wss: WebSocketServer
  private ptySessions = new Map<string, PtySession>()
  private statusMonitors = new Map<string, StatusMonitor>() // Reusable monitors per instance
  private port: number
  private authEnabled = false

  constructor(port = 3847) {
    this.port = port
    this.wss = new WebSocketServer({ noServer: true })
    this.setupAuth()
    this.setupRoutes()
    this.setupWebSocket()
    this.setupUpgradeHandler()
    this.setupPipelineEvents()
  }

  /**
   * Check if a request is coming from localhost (SSH tunnel)
   */
  private isLocalhost(req: IncomingMessage): boolean {
    const host = req.headers.host || ''
    return host.startsWith('localhost') || host.startsWith('127.0.0.1')
  }

  /**
   * Setup OIDC authentication middleware (skipped for localhost)
   */
  private setupAuth(): void {
    const tenantId = process.env.AZURE_TENANT_ID
    const clientId = process.env.AZURE_CLIENT_ID
    const clientSecret = process.env.AZURE_CLIENT_SECRET
    const baseURL = process.env.ORCHA_BASE_URL

    // Skip auth setup if env vars not configured (dev/local mode)
    if (!tenantId || !clientId || !clientSecret || !baseURL) {
      console.log('[Auth] OIDC not configured (missing env vars) - running without auth')
      return
    }

    const oidcConfig = {
      authRequired: false,
      auth0Logout: false,
      issuerBaseURL: `https://login.microsoftonline.com/${tenantId}/v2.0`,
      baseURL,
      clientID: clientId,
      clientSecret,
      secret: process.env.SESSION_SECRET || randomBytes(32).toString('hex'),
      routes: {
        login: '/auth/login',
        logout: '/auth/logout',
        callback: '/auth/callback',
      },
      session: {
        rollingDuration: 86400,   // 24 hours rolling
        absoluteDuration: 604800, // 7 days absolute max
      },
      authorizationParams: {
        response_type: 'code',
        scope: 'openid profile email',
      },
    }

    this.app.use(auth(oidcConfig))

    // Allowed emails (comma-separated in env var, e.g. "me@company.com,other@company.com")
    const allowedEmails = (process.env.ALLOWED_EMAILS || '')
      .split(',')
      .map(e => e.trim().toLowerCase())
      .filter(Boolean)

    if (allowedEmails.length > 0) {
      console.log(`[Auth] User allowlist enabled: ${allowedEmails.join(', ')}`)
    }

    // Protect all routes except health check, but skip for localhost
    const authMiddleware = (req: any, res: any, next: any) => {
      if (this.isLocalhost(req)) {
        return next()
      }
      return requiresAuth()(req, res, () => {
        // If allowlist is configured, check the user's email
        if (allowedEmails.length > 0) {
          const userEmail = (req.oidc?.user?.email || '').toLowerCase()
          if (!allowedEmails.includes(userEmail)) {
            console.warn(`[Auth] Blocked user: ${userEmail}`)
            return res.status(403).send('Access denied. Your account is not authorized to use this application.')
          }
        }
        next()
      })
    }

    // Protect API routes (except health)
    this.app.use('/api/sessions', authMiddleware)
    this.app.use('/api/status', authMiddleware)
    this.app.use('/api/usage', authMiddleware)
    this.app.use('/api/actions', authMiddleware)
    this.app.use('/api/instances', authMiddleware)
    this.app.use('/api/git', authMiddleware)
    this.app.use('/api/github', authMiddleware)
    this.app.use('/api/batch-issues', authMiddleware)
    this.app.use('/api/upload-image', authMiddleware)
    this.app.use('/api/server', authMiddleware)
    this.app.use('/api/pipelines', authMiddleware)

    // Protect HTML pages (root dashboard and mobile view)
    this.app.get('/', authMiddleware)
    this.app.get('/index.html', authMiddleware)
    this.app.get('/mobile', authMiddleware)
    this.app.get('/mobile.html', authMiddleware)

    this.authEnabled = true
    console.log(`[Auth] OIDC configured with Entra ID (tenant: ${tenantId.substring(0, 8)}...)`)
  }

  /**
   * Handle HTTP upgrade requests for WebSocket with auth
   */
  private setupUpgradeHandler(): void {
    this.server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      // Allow without auth when OIDC is not configured or request is from localhost
      if (!this.authEnabled || this.isLocalhost(req)) {
        this.wss.handleUpgrade(req, socket, head, (ws) => {
          this.wss.emit('connection', ws, req)
        })
        return
      }

      // For remote connections with auth enabled, check for auth cookie
      const cookies = req.headers.cookie || ''
      if (!cookies.includes('appSession')) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }

      // Cookie exists - allow the upgrade (the cookie was validated by OIDC middleware on the page load)
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit('connection', ws, req)
      })
    })
  }

  private setupRoutes(): void {
    // Serve static files from public directory (no cache for HTML to pick up updates)
    const publicDir = resolvePublicDir()
    this.app.use(express.static(publicDir, {
      setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate')
        }
      }
    }))

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

    // API: Get VM health (CPU, memory, uptime)
    this.app.get('/api/health', (_req, res) => {
      try {
        const cpuCount = cpus().length
        const load = loadavg()
        const cpuPercent = Math.min(Math.round((load[0] / cpuCount) * 1000) / 10, 100)
        const memTotalBytes = totalmem()
        const memFreeBytes = freemem()
        const memUsedBytes = memTotalBytes - memFreeBytes
        const memTotal = Math.round((memTotalBytes / (1024 ** 3)) * 10) / 10
        const memUsed = Math.round((memUsedBytes / (1024 ** 3)) * 10) / 10
        const memPercent = Math.round((memUsedBytes / memTotalBytes) * 1000) / 10

        res.json({
          cpu: cpuPercent,
          memUsed,
          memTotal,
          memPercent,
          uptime: Math.round(uptime()),
          loadAvg: load.map(v => Math.round(v * 10) / 10),
        })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // Enable JSON body parsing
    this.app.use(express.json({ limit: '50mb' }))

    // API: Upload image from clipboard paste
    this.app.post('/api/upload-image', (req, res) => {
      try {
        const { data, filename } = req.body as { data?: string; filename?: string }

        if (!data) {
          res.status(400).json({ error: 'data (base64) is required' })
          return
        }

        const imageDir = '/tmp/orcha-images'
        mkdirSync(imageDir, { recursive: true })

        const timestamp = Date.now()
        const random = Math.random().toString(36).slice(2, 8)
        const ext = filename?.split('.').pop() || 'png'
        const outputFilename = `${timestamp}-${random}.${ext}`
        const outputPath = join(imageDir, outputFilename)

        const buffer = Buffer.from(data, 'base64')
        writeFileSync(outputPath, buffer)

        console.log(`[API] Image saved: ${outputPath} (${buffer.length} bytes)`)
        res.json({ path: outputPath })
      } catch (err) {
        console.error('[API] Image upload error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Get all actions
    this.app.get('/api/actions', async (_req, res) => {
      try {
        const actions = await getActions()
        res.json(actions)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Create a new action
    this.app.post('/api/actions', async (req, res) => {
      try {
        const { name, icon, script } = req.body as { name?: string; icon?: string; script?: string }

        // Validate required fields
        if (!name || !icon || !script) {
          res.status(400).json({ error: 'name, icon, and script are required' })
          return
        }

        const action = await createAction(name, icon, script)
        res.json(action)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Update an action
    this.app.put('/api/actions/:id', async (req, res) => {
      try {
        const { id } = req.params
        const { name, icon, script } = req.body as { name?: string; icon?: string; script?: string }

        const action = await updateAction(id, { name, icon, script })

        if (!action) {
          res.status(404).json({ error: 'Action not found' })
          return
        }

        res.json(action)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Delete an action
    this.app.delete('/api/actions/:id', async (req, res) => {
      try {
        const { id } = req.params

        const success = await deleteAction(id)

        if (!success) {
          res.status(404).json({ error: 'Action not found' })
          return
        }

        res.json({ success: true })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Execute an action (creates new tmux session)
    this.app.post('/api/actions/:id/execute', async (req, res) => {
      try {
        const { id } = req.params

        const result = await executeAction(id)

        res.json(result)
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Rename a session
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

    // API: Get plan content for a session
    this.app.get('/api/sessions/:instanceId/:sessionId/plan', async (req, res) => {
      try {
        const { instanceId, sessionId } = req.params

        // Load session metadata to get worktree path
        const metadata = await loadSessionStore(instanceId)
        const session = metadata.find(m => m.id === sessionId)

        if (!session) {
          res.status(404).json({ error: 'Session not found' })
          return
        }

        // Determine base path (worktree or instance repo)
        let basePath = session.worktreePath
        if (!basePath) {
          const instance = await getInstance(instanceId)
          if (!instance) {
            res.status(404).json({ error: 'Instance not found' })
            return
          }
          basePath = instance.repoPath
        }

        // Resolve plan path
        const planPath = this.resolvePlanPath(basePath)
        if (!planPath) {
          res.status(404).json({ error: 'No plan found' })
          return
        }

        // Read plan content
        const content = readFileSync(planPath, 'utf-8')
        res.json({ content, path: planPath })
      } catch (err) {
        console.error('[API] Error reading plan:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Capture terminal pane content (lightweight alternative to WebSocket PTY)
    this.app.get('/api/sessions/:instanceId/:sessionId/capture', async (req, res) => {
      try {
        const { instanceId, sessionId } = req.params
        const lines = parseInt(req.query.lines as string) || 50

        const metadata = await loadSessionStore(instanceId)
        const session = metadata.find(m => m.id === sessionId)

        if (!session) {
          res.status(404).json({ error: 'Session not found' })
          return
        }

        const tmuxName = session.tmuxSession || `orcha-ui-${sessionId}`
        const tmuxTarget = tmuxName.startsWith('orcha-ui-')
          ? `${tmuxName}:0.0`
          : `${tmuxName}:0.${session.paneIndex}`

        const { spawnSync } = await import('child_process')
        const result = spawnSync('tmux', [
          'capture-pane', '-t', tmuxTarget, '-p', '-S', `-${lines}`
        ], { encoding: 'utf-8', timeout: 5000 })

        if (result.status !== 0) {
          res.status(500).json({ error: 'Failed to capture pane content' })
          return
        }

        res.json({ content: result.stdout, lines, timestamp: Date.now() })
      } catch (err) {
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Send input to a session's tmux pane
    this.app.post('/api/sessions/:instanceId/:sessionId/input', async (req, res) => {
      try {
        const { instanceId, sessionId } = req.params
        const { text } = req.body as { text?: string }

        if (text === undefined || text === null) {
          res.status(400).json({ error: 'text is required' })
          return
        }

        const metadata = await loadSessionStore(instanceId)
        const session = metadata.find(m => m.id === sessionId)

        if (!session) {
          res.status(404).json({ error: 'Session not found' })
          return
        }

        const tmuxName = session.tmuxSession || `orcha-ui-${sessionId}`
        const tmuxTarget = tmuxName.startsWith('orcha-ui-')
          ? `${tmuxName}:0.0`
          : `${tmuxName}:0.${session.paneIndex}`

        const { spawnSync } = await import('child_process')

        // Escape special characters for tmux send-keys
        const escaped = text.replace(/"/g, '\\"').replace(/\$/g, '\\$')
        const result = spawnSync('tmux', [
          'send-keys', '-t', tmuxTarget, escaped, 'Enter'
        ], { encoding: 'utf-8', timeout: 5000 })

        if (result.status !== 0) {
          res.status(500).json({ error: 'Failed to send input' })
          return
        }

        res.json({ success: true })
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

        // Remove worktree if exists (unless keepWorktree is requested)
        const keepWorktree = req.query.keepWorktree === 'true'
        if (session.worktreePath && !keepWorktree) {
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
        const { instanceId, branch, mode, useWorktree, sourceBranch } = req.body as {
          instanceId: string
          branch?: string
          mode?: 'claude' | 'gemini' | 'codex' | 'shell'
          useWorktree?: boolean
          sourceBranch?: string
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

        // Ensure tmux session exists (create if needed)
        const tmux = new TmuxRenderer({ sessionName: instance.tmuxSession })
        if (!tmux.sessionExists()) {
          tmux.createSession()
        }

        // Create session manager
        const statusDir = getStatusDirForInstance(instanceId)
        const manager = new SessionManager({ repoPath: instance.repoPath, statusDir })
        await manager.start()

        // Determine branch name (only if using worktrees)
        const shouldUseWorktree = useWorktree !== false // default true
        let sessionBranch: string | undefined = undefined

        if (shouldUseWorktree) {
          sessionBranch = branch?.trim() || undefined
          if (!sessionBranch) {
            // Auto-generate branch name
            const existingMetadata = await loadSessionStore(instanceId)
            const sessionIdx = existingMetadata.length
            const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
            sessionBranch = `orcha/session-${sessionIdx + 1}-${timestamp}`
          }
        }

        const branchDisplay = sessionBranch || '(no worktree)'
        console.log(`[API] Creating session: ${branchDisplay} (mode=${mode || 'claude'})`)

        // Check if an existing worktree can be reused for this branch
        let existingWorktreePath: string | undefined = undefined
        let reusedWorktree = false
        const worktreeManager = sessionBranch ? new WorktreeManager(instance.repoPath) : null
        if (sessionBranch && worktreeManager) {
          const existing = await worktreeManager.findByBranch(sessionBranch)
          if (existing && existing.sessionId) {
            console.log(`[API] Reusing existing worktree for branch "${sessionBranch}" at ${existing.path}`)
            existingWorktreePath = existing.path
            reusedWorktree = true
          }
        }

        // Create session (this creates worktree, or reuses existing one)
        const sessionSourceBranch = sourceBranch?.trim() || undefined
        const session = await manager.createSession({
          branch: sessionBranch,
          sourceBranch: sessionSourceBranch,
          mode: mode || 'claude',
          workingDirectory: instance.repoPath,
          repoPath: instance.repoPath,
          existingWorktreePath,
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

        // Gather branch sync info and echo session info block
        let branchInfo: BranchSyncInfo | undefined
        if (sessionBranch && worktreeManager) {
          try {
            branchInfo = await worktreeManager.getBranchSyncStatus(sessionBranch, workDir, sessionSourceBranch)
          } catch {
            // Non-critical — skip info if git queries fail
          }
        }

        // Build and echo info block into the terminal pane
        if (sessionBranch) {
          // Sanitize strings for safe shell interpolation (strip single quotes)
          const safe = (s: string) => s.replace(/'/g, '')

          const line = '─'.repeat(40)
          const displayNum = `Session #${session.displayId}`
          const header = `─── ${displayNum} ${line.slice(displayNum.length + 5)}`

          // Branch line
          let branchLine = `  Branch:    ${safe(sessionBranch)}`
          if (branchInfo && !branchInfo.existsOnOrigin && branchInfo.baseBranch) {
            branchLine += ` (new, from ${safe(branchInfo.baseBranch)})`
          }

          // Worktree line
          let worktreeLine = `  Worktree:  ${safe(session.worktreePath || workDir)}`
          if (reusedWorktree) {
            worktreeLine += ' (reused)'
          }

          // Origin line
          let originLine = '  Origin:    '
          if (!branchInfo || !branchInfo.existsOnOrigin) {
            originLine += 'branch not on remote'
          } else if (branchInfo.ahead === 0 && branchInfo.behind === 0) {
            originLine += 'up to date with origin'
          } else {
            const parts: string[] = []
            if (branchInfo.ahead > 0) parts.push(`${branchInfo.ahead} ahead`)
            if (branchInfo.behind > 0) parts.push(`${branchInfo.behind} behind`)
            originLine += parts.join(', ')
          }

          const footer = line
          const infoBlock = `${header}\\n${branchLine}\\n${worktreeLine}\\n${originLine}\\n${footer}`
          sessionTmux.runInPane(session.id, `printf '%b\\n' '${infoBlock}'`)
        }

        // Run AI command with environment variables (inline syntax avoids && issues with tmux)
        const cmd = (mode || 'claude') === 'shell' ? '' : (mode || 'claude')
        if (cmd) {
          // Use inline env var syntax: VAR=val command (sets vars just for that command)
          // Note: --dangerously-skip-permissions is only used for batch issue processing, not regular sessions
          const envCmd = `ORCHA_SESSION_ID='${session.id}' ORCHA_STATUS_DIR='${statusDir}' ${cmd}`
          sessionTmux.runInPane(session.id, envCmd)
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
          reusedWorktree,
          branchInfo,
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

    // API: List all registered instances
    this.app.get('/api/instances', async (_req, res) => {
      try {
        const instances = await listInstances()
        res.json({ instances })
      } catch (err) {
        console.error('[API] Error listing instances:', err)
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

        // Expand tilde to home directory
        let absolutePath = repoPath
        if (repoPath.startsWith('~/')) {
          absolutePath = join(homedir(), repoPath.slice(2))
        } else if (repoPath === '~') {
          absolutePath = homedir()
        } else if (!isAbsolute(repoPath)) {
          // Reject relative paths - don't resolve against cwd
          res.status(400).json({ error: 'Please enter an absolute path (starting with / or ~)' })
          return
        }

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

        // Check if already registered - reuse existing instance
        const existing = await getInstanceByPath(absolutePath)
        if (existing) {
          // Ensure tmux session exists (may have been killed)
          const tmux = new TmuxRenderer({ sessionName: existing.tmuxSession })
          if (!tmux.sessionExists()) {
            tmux.createSession()
          }

          console.log(`[API] Reusing existing instance: ${existing.instanceId} (${absolutePath})`)
          res.json({
            success: true,
            existing: true,
            instance: {
              instanceId: existing.instanceId,
              repoPath: existing.repoPath,
              tmuxSession: existing.tmuxSession,
              sessionCount: existing.sessionCount,
            },
          })
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

    // API: Clone a repository and register as instance
    // Supports GitHub, Azure DevOps, and generic git URLs
    // API: Remove an empty instance (no sessions)
    this.app.delete('/api/instances/:instanceId', async (req, res) => {
      try {
        const { instanceId } = req.params

        // Get instance info
        const instance = await getInstance(instanceId)
        if (!instance) {
          res.status(404).json({ error: 'Instance not found' })
          return
        }

        // Check if instance has sessions
        const metadata = await loadSessionStore(instanceId)
        if (metadata.length > 0) {
          res.status(400).json({ error: 'Cannot remove instance with active sessions. Please close all sessions first.' })
          return
        }

        // Kill tmux session if exists (the empty container session)
        try {
          execSync(`tmux kill-session -t "${instance.tmuxSession}" 2>/dev/null`, { stdio: 'ignore' })
        } catch {
          // Tmux session may already be gone
        }

        // Unregister instance from registry
        await unregisterInstance(instanceId)

        console.log(`[API] Instance removed: ${instanceId}`)
        res.json({ success: true })
      } catch (err) {
        console.error('[API] Error removing instance:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Clone a GitHub repo and register as instance
    this.app.post('/api/instances/clone', async (req, res) => {
      try {
        // Accept both 'githubUrl' (legacy) and 'repoUrl' (new)
        const { githubUrl, repoUrl } = req.body as { githubUrl?: string; repoUrl?: string }
        const inputUrl = repoUrl || githubUrl

        // Validate input
        if (!inputUrl) {
          res.status(400).json({ error: 'repoUrl is required' })
          return
        }

        // Parse the URL using VCS provider abstraction
        const repoInfo = parseRemoteUrl(inputUrl)

        // Also support shorthand formats:
        // - owner/repo for GitHub
        // - org/project/repo for Azure DevOps
        let finalRepoInfo = repoInfo
        if (!repoInfo) {
          // Try shorthand: org/project/repo (Azure DevOps)
          const adoShorthandMatch = inputUrl.match(/^([^/]+)\/([^/]+)\/([^/]+)$/)
          if (adoShorthandMatch) {
            const [, org, project, repo] = adoShorthandMatch
            finalRepoInfo = {
              type: 'azure-devops' as const,
              owner: org,
              project,
              repo: repo.replace(/\.git$/, ''),
              remoteUrl: `https://dev.azure.com/${org}/${project}/_git/${repo}`,
            }
          } else {
            // Try shorthand: owner/repo (GitHub)
            const ghShorthandMatch = inputUrl.match(/^([^/]+)\/([^/]+)$/)
            if (ghShorthandMatch) {
              const [, owner, repo] = ghShorthandMatch
              finalRepoInfo = {
                type: 'github' as const,
                owner,
                repo: repo.replace(/\.git$/, ''),
                remoteUrl: `https://github.com/${owner}/${repo}`,
              }
            }
          }
        }

        if (!finalRepoInfo) {
          res.status(400).json({ error: `Could not parse repository URL: ${inputUrl}` })
          return
        }

        // Get provider for clone URL generation
        const provider = getProvider(finalRepoInfo.remoteUrl)
        const cloneUrl = provider?.getCloneUrl(finalRepoInfo) || finalRepoInfo.remoteUrl

        // Build clone path - use project prefix for Azure DevOps to avoid collisions
        // Use ORCHA_CLONE_DIR env var, or default to ~/repos/orcha-clones
        const cloneBaseDir = process.env.ORCHA_CLONE_DIR || join(homedir(), 'repos', 'orcha-clones')
        const cloneDirName = finalRepoInfo.repo
        const clonePath = join(cloneBaseDir, cloneDirName)

        // Ensure base directory exists
        const { mkdir: mkdirAsync } = await import('fs/promises')
        await mkdirAsync(cloneBaseDir, { recursive: true })

        // Check if already cloned
        let cloned = false
        if (!existsSync(clonePath)) {
          const { spawnSync } = await import('child_process')
          const repoSlug = finalRepoInfo.owner
            ? finalRepoInfo.project
              ? `${finalRepoInfo.owner}/${finalRepoInfo.project}/${finalRepoInfo.repo}`
              : `${finalRepoInfo.owner}/${finalRepoInfo.repo}`
            : finalRepoInfo.repo

          // Use gh CLI for GitHub (handles auth better), git clone for others
          if (finalRepoInfo.type === 'github' && finalRepoInfo.owner) {
            console.log(`[API] Cloning ${repoSlug} via gh CLI to ${clonePath}...`)
            const cloneResult = spawnSync('gh', ['repo', 'clone', `${finalRepoInfo.owner}/${finalRepoInfo.repo}`, clonePath], {
              stdio: 'pipe',
              timeout: 300000, // 5 minute timeout for large repos
            })

            if (cloneResult.status !== 0) {
              const ghStderr = cloneResult.stderr?.toString() || 'Unknown error'
              console.warn(`[API] gh clone failed (${ghStderr.slice(0, 100)}), falling back to git clone...`)

              // Clean up any partial directory gh may have created
              if (existsSync(clonePath)) {
                rmSync(clonePath, { recursive: true, force: true })
              }

              // Fall back to git clone with SSH - gh uses GraphQL which may lack org access,
              // and gh as credential helper causes HTTPS to fail the same way
              const sshUrl = `git@github.com:${finalRepoInfo.owner}/${finalRepoInfo.repo}.git`
              console.log(`[API] Trying SSH clone: ${sshUrl}`)
              const sshResult = spawnSync('git', ['clone', sshUrl, clonePath], {
                stdio: 'pipe',
                timeout: 300000,
              })

              if (sshResult.status !== 0) {
                const sshStderr = sshResult.stderr?.toString() || ''
                console.warn(`[API] SSH clone failed (${sshStderr.slice(0, 100)}), trying HTTPS...`)

                // Clean up again before HTTPS attempt
                if (existsSync(clonePath)) {
                  rmSync(clonePath, { recursive: true, force: true })
                }

                // Try HTTPS as last resort (may work if gh credential helper isn't set up)
                const gitResult = spawnSync('git', ['clone', cloneUrl, clonePath], {
                  stdio: 'pipe',
                  timeout: 300000,
                })

                if (gitResult.status !== 0) {
                  const stderr = gitResult.stderr?.toString() || 'Unknown error'
                  console.error(`[API] All clone methods failed for ${repoSlug}`)
                  res.status(500).json({ error: `Clone failed. gh: ${ghStderr.slice(0, 100)}. git SSH: ${sshStderr.slice(0, 100)}. git HTTPS: ${stderr.slice(0, 100)}` })
                  return
                }
              }
            }
          } else {
            // Use git clone for Azure DevOps and other providers
            console.log(`[API] Cloning ${repoSlug} via git clone to ${clonePath}...`)
            const cloneResult = spawnSync('git', ['clone', cloneUrl, clonePath], {
              stdio: 'pipe',
              timeout: 300000, // 5 minute timeout for large repos
            })

            if (cloneResult.status !== 0) {
              const stderr = cloneResult.stderr?.toString() || 'Unknown error'
              console.error(`[API] Clone failed:`, stderr)
              res.status(500).json({ error: `Clone failed: ${stderr.slice(0, 200)}` })
              return
            }
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
              providerType: existing.providerType || finalRepoInfo.type,
            },
          })
          return
        }

        // Register instance (provider detection happens automatically in registerInstance)
        const instance = await registerInstance(clonePath, 0)

        // Create tmux session
        const tmux = new TmuxRenderer({ sessionName: instance.tmuxSession })
        if (!tmux.sessionExists()) {
          tmux.createSession()
        }

        const repoSlug = finalRepoInfo.owner
          ? finalRepoInfo.project
            ? `${finalRepoInfo.owner}/${finalRepoInfo.project}/${finalRepoInfo.repo}`
            : `${finalRepoInfo.owner}/${finalRepoInfo.repo}`
          : finalRepoInfo.repo

        console.log(`[API] Instance registered: ${instance.instanceId} (cloned from ${repoSlug})`)

        res.json({
          success: true,
          cloned,
          instance: {
            instanceId: instance.instanceId,
            repoPath: instance.repoPath,
            tmuxSession: instance.tmuxSession,
            sessionCount: instance.sessionCount,
            providerType: instance.providerType,
          },
        })
      } catch (err) {
        console.error('[API] Error cloning repository:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // =========================================================================
    // Git Actions API
    // =========================================================================

    // Helper to execute git commands in a repo
    const executeGit = async (instanceId: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> => {
      const instance = await getInstance(instanceId)
      if (!instance) {
        throw new Error(`Instance not found: ${instanceId}`)
      }

      const { spawnSync } = await import('child_process')
      const result = spawnSync('git', args, {
        cwd: instance.repoPath,
        encoding: 'utf-8',
        timeout: 60000,
      })

      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        code: result.status ?? 1,
      }
    }

    // API: Get git status for an instance
    this.app.post('/api/git/status', async (req, res) => {
      try {
        const { instanceId } = req.body as { instanceId: string }

        if (!instanceId) {
          res.status(400).json({ error: 'instanceId is required' })
          return
        }

        const instance = await getInstance(instanceId)
        if (!instance) {
          res.status(404).json({ error: `Instance not found: ${instanceId}` })
          return
        }

        // Get current branch
        const branchResult = await executeGit(instanceId, ['branch', '--show-current'])
        const branch = branchResult.stdout.trim() || 'HEAD'

        // Check for uncommitted changes
        const statusResult = await executeGit(instanceId, ['status', '--porcelain'])
        const hasChanges = statusResult.stdout.trim().length > 0

        // Get ahead/behind count
        let ahead = 0
        let behind = 0
        try {
          const trackingResult = await executeGit(instanceId, ['rev-list', '--left-right', '--count', `@{upstream}...HEAD`])
          const parts = trackingResult.stdout.trim().split(/\s+/)
          if (parts.length === 2) {
            behind = parseInt(parts[0], 10) || 0
            ahead = parseInt(parts[1], 10) || 0
          }
        } catch {
          // No upstream tracking branch
        }

        // Check if gh CLI is available
        const { spawnSync } = await import('child_process')
        const ghCheck = spawnSync('which', ['gh'], { encoding: 'utf-8' })
        const hasGh = ghCheck.status === 0

        // Detect VCS provider type
        let providerType: string = 'generic'
        let hasGitHubRemote = false
        let repoInfo: RepoInfo | null = null
        try {
          const remoteResult = await executeGit(instanceId, ['remote', 'get-url', 'origin'])
          if (remoteResult.code === 0) {
            const remoteUrl = remoteResult.stdout.trim()
            providerType = detectProvider(remoteUrl)
            repoInfo = parseRemoteUrl(remoteUrl)
            hasGitHubRemote = providerType === 'github'
          }
        } catch {
          // No origin remote
        }

        // Get the provider to check capabilities
        const provider = repoInfo ? getProvider(repoInfo.remoteUrl) : null
        const workItemLabel = provider?.getWorkItemLabel() || 'Issue'
        const prLabel = provider?.getPrLabel() || 'Pull Request'

        // Get commits since main/master for PR description
        let commits: Array<{ hash: string; message: string }> = []
        try {
          // Try origin/main first, then origin/master
          let baseBranch = 'origin/main'
          const mainCheck = await executeGit(instanceId, ['rev-parse', '--verify', 'origin/main'])
          if (mainCheck.code !== 0) {
            baseBranch = 'origin/master'
          }

          // Get commit log since base branch
          const logResult = await executeGit(instanceId, ['log', `${baseBranch}..HEAD`, '--pretty=format:%h|%s', '--reverse'])
          if (logResult.code === 0 && logResult.stdout.trim()) {
            commits = logResult.stdout.trim().split('\n').map(line => {
              const [hash, ...messageParts] = line.split('|')
              return { hash, message: messageParts.join('|') }
            })
          }
        } catch {
          // Couldn't get commits - not critical
        }

        res.json({
          branch,
          hasChanges,
          ahead,
          behind,
          hasGh,
          hasGitHubRemote,
          commits,
          // New provider-aware fields
          providerType,
          workItemLabel,
          prLabel,
          repoInfo,
        })
      } catch (err) {
        console.error('[API] Git status error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Stage all and commit
    this.app.post('/api/git/commit', async (req, res) => {
      try {
        const { instanceId, message } = req.body as { instanceId: string; message: string }

        if (!instanceId || !message) {
          res.status(400).json({ error: 'instanceId and message are required' })
          return
        }

        // Stage all changes
        const addResult = await executeGit(instanceId, ['add', '-A'])
        if (addResult.code !== 0) {
          res.status(500).json({ error: `Failed to stage changes: ${addResult.stderr}` })
          return
        }

        // Commit
        const commitResult = await executeGit(instanceId, ['commit', '-m', message])
        if (commitResult.code !== 0) {
          // Check if it's "nothing to commit"
          if (commitResult.stdout.includes('nothing to commit') || commitResult.stderr.includes('nothing to commit')) {
            res.status(400).json({ error: 'Nothing to commit' })
            return
          }
          res.status(500).json({ error: `Commit failed: ${commitResult.stderr || commitResult.stdout}` })
          return
        }

        // Get the commit hash
        const hashResult = await executeGit(instanceId, ['rev-parse', '--short', 'HEAD'])
        const commitHash = hashResult.stdout.trim()

        console.log(`[API] Committed ${commitHash} in ${instanceId}`)
        res.json({ success: true, commitHash, output: commitResult.stdout })
      } catch (err) {
        console.error('[API] Git commit error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Push to origin
    this.app.post('/api/git/push', async (req, res) => {
      try {
        const { instanceId } = req.body as { instanceId: string }

        if (!instanceId) {
          res.status(400).json({ error: 'instanceId is required' })
          return
        }

        const pushResult = await executeGit(instanceId, ['push'])
        if (pushResult.code !== 0) {
          // Try push with set-upstream if no tracking branch
          if (pushResult.stderr.includes('no upstream branch')) {
            const branchResult = await executeGit(instanceId, ['branch', '--show-current'])
            const branch = branchResult.stdout.trim()
            const pushUpstreamResult = await executeGit(instanceId, ['push', '-u', 'origin', branch])
            if (pushUpstreamResult.code !== 0) {
              res.status(500).json({ error: `Push failed: ${pushUpstreamResult.stderr}` })
              return
            }
            console.log(`[API] Pushed ${branch} with upstream in ${instanceId}`)
            res.json({ success: true, output: pushUpstreamResult.stderr || pushUpstreamResult.stdout })
            return
          }
          res.status(500).json({ error: `Push failed: ${pushResult.stderr}` })
          return
        }

        console.log(`[API] Pushed in ${instanceId}`)
        res.json({ success: true, output: pushResult.stderr || pushResult.stdout || 'Push successful' })
      } catch (err) {
        console.error('[API] Git push error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Git pull (from upstream tracking branch)
    this.app.post('/api/git/pull', async (req, res) => {
      try {
        const { instanceId } = req.body as { instanceId: string }

        if (!instanceId) {
          res.status(400).json({ error: 'instanceId is required' })
          return
        }

        const pullResult = await executeGit(instanceId, ['pull'])

        if (pullResult.code !== 0) {
          if (pullResult.stdout.includes('CONFLICT') || pullResult.stderr.includes('CONFLICT')) {
            res.status(409).json({
              error: 'Merge conflict detected. Please resolve manually in the terminal.',
              output: pullResult.stdout,
            })
            return
          }
          res.status(500).json({ error: `Pull failed: ${pullResult.stderr || pullResult.stdout}` })
          return
        }

        console.log(`[API] Git pull in ${instanceId}`)
        res.json({ success: true, output: pullResult.stdout || 'Already up to date' })
      } catch (err) {
        console.error('[API] Git pull error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Fetch origin and merge main
    this.app.post('/api/git/pull-main', async (req, res) => {
      try {
        const { instanceId } = req.body as { instanceId: string }

        if (!instanceId) {
          res.status(400).json({ error: 'instanceId is required' })
          return
        }

        // Fetch origin
        const fetchResult = await executeGit(instanceId, ['fetch', 'origin'])
        if (fetchResult.code !== 0) {
          res.status(500).json({ error: `Fetch failed: ${fetchResult.stderr}` })
          return
        }

        // Try to merge origin/main, fallback to origin/master
        let mergeResult = await executeGit(instanceId, ['merge', 'origin/main', '--no-edit'])
        if (mergeResult.code !== 0 && mergeResult.stderr.includes("'origin/main'")) {
          // Try origin/master
          mergeResult = await executeGit(instanceId, ['merge', 'origin/master', '--no-edit'])
        }

        if (mergeResult.code !== 0) {
          // Check for merge conflicts
          if (mergeResult.stdout.includes('CONFLICT') || mergeResult.stderr.includes('CONFLICT')) {
            res.status(409).json({
              error: 'Merge conflict detected. Please resolve manually in the terminal.',
              output: mergeResult.stdout,
            })
            return
          }
          res.status(500).json({ error: `Merge failed: ${mergeResult.stderr || mergeResult.stdout}` })
          return
        }

        console.log(`[API] Merged origin/main in ${instanceId}`)
        res.json({ success: true, output: mergeResult.stdout || 'Already up to date' })
      } catch (err) {
        console.error('[API] Git pull-main error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Create pull request using VCS provider
    this.app.post('/api/git/create-pr', async (req, res) => {
      try {
        const { instanceId, title, body } = req.body as { instanceId: string; title: string; body: string }

        if (!instanceId || !title) {
          res.status(400).json({ error: 'instanceId and title are required' })
          return
        }

        const instance = await getInstance(instanceId)
        if (!instance) {
          res.status(404).json({ error: `Instance not found: ${instanceId}` })
          return
        }

        // Get remote URL and detect provider
        const remoteResult = await executeGit(instanceId, ['remote', 'get-url', 'origin'])
        if (remoteResult.code !== 0) {
          res.status(400).json({ error: 'Repository has no origin remote' })
          return
        }

        const remoteUrl = remoteResult.stdout.trim()
        const repoInfo = parseRemoteUrl(remoteUrl)
        if (!repoInfo) {
          res.status(400).json({ error: 'Could not parse remote URL' })
          return
        }

        const provider = getProvider(remoteUrl)
        if (!provider) {
          res.status(400).json({ error: 'No provider available for this repository type' })
          return
        }

        // Get current branch for source
        const branchResult = await executeGit(instanceId, ['branch', '--show-current'])
        const sourceBranch = branchResult.stdout.trim()

        // Determine target branch (main or master)
        let targetBranch = 'main'
        const mainCheck = await executeGit(instanceId, ['rev-parse', '--verify', 'origin/main'])
        if (mainCheck.code !== 0) {
          targetBranch = 'master'
        }

        // Create PR using provider
        const result = await provider.createPullRequest({
          title,
          body,
          sourceBranch,
          targetBranch,
          repoPath: instance.repoPath,
          repoInfo,
        })

        if (!result.success) {
          const errorMsg = result.error || 'Unknown error'
          // Check for common issues
          if (errorMsg.includes('no commits between')) {
            res.status(400).json({ error: 'No commits to create a PR from. Push your commits first.' })
            return
          }
          if (errorMsg.includes('already exists')) {
            res.status(409).json({ error: 'A pull request already exists for this branch.' })
            return
          }
          res.status(500).json({ error: `Failed to create PR: ${errorMsg}` })
          return
        }

        console.log(`[API] Created PR: ${result.prUrl}`)
        res.json({ success: true, prUrl: result.prUrl, prNumber: result.prNumber })
      } catch (err) {
        console.error('[API] Git create-pr error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // =========================================================================
    // Work Items / Issues API (Provider-aware)
    // =========================================================================

    // API: Get diff for pre-review (all changes since diverging from main)
    this.app.post('/api/git/diff', async (req, res) => {
      try {
        const { instanceId } = req.body as { instanceId: string }

        if (!instanceId) {
          res.status(400).json({ error: 'instanceId is required' })
          return
        }

        const instance = await getInstance(instanceId)
        if (!instance) {
          res.status(404).json({ error: `Instance not found: ${instanceId}` })
          return
        }

        // Get current branch
        const branchResult = await executeGit(instanceId, ['branch', '--show-current'])
        const branch = branchResult.stdout.trim() || 'HEAD'

        // Try to find merge-base with origin/main or origin/master
        let baseBranch = 'origin/main'
        let mergeBase = ''

        const mainCheck = await executeGit(instanceId, ['rev-parse', '--verify', 'origin/main'])
        if (mainCheck.code !== 0) {
          const masterCheck = await executeGit(instanceId, ['rev-parse', '--verify', 'origin/master'])
          if (masterCheck.code === 0) {
            baseBranch = 'origin/master'
          } else {
            // No remote main/master, just show uncommitted changes
            baseBranch = ''
          }
        }

        // Get merge base if we have a base branch
        if (baseBranch) {
          const mergeBaseResult = await executeGit(instanceId, ['merge-base', baseBranch, 'HEAD'])
          if (mergeBaseResult.code === 0) {
            mergeBase = mergeBaseResult.stdout.trim()
          }
        }

        // Get commits on branch since diverging
        const commits: Array<{ hash: string; message: string }> = []
        if (mergeBase) {
          const logResult = await executeGit(instanceId, ['log', `${mergeBase}..HEAD`, '--pretty=format:%h|%s', '--reverse'])
          if (logResult.code === 0 && logResult.stdout.trim()) {
            for (const line of logResult.stdout.trim().split('\n')) {
              const [hash, ...msgParts] = line.split('|')
              commits.push({ hash, message: msgParts.join('|') })
            }
          }
        }

        // Get file list with status - full PR preview (all branch changes + uncommitted)
        const files: Array<{ path: string; status: string; committed: boolean }> = []

        // First get committed changes on branch
        if (mergeBase) {
          const committedFilesResult = await executeGit(instanceId, ['diff', '--name-status', `${mergeBase}...HEAD`])
          if (committedFilesResult.code === 0 && committedFilesResult.stdout.trim()) {
            for (const line of committedFilesResult.stdout.trim().split('\n')) {
              const [status, ...pathParts] = line.split('\t')
              const path = pathParts.join('\t') // Handle paths with tabs (rare)
              if (path) {
                files.push({ path, status: status[0], committed: true })
              }
            }
          }
        }

        // Then add uncommitted changes (working directory + staged)
        const uncommittedResult = await executeGit(instanceId, ['status', '--porcelain'])
        if (uncommittedResult.code === 0 && uncommittedResult.stdout.trim()) {
          for (const line of uncommittedResult.stdout.trim().split('\n')) {
            const status = line.slice(0, 2).trim()
            const path = line.slice(3)
            // Map git status to single-char
            let statusChar = 'M'
            if (status.includes('A') || status === '??') statusChar = 'A'
            else if (status.includes('D')) statusChar = 'D'
            else if (status.includes('R')) statusChar = 'R'

            // Check if already in files list (committed)
            const existing = files.find(f => f.path === path)
            if (existing) {
              // Mark as having uncommitted changes
              existing.committed = false
            } else {
              files.push({ path, status: statusChar, committed: false })
            }
          }
        }

        // Filter out directories - only keep actual files
        const filteredFiles: Array<{ path: string; status: string; committed: boolean }> = []
        for (const file of files) {
          const fullPath = join(instance.repoPath, file.path)
          try {
            // Check if path exists and is not a directory
            if (existsSync(fullPath)) {
              const stat = statSync(fullPath)
              if (!stat.isDirectory()) {
                filteredFiles.push(file)
              }
            } else {
              // File doesn't exist (deleted file) - include it
              filteredFiles.push(file)
            }
          } catch (err) {
            // If we can't stat it, include it anyway (might be deleted, etc.)
            filteredFiles.push(file)
          }
        }
        // Replace files array with filtered version
        files.length = 0
        files.push(...filteredFiles)

        // Get full diff (PR preview = all branch changes + uncommitted)
        let diff = ''
        if (mergeBase) {
          // Full diff from merge base to working directory
          const diffResult = await executeGit(instanceId, ['diff', mergeBase])
          if (diffResult.code === 0) {
            diff = diffResult.stdout
          }
        } else {
          // Just uncommitted changes
          const diffResult = await executeGit(instanceId, ['diff', 'HEAD'])
          if (diffResult.code === 0) {
            diff = diffResult.stdout
          }
        }

        // Add diffs for untracked/new files (git diff doesn't include them)
        const untrackedFiles = files.filter(f => f.status === 'A' && !f.committed)
        for (const file of untrackedFiles) {
          // Check if file is already in the diff (staged files will be)
          if (!diff.includes(`+++ b/${file.path}`)) {
            // Generate diff for untracked file by comparing /dev/null to the file
            const fileContentResult = await executeGit(instanceId, ['diff', '--no-index', '/dev/null', file.path])
            // git diff --no-index returns exit code 1 when files differ, which is expected
            if (fileContentResult.stdout) {
              // Replace /dev/null path with proper a/ prefix to match standard diff format
              let fileDiff = fileContentResult.stdout
              fileDiff = fileDiff.replace('--- /dev/null', `--- /dev/null`)
              fileDiff = fileDiff.replace(`+++ b/${file.path}`, `+++ b/${file.path}`)
              // Add a separator if we already have diff content
              if (diff) diff += '\n'
              diff += fileDiff
            }
          }
        }

        // Add diffs for deleted files that aren't staged
        const deletedFiles = files.filter(f => f.status === 'D' && !f.committed)
        for (const file of deletedFiles) {
          // Check if file is already in the diff
          if (!diff.includes(`--- a/${file.path}`)) {
            // Generate diff by showing the file content from HEAD as all deletions
            const fileContentResult = await executeGit(instanceId, ['show', `HEAD:${file.path}`])
            if (fileContentResult.code === 0) {
              // Manually create a diff showing the entire file as deleted
              const lines = fileContentResult.stdout.split('\n')
              let fileDiff = `diff --git a/${file.path} b/${file.path}\n`
              fileDiff += `deleted file mode 100644\n`
              fileDiff += `--- a/${file.path}\n`
              fileDiff += `+++ /dev/null\n`
              fileDiff += `@@ -1,${lines.length} +0,0 @@\n`
              fileDiff += lines.map(line => `-${line}`).join('\n')
              // Add a separator if we already have diff content
              if (diff) diff += '\n'
              diff += fileDiff
            }
          }
        }

        // Get stats
        let stats = { files: 0, insertions: 0, deletions: 0 }
        if (mergeBase) {
          const statResult = await executeGit(instanceId, ['diff', '--stat', mergeBase])
          if (statResult.code === 0) {
            // Parse last line: "X files changed, Y insertions(+), Z deletions(-)"
            const lines = statResult.stdout.trim().split('\n')
            const lastLine = lines[lines.length - 1]
            const filesMatch = lastLine.match(/(\d+) files? changed/)
            const insertMatch = lastLine.match(/(\d+) insertions?\(\+\)/)
            const deleteMatch = lastLine.match(/(\d+) deletions?\(-\)/)
            stats = {
              files: filesMatch ? parseInt(filesMatch[1], 10) : files.length,
              insertions: insertMatch ? parseInt(insertMatch[1], 10) : 0,
              deletions: deleteMatch ? parseInt(deleteMatch[1], 10) : 0,
            }
          }
        }

        res.json({
          branch,
          baseBranch: baseBranch || 'HEAD',
          commits,
          files,
          diff,
          stats,
        })
      } catch (err) {
        console.error('[API] Git diff error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Fetch GitHub issues for validation/preview
    // API: Fetch work items/issues for validation/preview
    // Supports both GitHub issues and Azure DevOps work items via provider abstraction
    this.app.get('/api/github/issues', async (req, res) => {
      try {
        const { instanceId, numbers } = req.query as { instanceId?: string; numbers?: string }

        if (!instanceId || !numbers) {
          res.status(400).json({ error: 'instanceId and numbers are required' })
          return
        }

        const instance = await getInstance(instanceId)
        if (!instance) {
          res.status(404).json({ error: `Instance not found: ${instanceId}` })
          return
        }

        // Parse issue/work item numbers
        const itemNumbers = numbers.split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n))
        if (itemNumbers.length === 0) {
          res.status(400).json({ error: 'No valid issue/work item numbers provided' })
          return
        }

        // Get remote URL and detect provider
        const remoteResult = await executeGit(instanceId, ['remote', 'get-url', 'origin'])
        if (remoteResult.code !== 0) {
          res.status(400).json({ error: 'Repository has no origin remote' })
          return
        }

        const remoteUrl = remoteResult.stdout.trim()
        const repoInfo = parseRemoteUrl(remoteUrl)
        if (!repoInfo) {
          res.status(400).json({ error: 'Could not parse remote URL' })
          return
        }

        const provider = getProvider(remoteUrl)
        if (!provider) {
          res.status(400).json({ error: 'No provider available for this repository type' })
          return
        }

        // Fetch work items using provider
        const workItems = await provider.listWorkItems(itemNumbers, repoInfo)

        // Build response - map to expected format and track errors
        const issues: Array<{ number: number; title: string; url: string; state: string; type?: string }> = []
        const errors: Array<{ number: number; error: string }> = []

        // Check which items were found
        const foundIds = new Set(workItems.map(w => w.id))
        for (const num of itemNumbers) {
          if (!foundIds.has(num)) {
            errors.push({ number: num, error: `${provider.getWorkItemLabel()} not found` })
          }
        }

        // Map work items to response format
        for (const item of workItems) {
          issues.push({
            number: item.id,
            title: item.title,
            url: item.url,
            state: item.state,
            type: item.type,
          })
        }

        const repoSlug = repoInfo.owner
          ? repoInfo.project
            ? `${repoInfo.owner}/${repoInfo.project}/${repoInfo.repo}`
            : `${repoInfo.owner}/${repoInfo.repo}`
          : repoInfo.repo

        console.log(`[API] Fetched ${issues.length} ${provider.getWorkItemLabel().toLowerCase()}s for ${repoSlug}`)
        res.json({
          issues,
          errors,
          repo: repoSlug,
          providerType: repoInfo.type,
          workItemLabel: provider.getWorkItemLabel(),
        })
      } catch (err) {
        console.error('[API] Work items error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Batch process issues/work items - create sessions with /flow command
    // Supports both GitHub issues and Azure DevOps work items via provider abstraction
    this.app.post('/api/batch-issues', async (req, res) => {
      try {
        const { instanceId, issues, skipPermissions = true, startupCommand = '/flow-auto' } = req.body as {
          instanceId: string
          issues: Array<{ number: number; owner?: string; repo?: string; project?: string; url?: string }>
          skipPermissions?: boolean
          startupCommand?: string
        }

        // Validate startupCommand (must start with /)
        const safeStartupCommand = startupCommand.startsWith('/') ? startupCommand : '/flow-auto'

        if (!instanceId || !issues || !Array.isArray(issues) || issues.length === 0) {
          res.status(400).json({ error: 'instanceId and non-empty issues array are required' })
          return
        }

        const instance = await getInstance(instanceId)
        if (!instance) {
          res.status(404).json({ error: `Instance not found: ${instanceId}` })
          return
        }

        // Get remote URL and detect provider type
        const remoteResult = await executeGit(instanceId, ['remote', 'get-url', 'origin'])
        let repoInfo: RepoInfo | null = null
        let providerType = 'generic'

        if (remoteResult.code === 0) {
          const remoteUrl = remoteResult.stdout.trim()
          providerType = detectProvider(remoteUrl)
          repoInfo = parseRemoteUrl(remoteUrl)
        }

        // Ensure tmux session exists
        const tmux = new TmuxRenderer({ sessionName: instance.tmuxSession })
        if (!tmux.sessionExists()) {
          tmux.createSession()
        }

        const statusDir = getStatusDirForInstance(instanceId)
        const createdSessions: Array<{ id: string; issueNumber: number; branch: string }> = []
        const errors: Array<{ issueNumber: number; error: string }> = []

        // Process each issue/work item
        for (const issue of issues) {
          try {
            // Build issue/work item URL based on provider type
            let itemUrl: string
            let branchPrefix: string

            if (providerType === 'azure-devops' && repoInfo?.owner && repoInfo?.project) {
              // Azure DevOps work item URL
              itemUrl = issue.url || `https://dev.azure.com/${repoInfo.owner}/${repoInfo.project}/_workitems/edit/${issue.number}`
              branchPrefix = 'fix/workitem'
            } else if (providerType === 'github' && repoInfo?.owner) {
              // GitHub issue URL
              const issueOwner = issue.owner || repoInfo.owner
              const issueRepo = issue.repo || repoInfo.repo
              itemUrl = issue.url || `https://github.com/${issueOwner}/${issueRepo}/issues/${issue.number}`
              branchPrefix = 'fix/issue'

              if (!issueOwner || !issueRepo) {
                errors.push({ issueNumber: issue.number, error: 'Could not determine repository for issue' })
                continue
              }
            } else {
              // Generic - just use the provided URL or skip
              if (!issue.url) {
                errors.push({ issueNumber: issue.number, error: 'No issue tracking available for this repository type' })
                continue
              }
              itemUrl = issue.url
              branchPrefix = 'fix/item'
            }

            // Create branch name with random suffix to avoid collision
            const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
            const randomSuffix = Math.random().toString(36).slice(2, 6)
            const branchName = `${branchPrefix}-${issue.number}-${timestamp}-${randomSuffix}`

            // Create session manager
            const manager = new SessionManager({ repoPath: instance.repoPath, statusDir })
            await manager.start()

            // Create session with worktree
            const session = await manager.createSession({
              branch: branchName,
              mode: 'claude',
              workingDirectory: instance.repoPath,
              repoPath: instance.repoPath,
            })

            // Write status file
            const status = manager.status.getStatus(session.id)
            if (status) {
              await manager.status.writeStatusFile(session.id, status)
            }

            // Create dedicated tmux session for this session
            const sessionTmuxName = `orcha-ui-${session.id}`
            const sessionTmux = new TmuxRenderer({ sessionName: sessionTmuxName })
            const workDir = session.worktreePath || instance.repoPath
            sessionTmux.createPane(session.id, workDir)

            // Run Claude with environment variables (conditionally add --dangerously-skip-permissions)
            const claudeFlags = skipPermissions ? ' --dangerously-skip-permissions' : ''
            const envCmd = `ORCHA_SESSION_ID='${session.id}' ORCHA_STATUS_DIR='${statusDir}' claude${claudeFlags}`
            sessionTmux.runInPane(session.id, envCmd)

            // Queue up the startup command in background
            // If skipPermissions is enabled, also handle permission acceptance
            const { spawn: spawnBg } = await import('child_process')
            const acceptScript = skipPermissions
              ? `
              sleep 3
              # Accept the bypass permissions prompt by pressing Down to select option 2, then Enter
              tmux send-keys -t "${sessionTmuxName}:0.0" Down
              sleep 1
              tmux send-keys -t "${sessionTmuxName}:0.0" Enter
              echo "[Batch] Sent permission acceptance for ${sessionTmuxName}"
              sleep 8
              for i in 1 2 3 4 5 6 7 8 9 10; do
                CONTENT=$(tmux capture-pane -t "${sessionTmuxName}:0.0" -p -S -10 2>/dev/null || echo "")
                if echo "$CONTENT" | grep -q "❯"; then
                  # Send the startup command text first, then Enter after a delay
                  tmux send-keys -t "${sessionTmuxName}:0.0" "${safeStartupCommand} ${itemUrl}"
                  sleep 1
                  tmux send-keys -t "${sessionTmuxName}:0.0" Enter
                  echo "[Batch] Sent ${safeStartupCommand} for item #${issue.number}"
                  exit 0
                fi
                sleep 2
              done
              echo "[Batch] Could not detect Claude prompt for item #${issue.number}"
            `
              : `
              sleep 5
              for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
                CONTENT=$(tmux capture-pane -t "${sessionTmuxName}:0.0" -p -S -10 2>/dev/null || echo "")
                if echo "$CONTENT" | grep -q "❯"; then
                  # Send the startup command text first, then Enter after a delay
                  tmux send-keys -t "${sessionTmuxName}:0.0" "${safeStartupCommand} ${itemUrl}"
                  sleep 1
                  tmux send-keys -t "${sessionTmuxName}:0.0" Enter
                  echo "[Batch] Sent ${safeStartupCommand} for item #${issue.number}"
                  exit 0
                fi
                sleep 2
              done
              echo "[Batch] Could not detect Claude prompt for item #${issue.number}"
            `
            const bg = spawnBg('bash', ['-c', acceptScript], {
              detached: true,
              stdio: 'ignore',
            })
            bg.unref()
            console.log(`[API] Spawned background task for issue #${issue.number} (skipPermissions: ${skipPermissions}, cmd: ${safeStartupCommand})`)

            // Update session metadata store with issue info
            const existingMetadata = await loadSessionStore(instanceId)
            const newMetadata: SessionMetadata = {
              id: session.id,
              displayId: session.displayId,
              paneIndex: 0,
              branch: session.branch,
              mode: session.mode,
              worktreePath: session.worktreePath,
              createdAt: session.createdAt.toISOString(),
              tmuxSession: sessionTmuxName,
              customName: `#${issue.number}`, // Set issue number as session name
            }
            existingMetadata.push(newMetadata)
            await saveSessionStore(instanceId, existingMetadata)

            // Note: permission acceptance and /flow command are handled by the background bash script above

            createdSessions.push({
              id: session.id,
              issueNumber: issue.number,
              branch: branchName,
            })

            console.log(`[API] Created batch session for issue #${issue.number}: ${session.id}`)
          } catch (err) {
            console.error(`[API] Failed to create session for issue #${issue.number}:`, err)
            errors.push({ issueNumber: issue.number, error: (err as Error).message })
          }
        }

        res.json({
          success: true,
          sessions: createdSessions,
          errors,
        })
      } catch (err) {
        console.error('[API] Batch issues error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // =========================================================================
    // Pipeline API
    // =========================================================================

    // API: List all pipeline runs
    this.app.get('/api/pipelines', async (_req, res) => {
      try {
        const { listPipelineRuns } = await import('../pipeline/index.js')
        const runs = await listPipelineRuns()
        res.json(runs)
      } catch (err) {
        console.error('[API] Pipeline list error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Create a new pipeline run
    this.app.post('/api/pipelines', async (req, res) => {
      try {
        const { createPipelineRun, executeArchitectStage } = await import('../pipeline/index.js')
        const { defaultPipelineConfig } = await import('../pipeline/pipeline-config.js')

        const { description, acceptanceCriteria, sourceBranch, worktreePath } = req.body as {
          description?: string
          acceptanceCriteria?: string[]
          sourceBranch?: string
          worktreePath?: string
        }

        if (!description || typeof description !== 'string' || description.trim().length === 0) {
          res.status(400).json({ error: 'description is required' })
          return
        }

        const config = defaultPipelineConfig()
        const run = await createPipelineRun({
          config,
          description: description.trim(),
          acceptanceCriteria: Array.isArray(acceptanceCriteria) ? acceptanceCriteria.filter(Boolean) : [],
          sourceBranch: sourceBranch || 'main',
          worktreePath: worktreePath || process.cwd(),
        })

        console.log(`[API] Pipeline ${run.id} created, starting architect stage async`)
        res.status(202).json(run)

        // Kick off architect stage asynchronously (non-blocking)
        executeArchitectStage(run).catch((err: Error) => {
          console.error(`[API] Pipeline ${run.id} architect stage failed:`, err.message)
        })
      } catch (err) {
        console.error('[API] Pipeline create error:', err)
        if (!res.headersSent) {
          res.status(500).json({ error: (err as Error).message })
        }
      }
    })

    // API: Get a single pipeline run
    this.app.get('/api/pipelines/:id', async (req, res) => {
      try {
        const { loadPipelineRun } = await import('../pipeline/index.js')
        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }
        res.json(run)
      } catch (err) {
        console.error('[API] Pipeline get error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Get pipeline stage logs
    this.app.get('/api/pipelines/:id/logs', async (req, res) => {
      try {
        const { getPipelineDir } = await import('../pipeline/pipeline-store.js')
        const { readdir, readFile } = await import('fs/promises')
        const pipelineDir = getPipelineDir(req.params.id)
        const logsDir = join(pipelineDir, 'logs')

        try {
          const files = await readdir(logsDir)
          const logs: Record<string, string> = {}
          for (const file of files) {
            if (file.endsWith('.log')) {
              const content = await readFile(join(logsDir, file), 'utf-8')
              logs[file.replace('.log', '')] = content
            }
          }
          res.json({ logs })
        } catch {
          res.json({ logs: {} })
        }
      } catch (err) {
        console.error('[API] Pipeline logs error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Approve pipeline checkpoint
    this.app.post('/api/pipelines/:id/approve', async (req, res) => {
      try {
        const { loadPipelineRun, executeDevStage, executeGateStage, executeFixLoopStage, executeShipStage } = await import('../pipeline/index.js')
        const { approveCheckpoint } = await import('../pipeline/checkpoint.js')
        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }
        const updated = await approveCheckpoint(run)
        console.log(`[API] Pipeline ${run.id} approved (${run.state} -> ${updated.state})`)
        res.status(202).json(updated)

        // Auto-continue: kick off the next stage asynchronously
        const continueRun = async (r: typeof updated) => {
          let current = r
          // eslint-disable-next-line no-constant-condition
          while (true) {
            if (current.state === 'dev') {
              current = await executeDevStage(current)
            } else if (current.state === 'gate') {
              current = await executeGateStage(current)
            } else if (current.state === 'fix-loop') {
              current = await executeFixLoopStage(current)
            } else if (current.state === 'ship') {
              current = await executeShipStage(current)
            } else {
              break // checkpoint, terminal, or error — stop
            }
          }
        }
        continueRun(updated).catch((err) => {
          console.error(`[API] Pipeline ${run.id} auto-continue failed:`, (err as Error).message)
        })
      } catch (err) {
        console.error('[API] Pipeline approve error:', err)
        if (!res.headersSent) {
          res.status(400).json({ error: (err as Error).message })
        }
      }
    })

    // API: Reject pipeline checkpoint
    this.app.post('/api/pipelines/:id/reject', async (req, res) => {
      try {
        const { loadPipelineRun } = await import('../pipeline/index.js')
        const { rejectCheckpoint } = await import('../pipeline/checkpoint.js')
        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }
        const updated = await rejectCheckpoint(run)
        console.log(`[API] Pipeline ${run.id} rejected (${run.state} -> ${updated.state})`)
        res.json(updated)
      } catch (err) {
        console.error('[API] Pipeline reject error:', err)
        res.status(400).json({ error: (err as Error).message })
      }
    })

    // API: Provide feedback on architect checkpoint
    this.app.post('/api/pipelines/:id/feedback', async (req, res) => {
      try {
        const { loadPipelineRun } = await import('../pipeline/index.js')
        const { feedbackArchitectCheckpoint } = await import('../pipeline/checkpoint.js')
        const { feedback } = req.body as { feedback: string }
        if (!feedback) {
          res.status(400).json({ error: 'feedback is required' })
          return
        }
        if (typeof feedback !== 'string' || feedback.length > 5000) {
          res.status(400).json({ error: 'feedback must be a string of at most 5000 characters' })
          return
        }
        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }
        // Return 202 immediately — architect re-run is long-running
        // Progress is delivered via WebSocket pipeline events
        res.status(202).json({ message: 'Feedback accepted, re-running architect', pipelineId: run.id })
        console.log(`[API] Pipeline ${run.id} feedback accepted, re-running architect async`)
        feedbackArchitectCheckpoint(run, feedback.trim()).catch((err) => {
          console.error(`[API] Pipeline ${run.id} feedback/architect re-run failed:`, (err as Error).message)
        })
      } catch (err) {
        console.error('[API] Pipeline feedback error:', err)
        if (!res.headersSent) {
          res.status(400).json({ error: (err as Error).message })
        }
      }
    })

    // API: Get pipeline blueprint
    this.app.get('/api/pipelines/:id/blueprint', async (req, res) => {
      try {
        const { loadPipelineRun, getPipelineDir } = await import('../pipeline/index.js')
        const { readFile } = await import('fs/promises')
        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }
        const blueprintFile = join(getPipelineDir(run.id), 'blueprint.json')
        try {
          const content = await readFile(blueprintFile, 'utf-8')
          res.json(JSON.parse(content))
        } catch {
          res.status(404).json({ error: 'No blueprint available yet' })
        }
      } catch (err) {
        console.error('[API] Blueprint fetch error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Get pipeline progress entries
    this.app.get('/api/pipelines/:id/progress', async (req, res) => {
      try {
        const { readProgress } = await import('../pipeline/index.js')
        const entries = await readProgress(req.params.id)
        res.json(entries)
      } catch (err) {
        console.error('[API] Pipeline progress error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Delete a pipeline run
    this.app.delete('/api/pipelines/:id', async (req, res) => {
      try {
        const { deletePipelineRun } = await import('../pipeline/index.js')
        const deleted = await deletePipelineRun(req.params.id)
        if (!deleted) {
          res.status(404).json({ error: 'Pipeline not found or already deleted' })
          return
        }
        console.log(`[API] Pipeline ${req.params.id} deleted`)
        res.json({ success: true })
      } catch (err) {
        console.error('[API] Pipeline delete error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Stop a running pipeline
    this.app.post('/api/pipelines/:id/stop', async (req, res) => {
      try {
        const { loadPipelineRun } = await import('../pipeline/index.js')
        const { stopPipeline } = await import('../pipeline/checkpoint.js')

        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }

        const stopped = await stopPipeline(run)
        console.log(`[API] Pipeline ${run.id} stopped by user (was in ${run.state})`)
        res.json(stopped)
      } catch (err) {
        console.error('[API] Pipeline stop error:', err)
        res.status(400).json({ error: (err as Error).message })
      }
    })

    // API: Recover (retry) a failed pipeline
    this.app.post('/api/pipelines/:id/recover', async (req, res) => {
      try {
        const { loadPipelineRun, executeArchitectStage, executeDevStage, executeGateStage, executeFixLoopStage, executeShipStage } = await import('../pipeline/index.js')
        const { recoverPipeline } = await import('../pipeline/checkpoint.js')

        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }

        const recovered = await recoverPipeline(run)
        console.log(`[API] Pipeline ${run.id} recovered to state: ${recovered.state}`)
        res.status(202).json(recovered)

        // Kick off the recovered stage asynchronously
        const stage = recovered.state
        const rerun = async () => {
          if (stage === 'created') {
            await executeArchitectStage(recovered)
          } else if (stage === 'checkpoint:arch') {
            // Just wait for human action — no auto-run needed
          } else if (stage === 'dev') {
            await executeDevStage(recovered)
          } else if (stage === 'gate') {
            await executeGateStage(recovered)
          } else if (stage === 'fix-loop') {
            await executeFixLoopStage(recovered)
          } else if (stage === 'checkpoint:ship') {
            // Just wait for human action
          } else if (stage === 'ship') {
            await executeShipStage(recovered)
          }
        }
        rerun().catch((err) => {
          console.error(`[API] Pipeline ${run.id} recovery re-run failed:`, (err as Error).message)
        })
      } catch (err) {
        console.error('[API] Pipeline recover error:', err)
        if (!res.headersSent) {
          res.status(400).json({ error: (err as Error).message })
        }
      }
    })


    // API: Retry an escalated pipeline with more fix loops
    this.app.post('/api/pipelines/:id/retry-escalated', async (req, res) => {
      try {
        const { loadPipelineRun, executeFixLoopStage } = await import('../pipeline/index.js')
        const { retryEscalatedPipeline } = await import('../pipeline/checkpoint.js')

        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }

        const { additionalRetries, skipChecks, instructions } = req.body ?? {}
        const retried = await retryEscalatedPipeline(run, {
          additionalRetries: typeof additionalRetries === 'number' ? additionalRetries : undefined,
          skipChecks: Array.isArray(skipChecks) ? skipChecks : undefined,
          instructions: typeof instructions === 'string' ? instructions : undefined,
        })

        console.log(`[API] Pipeline ${run.id} retry-escalated -> state: ${retried.state}`)
        res.status(202).json(retried)

        // Kick off the fix-loop stage asynchronously
        executeFixLoopStage(retried).catch((err) => {
          console.error(`[API] Pipeline ${run.id} retry-escalated re-run failed:`, (err as Error).message)
        })
      } catch (err) {
        console.error('[API] Pipeline retry-escalated error:', err)
        if (!res.headersSent) {
          res.status(400).json({ error: (err as Error).message })
        }
      }
    })

    // API: Get gate results for a pipeline
    this.app.get('/api/pipelines/:id/gate-results', async (req, res) => {
      try {
        const { loadPipelineRun, getPipelineDir } = await import('../pipeline/index.js')
        const { readFile } = await import('fs/promises')
        const { join } = await import('path')

        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }

        // Return gate results from the run object (always up to date)
        const gateResults = run.gateResults ?? []

        // Also try to load the verdict file for extra context
        let verdict = null
        try {
          const verdictPath = join(getPipelineDir(run.id), 'gate-results', 'verdict.json')
          const raw = await readFile(verdictPath, 'utf-8')
          verdict = JSON.parse(raw)
        } catch {
          // No verdict file — that's fine
        }

        res.json({ gateResults, verdict })
      } catch (err) {
        console.error('[API] Gate results error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Get diff for a pipeline (all changes from source branch)
    this.app.get('/api/pipelines/:id/diff', async (req, res) => {
      try {
        const { loadPipelineRun } = await import('../pipeline/index.js')
        const { execSync } = await import('child_process')

        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }

        const execOpts = { cwd: run.worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

        // Find merge-base with source branch
        let mergeBase: string
        try {
          mergeBase = execSync(`git merge-base origin/${run.sourceBranch} HEAD`, execOpts).trim()
        } catch {
          try {
            mergeBase = execSync(`git merge-base ${run.sourceBranch} HEAD`, execOpts).trim()
          } catch {
            // Fallback: diff against parent commit
            mergeBase = 'HEAD~1'
          }
        }

        // Get full diff
        let diff = ''
        try {
          diff = execSync(`git diff ${mergeBase}...HEAD`, execOpts)
        } catch {
          try { diff = execSync(`git diff ${mergeBase} HEAD`, execOpts) } catch { /* empty diff */ }
        }

        // Get stat summary
        let stat = ''
        let filesChanged = 0
        let insertions = 0
        let deletions = 0
        try {
          stat = execSync(`git diff --stat ${mergeBase}...HEAD`, execOpts)
          // Parse last line: " N files changed, N insertions(+), N deletions(-)"
          const lastLine = stat.trim().split('\n').pop() || ''
          const filesMatch = lastLine.match(/(\d+) files? changed/)
          const insMatch = lastLine.match(/(\d+) insertions?/)
          const delMatch = lastLine.match(/(\d+) deletions?/)
          if (filesMatch) filesChanged = parseInt(filesMatch[1], 10)
          if (insMatch) insertions = parseInt(insMatch[1], 10)
          if (delMatch) deletions = parseInt(delMatch[1], 10)
        } catch {
          try {
            stat = execSync(`git diff --stat ${mergeBase} HEAD`, execOpts)
          } catch { /* no stat */ }
        }

        // Get commit messages for noteworthy changes
        const commits: Array<{ hash: string; message: string }> = []
        try {
          const log = execSync(`git log --oneline ${mergeBase}...HEAD`, execOpts)
          for (const line of log.trim().split('\n')) {
            if (!line.trim()) continue
            const spaceIdx = line.indexOf(' ')
            if (spaceIdx > 0) {
              commits.push({ hash: line.slice(0, spaceIdx), message: line.slice(spaceIdx + 1) })
            }
          }
        } catch { /* no commits */ }

        res.json({ diff, stat, filesChanged, insertions, deletions, commits })
      } catch (err) {
        console.error('[API] Pipeline diff error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Generate AI ship summary for a pipeline
    this.app.get('/api/pipelines/:id/ship-summary', async (req, res) => {
      try {
        const { loadPipelineRun, getPipelineDir } = await import('../pipeline/index.js')
        const { readFile, writeFile, mkdir } = await import('fs/promises')
        const { execSync, spawn: spawnProc } = await import('child_process')

        const run = await loadPipelineRun(req.params.id)
        if (!run) {
          res.status(404).json({ error: 'Pipeline not found' })
          return
        }

        // Check for cached summary
        const shipDir = join(getPipelineDir(run.id), 'ship')
        const summaryPath = join(shipDir, 'summary.json')
        if (req.query.force !== '1') {
          try {
            const cached = await readFile(summaryPath, 'utf-8')
            res.json(JSON.parse(cached))
            return
          } catch { /* no cache, generate */ }
        }

        // Gather context for the AI
        const execOpts = { cwd: run.worktreePath, encoding: 'utf-8' as const, timeout: 30000 }

        // Get diff stat (compact)
        let diffStat = ''
        try {
          let mergeBase = ''
          try { mergeBase = execSync(`git merge-base origin/${run.sourceBranch} HEAD`, execOpts).trim() }
          catch { try { mergeBase = execSync(`git merge-base ${run.sourceBranch} HEAD`, execOpts).trim() } catch { mergeBase = 'HEAD~1' } }
          diffStat = execSync(`git diff --stat ${mergeBase}...HEAD`, execOpts)
        } catch { /* empty */ }

        // Get commit messages
        let commitLog = ''
        try {
          let mergeBase = ''
          try { mergeBase = execSync(`git merge-base origin/${run.sourceBranch} HEAD`, execOpts).trim() }
          catch { try { mergeBase = execSync(`git merge-base ${run.sourceBranch} HEAD`, execOpts).trim() } catch { mergeBase = 'HEAD~1' } }
          commitLog = execSync(`git log --oneline ${mergeBase}...HEAD`, execOpts)
        } catch { /* empty */ }

        // Get blueprint approach
        let approach = ''
        try {
          const bpPath = join(getPipelineDir(run.id), 'blueprint.json')
          const bpRaw = await readFile(bpPath, 'utf-8')
          const bp = JSON.parse(bpRaw)
          approach = bp.approach || bp.content || ''
        } catch { /* no blueprint */ }

        // Get truncated diff (first 20000 chars for thorough summary)
        let diffSnippet = ''
        try {
          let mergeBase = ''
          try { mergeBase = execSync(`git merge-base origin/${run.sourceBranch} HEAD`, execOpts).trim() }
          catch { try { mergeBase = execSync(`git merge-base ${run.sourceBranch} HEAD`, execOpts).trim() } catch { mergeBase = 'HEAD~1' } }
          const fullDiff = execSync(`git diff ${mergeBase}...HEAD`, execOpts)
          diffSnippet = fullDiff.slice(0, 20000)
        } catch { /* empty */ }

        const prompt = `You are summarizing code changes for a ship review dashboard. Be concise and specific.

Task description: ${run.description}

${approach ? `Blueprint approach: ${approach.slice(0, 2000)}` : ''}

Diff stat:
${diffStat}

Commits:
${commitLog}

Diff (truncated):
${diffSnippet}

Respond with ONLY valid JSON, no markdown fences, in this exact format:
{"description":"A detailed paragraph explaining what was implemented...","changes":["First noteworthy change","Second noteworthy change","Third noteworthy change"]}

Rules:
- "description" should be a thorough 3-5 sentence summary written for a reviewer who needs to understand and approve these changes. Cover: what was built, how it works at a high level, key design decisions, and any important trade-offs or patterns used. Write in plain English as if briefing a colleague.
- "changes" should be 4-8 bullet points highlighting the most noteworthy individual changes. Each bullet should be specific and actionable — a reviewer should understand what to look for. Good: "Added graceful degradation so the app works without a Stripe key configured". Bad: "Updated payment code".
- Focus on behavior, architecture, and user impact — not file names or commit messages
- Keep each change bullet to one sentence`

        // Spawn claude CLI for a quick summary
        const result = await new Promise<string>((resolve, reject) => {
          const proc = spawnProc('claude', [
            '--model', 'haiku',
            '-p', prompt,
            '--output-format', 'text',
            '--max-budget-usd', '0.05',
            '--dangerously-skip-permissions',
          ], {
            cwd: run.worktreePath,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CI: '1' },
          })

          const chunks: Buffer[] = []
          proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
          proc.stderr.on('data', () => {}) // ignore stderr
          proc.on('error', reject)
          proc.on('close', (code) => {
            const output = Buffer.concat(chunks).toString('utf-8').trim()
            if (code === 0 && output) {
              resolve(output)
            } else {
              reject(new Error(`claude exited with code ${code}`))
            }
          })

          // Timeout after 30 seconds
          setTimeout(() => { try { proc.kill() } catch {} }, 30000)
        })

        // Parse the JSON response
        let summary: { description: string; changes: string[] }
        try {
          // Strip markdown fences if present
          const cleaned = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim()
          summary = JSON.parse(cleaned)
        } catch {
          // Fallback: use raw text as description
          summary = { description: result.slice(0, 500), changes: [] }
        }

        // Cache to file
        await mkdir(shipDir, { recursive: true })
        await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf-8')

        res.json(summary)
      } catch (err) {
        console.error('[API] Ship summary error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Restart server (graceful)
    this.app.post('/api/server/restart', async (_req, res) => {
      try {
        console.log('[API] Server restart requested')
        res.json({ success: true, message: 'Server restarting...' })

        // Give time for response to be sent
        setTimeout(() => {
          const { spawn, execSync } = require('child_process')
          // Check for restart script in multiple locations
          const projectScript = join(__dirname, '../../scripts/restart-orcha-web.sh')
          const homeScript = join(homedir(), 'restart-orcha-web.sh')
          const restartScript = existsSync(projectScript) ? projectScript : existsSync(homeScript) ? homeScript : null

          if (restartScript) {
            spawn('bash', [restartScript], {
              detached: true,
              stdio: 'ignore',
            }).unref()
          } else {
            // Fallback: try to respawn via tmux directly
            try {
              const orchaDir = process.cwd()
              execSync(`tmux respawn-pane -k -t orcha-web "cd ${orchaDir} && npm run web:dev"`, { stdio: 'ignore' })
            } catch {
              // Last resort: just exit
              process.exit(0)
            }
          }
        }, 500)
      } catch (err) {
        console.error('[API] Restart error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })
  }

  private setupWebSocket(): void {
    this.wss.on('connection', async (ws, req) => {
      const url = new URL(req.url || '', `http://localhost:${this.port}`)
      const mode = url.searchParams.get('mode')

      // Pipeline events mode — lightweight connection for real-time updates
      if (mode === 'pipeline-events') {
        // Nothing to set up — this connection receives broadcasts from setupPipelineEvents()
        ws.on('error', () => {})
        return
      }

      // File manager mode (yazi)
      if (mode === 'yazi') {
        const instanceId = url.searchParams.get('instanceId')
        const sessionId = url.searchParams.get('sessionId')

        if (!instanceId) {
          ws.close(1008, 'Missing instanceId parameter')
          return
        }

        const instance = await getInstance(instanceId)
        if (!instance) {
          ws.close(1008, 'Instance not found')
          return
        }

        // Determine path: use worktree if session exists, otherwise use main repo
        let targetPath = instance.repoPath
        if (sessionId) {
          const sessions = await this.getAllSessions()
          const session = sessions.find(s => s.id === sessionId && s.instanceId === instanceId)
          if (session && session.worktreePath) {
            targetPath = session.worktreePath
            console.log(`[WS] File manager connected: ${instanceId}/${sessionId} (worktree: ${targetPath})`)
          } else {
            console.log(`[WS] File manager connected: ${instanceId}/${sessionId} (main repo: ${targetPath})`)
          }
        } else {
          console.log(`[WS] File manager connected: ${instanceId} (main repo: ${targetPath})`)
        }

        const ptyProcess = this.createYaziPty(targetPath)
        if (!ptyProcess) {
          ws.close(1011, 'Failed to create yazi PTY')
          return
        }

        const sessionKey = `yazi-${instanceId}-${Date.now()}`
        this.ptySessions.set(sessionKey, { pty: ptyProcess, ws })

        ptyProcess.onData((data) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'output', data }))
          }
        })

        ptyProcess.onExit(({ exitCode }) => {
          console.log(`[PTY] Yazi exited with code ${exitCode}`)
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'exit', code: exitCode }))
          }
          this.ptySessions.delete(sessionKey)
        })

        ws.on('message', (message) => {
          try {
            const msg = JSON.parse(message.toString())
            if (msg.type === 'input' && msg.data) {
              ptyProcess.write(msg.data)
            } else if (msg.type === 'resize' && msg.cols && msg.rows) {
              ptyProcess.resize(msg.cols, msg.rows)
            }
          } catch {
            ptyProcess.write(message.toString())
          }
        })

        ws.on('close', () => {
          console.log(`[WS] File manager disconnected: ${instanceId}`)
          ptyProcess.kill()
          this.ptySessions.delete(sessionKey)
        })

        ws.on('error', (err) => {
          console.error(`[WS] Yazi error for ${instanceId}:`, err.message)
        })

        return
      }

      // Default: tmux session mode
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

  /**
   * Subscribe to pipeline state-change events and broadcast to all connected
   * WebSocket clients so the frontend can update instantly.
   */
  private setupPipelineEvents(): void {
    import('../pipeline/events.js').then(({ pipelineEvents }) => {
      pipelineEvents.onLog((event) => {
        const message = JSON.stringify({
          type: 'pipeline:log',
          data: {
            id: event.pipelineId,
            stage: event.stage,
            stream: event.stream,
            text: event.data,
          },
        })

        for (const client of this.wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message)
          }
        }
      })

      pipelineEvents.onStateChange((event) => {
        const message = JSON.stringify({
          type: 'pipeline:state-change',
          data: {
            id: event.pipelineId,
            state: event.to,
            from: event.from,
            updatedAt: event.updatedAt,
          },
        })

        for (const client of this.wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message)
          }
        }
      })

      pipelineEvents.onProgress((event) => {
        const message = JSON.stringify({
          type: 'pipeline:progress',
          data: {
            pipelineId: event.pipelineId,
            entry: event.entry,
          },
        })

        for (const client of this.wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
            client.send(message)
          }
        }
      })
    }).catch((err) => {
      // Pipeline module may not be available in all setups — non-fatal
      console.warn('[WS] Could not subscribe to pipeline events:', (err as Error).message)
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

  private createYaziPty(repoPath: string): pty.IPty | null {
    try {
      // Check if yazi is installed
      try {
        execSync('which yazi', { stdio: 'ignore' })
      } catch {
        console.error('[PTY] yazi not found in PATH')
        return null
      }

      // Create PTY running yazi in the repo directory
      const ptyProcess = pty.spawn('yazi', [repoPath], {
        name: 'xterm-256color',
        cols: 120,
        rows: 30,
        cwd: repoPath,
        env: { ...process.env, TERM: 'xterm-256color' },
      })

      return ptyProcess
    } catch (err) {
      console.error(`[PTY] Failed to create yazi PTY:`, (err as Error).message)
      return null
    }
  }

  private async getAllSessions(): Promise<SessionInfo[]> {
    const instances = await listInstances()
    const sessions: SessionInfo[] = []

    for (const inst of instances) {
      const statusDir = getStatusDirForInstance(inst.instanceId)

      // Migrate status files from legacy /tmp locations before reading
      // This is idempotent and only copies files that don't already exist
      await migrateStatusFromLegacyPaths(inst.instanceId)

      // Get or create singleton monitor for this instance (prevents start/stop churn)
      let monitor = this.statusMonitors.get(inst.instanceId)
      if (!monitor) {
        monitor = new StatusMonitor({ statusDir })
        await monitor.start()
        this.statusMonitors.set(inst.instanceId, monitor)
      }

      const statuses = monitor.getAllStatuses()
      // Don't stop - keep monitor alive for next request

      const metadata = await loadSessionStore(inst.instanceId)

      // NOTE: Removed blocking tmux status detection to prevent event loop blocking
      // This was causing keyboard lag (execSync blocks for ~50ms per call)
      // Status now comes purely from status files written by Claude sessions
      // If status accuracy is needed, tmux calls should be made async in the future

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
          worktreePath: meta.worktreePath,
        })
      }
    }

    return sessions
  }

  /**
   * Resolve plan file path for a worktree/repo
   * 1. Check for custom config in .orcha/config.json
   * 2. Default to .claude/plan.md
   */
  private resolvePlanPath(basePath: string): string | null {
    // 1. Check for custom config
    const configPath = join(basePath, '.orcha', 'config.json')
    if (existsSync(configPath)) {
      try {
        const config = JSON.parse(readFileSync(configPath, 'utf-8'))
        if (config.planPath) {
          const customPath = join(basePath, config.planPath)
          if (existsSync(customPath)) return customPath
        }
      } catch {
        // Invalid config, fall through to default
      }
    }

    // 2. Default location
    const defaultPath = join(basePath, '.claude', 'plan.md')
    if (existsSync(defaultPath)) return defaultPath

    return null
  }

  private async getClaudeUsage(): Promise<UsageStats | { error: string }> {
    const statsPath = join(process.env.HOME || '', '.claude', 'stats-cache.json')

    try {
      const { readFile } = await import('fs/promises')
      const data = JSON.parse(await readFile(statsPath, 'utf-8'))

      // Sum cache read tokens across all models
      let cacheReadTokens = 0
      if (data.modelUsage) {
        for (const model of Object.values(data.modelUsage) as Array<{ cacheReadInputTokens?: number }>) {
          cacheReadTokens += model.cacheReadInputTokens || 0
        }
      }

      return {
        totalSessions: data.totalSessions || 0,
        totalMessages: data.totalMessages || 0,
        cacheReadTokens,
        firstSessionDate: data.firstSessionDate || '',
      }
    } catch {
      // File missing or unreadable
      return { error: 'Usage stats not available' }
    }
  }

  async start(): Promise<void> {
    // Migrate existing instances to add provider info if missing
    await this.migrateInstanceProviderInfo()

    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        console.log(`Orcha Web Dashboard running at http://localhost:${this.port}`)
        resolve()
      })
    })
  }

  /**
   * Migrate existing instances to detect provider type
   * (for instances registered before provider detection was added)
   */
  private async migrateInstanceProviderInfo(): Promise<void> {
    try {
      const instances = await listInstances()
      let migrated = 0

      for (const instance of instances) {
        // If instance doesn't have providerType, detect and update it
        if (!instance.providerType) {
          const { updateInstanceProviderInfo } = await import('../core/instance-registry.js')
          await updateInstanceProviderInfo(instance.instanceId)
          migrated++
        }
      }

      if (migrated > 0) {
        console.log(`[Migration] Updated provider info for ${migrated} instance(s)`)
      }
    } catch (err) {
      console.error('[Migration] Error updating instance provider info:', err)
    }
  }

  stop(): void {
    // Kill all PTY sessions
    for (const [key, session] of this.ptySessions) {
      session.pty.kill()
      session.ws?.close()
    }
    this.ptySessions.clear()

    // Stop all status monitors (cleanup file watchers)
    for (const [instanceId, monitor] of this.statusMonitors) {
      monitor.stop().catch(err => {
        console.warn(`[Server] Failed to stop monitor for ${instanceId}:`, err.message)
      })
    }
    this.statusMonitors.clear()

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
