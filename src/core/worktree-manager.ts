/**
 * WorktreeManager - Handles git worktree isolation for parallel sessions
 *
 * Each session gets its own worktree, allowing independent work on different branches.
 * Worktrees are stored in ~/.orcha/worktrees/{repo-name}/{session-id}/
 */

import { simpleGit, SimpleGit } from 'simple-git'
import { mkdir, rm, readdir } from 'fs/promises'
import { existsSync } from 'fs'
import { join, basename } from 'path'
import { homedir } from 'os'
import type { WorktreeInfo, WorktreeConfig } from './types.js'

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
   * @returns Path to the created worktree
   */
  async create(sessionId: string, branch: string): Promise<string> {
    const worktreePath = this.getWorktreePath(sessionId)

    // Ensure parent directory exists
    await mkdir(this.getRepoWorktreeDir(), { recursive: true })

    // Check if worktree already exists
    if (existsSync(worktreePath)) {
      throw new Error(`Worktree already exists at ${worktreePath}`)
    }

    // Check if branch exists
    const branches = await this.git.branch()
    const branchExists = branches.all.includes(branch) ||
                         branches.all.includes(`remotes/origin/${branch}`)

    if (branchExists) {
      // Use existing branch
      await this.git.raw(['worktree', 'add', worktreePath, branch])
    } else {
      // Create new branch from current HEAD
      await this.git.raw(['worktree', 'add', '-b', branch, worktreePath])
    }

    return worktreePath
  }

  /**
   * Remove a worktree for a session
   */
  async remove(sessionId: string): Promise<void> {
    const worktreePath = this.getWorktreePath(sessionId)

    if (!existsSync(worktreePath)) {
      return // Already removed
    }

    // Remove from git
    await this.git.raw(['worktree', 'remove', worktreePath, '--force'])
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
}
