/**
 * WorktreeManager - Handles git worktree isolation for parallel sessions
 *
 * Each session gets its own worktree, allowing independent work on different branches.
 * Worktrees are stored in ~/.orcha/worktrees/{repo-name}/{session-id}/
 */

import { simpleGit, SimpleGit } from 'simple-git'
import { mkdir, rm, readdir, rename } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename, relative } from 'path'
import { homedir } from 'os'
import type { WorktreeInfo, WorktreeConfig, BranchSyncInfo } from './types.js'

const DEFAULT_CONFIG: WorktreeConfig = {
  baseDir: join(homedir(), '.orcha', 'worktrees'),
}

export class WorktreeManager {
  private config: WorktreeConfig
  private repoPath: string
  private repoName: string
  private git: SimpleGit

  constructor(repoPath: string, config: Partial<WorktreeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.repoPath = repoPath
    this.repoName = basename(repoPath)
    this.git = simpleGit(repoPath)
  }

  /**
   * Get the worktree directory for this repo
   */
  private getRepoWorktreeDir(): string {
    return join(this.config.baseDir, this.repoName)
  }

  /**
   * Get the worktree path for a specific session
   */
  getWorktreePath(sessionId: string): string {
    return join(this.getRepoWorktreeDir(), sessionId)
  }

  /**
   * Create a new worktree for a session
   * @param sessionId - Unique session identifier
   * @param branch - Branch name (will be created if doesn't exist)
   * @param sourceBranch - Optional base branch to create from (e.g. "release/2.2.0")
   * @returns Path to the created worktree
   */
  async create(sessionId: string, branch: string, sourceBranch?: string): Promise<string> {
    const worktreePath = this.getWorktreePath(sessionId)

    // Ensure parent directory exists
    await mkdir(this.getRepoWorktreeDir(), { recursive: true })

    // Check if worktree already exists
    if (existsSync(worktreePath)) {
      throw new Error(`Worktree already exists at ${worktreePath}`)
    }

    // Fetch latest from origin to ensure we have up-to-date refs
    try {
      await this.git.fetch('origin')
    } catch {
      // Ignore fetch errors (e.g., no network, no remote configured)
    }

    // Use relative path so worktrees work across Windows/WSL
    const relativeWorktreePath = relative(this.repoPath, worktreePath)

    // Check if branch exists (after fetch, so we have latest remote refs)
    const branches = await this.git.branch()
    const branchExists = branches.all.includes(branch) ||
                         branches.all.includes(`remotes/origin/${branch}`)

    if (branchExists) {
      // Use existing branch
      await this.git.raw(['worktree', 'add', relativeWorktreePath, branch])
    } else {
      // Create new branch — use sourceBranch if provided, otherwise default
      const baseBranch = sourceBranch
        ? await this.resolveSourceBranch(sourceBranch)
        : await this.getDefaultBranch()
      await this.git.raw(['worktree', 'add', '-b', branch, relativeWorktreePath, baseBranch])
    }

    return worktreePath
  }

  /**
   * Resolve a user-provided source branch to a valid git ref.
   * Tries origin/<branch> first, then the raw ref.
   * Throws if the ref cannot be found.
   */
  private async resolveSourceBranch(sourceBranch: string): Promise<string> {
    // If it already starts with origin/, use as-is after validation
    const candidates = sourceBranch.startsWith('origin/')
      ? [sourceBranch]
      : [`origin/${sourceBranch}`, sourceBranch]

    for (const ref of candidates) {
      try {
        await this.git.raw(['rev-parse', '--verify', ref])
        return ref
      } catch {
        // Try next candidate
      }
    }

    throw new Error(
      `Source branch "${sourceBranch}" not found. ` +
      `Tried: ${candidates.join(', ')}. Run "git fetch origin" and verify the branch exists.`
    )
  }

  /**
   * Get the default branch reference (origin/main or origin/master)
   */
  private async getDefaultBranch(): Promise<string> {
    const branches = await this.git.branch(['-r'])

    // Prefer origin/main, fall back to origin/master, then HEAD
    if (branches.all.includes('origin/main')) {
      return 'origin/main'
    }
    if (branches.all.includes('origin/master')) {
      return 'origin/master'
    }

    // Fallback to HEAD if no remote default branch found
    return 'HEAD'
  }

  /**
   * Remove a worktree for a session
   */
  async remove(sessionId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(sessionId)

    if (!existsSync(worktreePath)) {
      return // Already removed
    }

    // Use relative path for cross-platform compatibility
    const relativeWorktreePath = relative(this.repoPath, worktreePath)

    // Remove from git
    await this.git.raw(['worktree', 'remove', relativeWorktreePath, '--force'])
  }

  /**
   * List all worktrees for this repo
   */
  async list(): Promise<WorktreeInfo[]> {
    const result = await this.git.raw(['worktree', 'list', '--porcelain'])
    const worktrees: WorktreeInfo[] = []

    // Parse porcelain output
    const entries = result.trim().split('\n\n')
    for (const entry of entries) {
      if (!entry.trim()) continue

      const lines = entry.split('\n')
      let path = ''
      let commit = ''
      let branch = ''

      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          path = line.slice(9)
        } else if (line.startsWith('HEAD ')) {
          commit = line.slice(5)
        } else if (line.startsWith('branch ')) {
          branch = line.slice(7).replace('refs/heads/', '')
        }
      }

