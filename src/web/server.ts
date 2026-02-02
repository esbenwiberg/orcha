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
import { join, dirname, resolve, isAbsolute } from 'path'
import { homedir } from 'os'
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

        // Ensure tmux session exists (create if needed)
        const tmux = new TmuxRenderer({ sessionName: instance.tmuxSession })
        if (!tmux.sessionExists()) {
          tmux.createSession()
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

        // Run AI command with environment variables (inline syntax avoids && issues with tmux)
        const cmd = (mode || 'claude') === 'shell' ? '' : (mode || 'claude')
        if (cmd) {
          // Use inline env var syntax: VAR=val command (sets vars just for that command)
          const cmdWithFlags = cmd === 'claude' ? `${cmd} --dangerously-skip-permissions` : cmd
          const envCmd = `ORCHA_SESSION_ID='${session.id}' ORCHA_STATUS_DIR='${statusDir}' ${cmdWithFlags}`
          sessionTmux.runInPane(session.id, envCmd)

          // Accept the bypass permissions warning by pressing Down then Enter (Claude only)
          if (cmd === 'claude') {
            setTimeout(() => {
              try {
                execSync(`tmux send-keys -t "${sessionTmuxName}:0.0" Down`, { stdio: 'pipe' })
                setTimeout(() => {
                  try {
                    execSync(`tmux send-keys -t "${sessionTmuxName}:0.0" Enter`, { stdio: 'pipe' })
                  } catch {
                    // May already be past the prompt
                  }
                }, 1000)
              } catch {
                // May already be past the prompt
              }
            }, 2000)
          }
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

        // Check if origin is a GitHub remote
        let hasGitHubRemote = false
        try {
          const remoteResult = await executeGit(instanceId, ['remote', 'get-url', 'origin'])
          hasGitHubRemote = remoteResult.stdout.includes('github.com')
        } catch {
          // No origin remote
        }

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

    // API: Create pull request using gh CLI
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

        // Check gh CLI is available
        const { spawnSync } = await import('child_process')
        const ghCheck = spawnSync('which', ['gh'], { encoding: 'utf-8' })
        if (ghCheck.status !== 0) {
          res.status(400).json({ error: 'gh CLI not installed. Install it from https://cli.github.com/' })
          return
        }

        // Create PR using gh CLI
        const args = ['pr', 'create', '--title', title]
        if (body) {
          args.push('--body', body)
        }

        const prResult = spawnSync('gh', args, {
          cwd: instance.repoPath,
          encoding: 'utf-8',
          timeout: 60000,
        })

        if (prResult.status !== 0) {
          const errorMsg = prResult.stderr || prResult.stdout || 'Unknown error'
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

        // Extract PR URL from output
        const prUrl = prResult.stdout.trim()
        console.log(`[API] Created PR: ${prUrl}`)
        res.json({ success: true, prUrl })
      } catch (err) {
        console.error('[API] Git create-pr error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // =========================================================================
    // GitHub Issues API
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

        // Parse issue numbers
        const issueNumbers = numbers.split(',').map(n => parseInt(n.trim(), 10)).filter(n => !isNaN(n))
        if (issueNumbers.length === 0) {
          res.status(400).json({ error: 'No valid issue numbers provided' })
          return
        }

        // Check gh CLI is available
        const { spawnSync } = await import('child_process')
        const ghCheck = spawnSync('which', ['gh'], { encoding: 'utf-8' })
        if (ghCheck.status !== 0) {
          res.status(400).json({ error: 'gh CLI not installed' })
          return
        }

        // Get GitHub remote to determine repo
        const remoteResult = await executeGit(instanceId, ['remote', 'get-url', 'origin'])
        if (remoteResult.code !== 0 || !remoteResult.stdout.includes('github.com')) {
          res.status(400).json({ error: 'Repository does not have a GitHub remote' })
          return
        }

        // Parse owner/repo from remote URL
        const remoteUrl = remoteResult.stdout.trim()
        const repoMatch = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
        if (!repoMatch) {
          res.status(400).json({ error: 'Could not parse GitHub repo from remote' })
          return
        }
        const [, owner, repo] = repoMatch

        // Fetch issues using gh CLI (batch query)
        const issues: Array<{ number: number; title: string; url: string; state: string }> = []
        const errors: Array<{ number: number; error: string }> = []

        // Use gh issue view for each (gh doesn't have a batch lookup)
        for (const num of issueNumbers) {
          const issueResult = spawnSync('gh', ['issue', 'view', String(num), '--json', 'number,title,url,state', '-R', `${owner}/${repo}`], {
            encoding: 'utf-8',
            timeout: 10000,
          })

          if (issueResult.status === 0) {
            try {
              const issueData = JSON.parse(issueResult.stdout)
              issues.push({
                number: issueData.number,
                title: issueData.title,
                url: issueData.url,
                state: issueData.state,
              })
            } catch {
              errors.push({ number: num, error: 'Failed to parse issue data' })
            }
          } else {
            errors.push({ number: num, error: 'Issue not found' })
          }
        }

        console.log(`[API] Fetched ${issues.length} issues for ${owner}/${repo}`)
        res.json({ issues, errors, repo: `${owner}/${repo}` })
      } catch (err) {
        console.error('[API] GitHub issues error:', err)
        res.status(500).json({ error: (err as Error).message })
      }
    })

    // API: Batch process GitHub issues - create sessions with /flow command
    this.app.post('/api/batch-issues', async (req, res) => {
      try {
        const { instanceId, issues } = req.body as {
          instanceId: string
          issues: Array<{ number: number; owner?: string; repo?: string; url?: string }>
        }

        if (!instanceId || !issues || !Array.isArray(issues) || issues.length === 0) {
          res.status(400).json({ error: 'instanceId and non-empty issues array are required' })
          return
        }

        const instance = await getInstance(instanceId)
        if (!instance) {
          res.status(404).json({ error: `Instance not found: ${instanceId}` })
          return
        }

        // Get GitHub remote to build issue URLs
        const remoteResult = await executeGit(instanceId, ['remote', 'get-url', 'origin'])
        let defaultOwner = ''
        let defaultRepo = ''

        if (remoteResult.code === 0 && remoteResult.stdout.includes('github.com')) {
          const repoMatch = remoteResult.stdout.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
          if (repoMatch) {
            defaultOwner = repoMatch[1]
            defaultRepo = repoMatch[2]
          }
        }

        // Ensure tmux session exists
        const tmux = new TmuxRenderer({ sessionName: instance.tmuxSession })
        if (!tmux.sessionExists()) {
          tmux.createSession()
        }

        const statusDir = getStatusDirForInstance(instanceId)
        const createdSessions: Array<{ id: string; issueNumber: number; branch: string }> = []
        const errors: Array<{ issueNumber: number; error: string }> = []

        // Process each issue
        for (const issue of issues) {
          try {
            // Build issue URL
            const issueOwner = issue.owner || defaultOwner
            const issueRepo = issue.repo || defaultRepo
            const issueUrl = issue.url || `https://github.com/${issueOwner}/${issueRepo}/issues/${issue.number}`

            if (!issueOwner || !issueRepo) {
              errors.push({ issueNumber: issue.number, error: 'Could not determine repository for issue' })
              continue
            }

            // Create branch name with random suffix to avoid collision
            const timestamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
            const randomSuffix = Math.random().toString(36).slice(2, 6)
            const branchName = `fix/issue-${issue.number}-${timestamp}-${randomSuffix}`

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

            // Run Claude with environment variables
            const envCmd = `ORCHA_SESSION_ID='${session.id}' ORCHA_STATUS_DIR='${statusDir}' claude --dangerously-skip-permissions`
            sessionTmux.runInPane(session.id, envCmd)

            // Queue up the permission acceptance and /flow command in background
            // Use spawn to run a shell script that handles timing
            const { spawn: spawnBg } = await import('child_process')
            const acceptScript = `
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
                  # Send the /flow-auto command text first, then Enter after a delay
                  tmux send-keys -t "${sessionTmuxName}:0.0" "/flow-auto ${issueUrl}"
                  sleep 1
                  tmux send-keys -t "${sessionTmuxName}:0.0" Enter
                  echo "[Batch] Sent /flow-auto for issue #${issue.number}"
                  exit 0
                fi
                sleep 2
              done
              echo "[Batch] Could not detect Claude prompt for issue #${issue.number}"
            `
            const bg = spawnBg('bash', ['-c', acceptScript], {
              detached: true,
              stdio: 'ignore',
            })
            bg.unref()
            console.log(`[API] Spawned background task for issue #${issue.number}`)

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
  }

  private setupWebSocket(): void {
    this.wss.on('connection', async (ws, req) => {
      const url = new URL(req.url || '', `http://localhost:${this.port}`)
      const mode = url.searchParams.get('mode')

      // File manager mode (yazi)
      if (mode === 'yazi') {
        const instanceId = url.searchParams.get('instanceId')
        if (!instanceId) {
          ws.close(1008, 'Missing instanceId parameter')
          return
        }

        const instance = await getInstance(instanceId)
        if (!instance) {
          ws.close(1008, 'Instance not found')
          return
        }

        console.log(`[WS] File manager connected: ${instanceId}`)

        const ptyProcess = this.createYaziPty(instance.repoPath)
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