      if (!path) continue

      // Check if this is an orcha-managed worktree
      const isOrchaManaged = path.startsWith(this.getRepoWorktreeDir())
      const sessionId = isOrchaManaged ? basename(path) : null
      const isMain = path === this.repoPath

      worktrees.push({
        path,
        branch,
        commit,
        sessionId,
        isMain,
      })
    }

    return worktrees
  }

  /**
   * List only orcha-managed worktrees
   */
  async listManaged(): Promise<WorktreeInfo[]> {
    const all = await this.list()
    return all.filter((w) => w.sessionId !== null)
  }

  /**
   * Cleanup orphaned worktrees (worktrees without matching sessions)
   * @param activeSessionIds - List of currently active session IDs
   */
  async cleanup(activeSessionIds: string[] = []): Promise<string[]> {
    const removed: string[] = []
    const repoWorktreeDir = this.getRepoWorktreeDir()

    if (!existsSync(repoWorktreeDir)) {
      return removed
    }

    // Get all directories in the worktree folder
    const entries = await readdir(repoWorktreeDir, { withFileTypes: true })

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const sessionId = entry.name
      if (activeSessionIds.includes(sessionId)) continue

      // This worktree is orphaned, remove it
      try {
        await this.remove(sessionId)
        removed.push(sessionId)
      } catch (err) {
        // Force remove the directory if git worktree remove fails
        const worktreePath = this.getWorktreePath(sessionId)
        await rm(worktreePath, { recursive: true, force: true })
        // Also prune the worktree list
        await this.git.raw(['worktree', 'prune'])
        removed.push(sessionId)
      }
    }

    return removed
  }

  /**
   * Prune stale worktree references
   */
  async prune(): Promise<void> {
    await this.git.raw(['worktree', 'prune'])
  }

  /**
   * Get info about a specific worktree
   */
  async getInfo(sessionId: string): Promise<WorktreeInfo | undefined> {
    const worktrees = await this.list()
    const worktreePath = this.getWorktreePath(sessionId)
    return worktrees.find((w) => w.path === worktreePath)
  }

  /**
   * Check if a worktree exists for a session
   */
  exists(sessionId: string): boolean {
    return existsSync(this.getWorktreePath(sessionId))
  }

  /**
   * Find an orcha-managed worktree by branch name
   * @returns WorktreeInfo if found, null otherwise
   */
  async findByBranch(branch: string): Promise<WorktreeInfo | null> {
    const managed = await this.listManaged()
    return managed.find((w) => w.branch === branch) ?? null
  }

  /**
   * Get sync status of a branch relative to origin.
   * @param branch - Branch name to check
   * @param worktreePath - Optional worktree path to run git commands in
   * @param sourceBranch - Optional source branch the worktree was created from
   */
  async getBranchSyncStatus(branch: string, worktreePath?: string, sourceBranch?: string): Promise<BranchSyncInfo> {
    const git = worktreePath ? simpleGit(worktreePath) : this.git

    try {
      // Check if branch exists on origin
      try {
        await git.raw(['rev-parse', '--verify', `origin/${branch}`])
      } catch {
        // Branch doesn't exist on origin — report the actual base branch used
        const baseBranch = sourceBranch
          ? await this.resolveSourceBranch(sourceBranch).catch(() => this.getDefaultBranch())
          : await this.getDefaultBranch()
        return { existsOnOrigin: false, ahead: 0, behind: 0, baseBranch }
      }

      // Branch exists on origin — get ahead/behind count
      const result = await git.raw(['rev-list', '--left-right', '--count', `origin/${branch}...${branch}`])
      const parts = result.trim().split(/\s+/)
      const behind = parseInt(parts[0], 10) || 0
      const ahead = parseInt(parts[1], 10) || 0

      return { existsOnOrigin: true, ahead, behind }
    } catch {
      // Fallback if anything fails (detached HEAD, etc.)
      return { existsOnOrigin: false, ahead: 0, behind: 0 }
    }
  }

  /**
   * Move an existing worktree from one session path to another.
   * Uses `git worktree move` to relocate, keeping git metadata intact.
   * @returns The new worktree path
   */
  async reuseForSession(oldSessionId: string, newSessionId: string): Promise<string> {
    const oldPath = this.getWorktreePath(oldSessionId)
    const newPath = this.getWorktreePath(newSessionId)

    if (!existsSync(oldPath)) {
      throw new Error(`Old worktree does not exist at ${oldPath}`)
    }

    if (existsSync(newPath)) {
      throw new Error(`New worktree path already exists at ${newPath}`)
    }

    // Ensure parent directory exists
    await mkdir(this.getRepoWorktreeDir(), { recursive: true })

    const relativeOldPath = relative(this.repoPath, oldPath)
    const relativeNewPath = relative(this.repoPath, newPath)

    await this.git.raw(['worktree', 'move', relativeOldPath, relativeNewPath])

    return newPath
  }
}
