/**
 * GitHub VCS Provider
 *
 * Implements VCS operations for GitHub repositories using the gh CLI.
 */

import { spawnSync } from 'child_process'
import {
  VcsProviderType,
  RepoInfo,
  CreatePrOptions,
  PrResult,
  WorkItem,
} from './types.js'
import { VcsProvider, registerProvider, parseRemoteUrl } from './vcs-provider.js'

// ============================================================================
// URL Pattern Matching
// ============================================================================

const GITHUB_HTTPS_PATTERN = /github\.com[/:]([^/]+)\/([^/.]+)/
const GITHUB_SSH_PATTERN = /git@github\.com:([^/]+)\/([^/.]+)/

// ============================================================================
// GitHub Provider Implementation
// ============================================================================

export const githubProvider: VcsProvider = {
  type: 'github' as VcsProviderType,

  matchesRemoteUrl(url: string): boolean {
    return (
      GITHUB_HTTPS_PATTERN.test(url) ||
      GITHUB_SSH_PATTERN.test(url)
    )
  },

  parseRemoteUrl(url: string): RepoInfo | null {
    return parseRemoteUrl(url)
  },

  async createPullRequest(options: CreatePrOptions): Promise<PrResult> {
    const { title, body, sourceBranch, targetBranch, repoPath } = options

    try {
      const args = [
        'pr',
        'create',
        '--title',
        title,
        '--head',
        sourceBranch,
        '--base',
        targetBranch,
      ]

      if (body) {
        args.push('--body', body)
      }

      const result = spawnSync('gh', args, {
        cwd: repoPath,
        encoding: 'utf-8',
        timeout: 60000,
      })

      if (result.status !== 0) {
        return {
          success: false,
          error: result.stderr || 'Failed to create pull request',
        }
      }

      // gh pr create outputs the PR URL
      const prUrl = result.stdout.trim()
      const prNumberMatch = prUrl.match(/\/pull\/(\d+)/)
      const prNumber = prNumberMatch ? parseInt(prNumberMatch[1], 10) : undefined

      return {
        success: true,
        prUrl,
        prNumber,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  },

  async getWorkItem(id: number, repoInfo: RepoInfo): Promise<WorkItem | null> {
    try {
      const repoSlug = `${repoInfo.owner}/${repoInfo.repo}`
      const result = spawnSync(
        'gh',
        ['issue', 'view', id.toString(), '--repo', repoSlug, '--json', 'number,title,state,url,assignees,labels'],
        {
          encoding: 'utf-8',
          timeout: 30000,
        }
      )

      if (result.status !== 0) {
        return null
      }

      const data = JSON.parse(result.stdout)
      return {
        id: data.number,
        title: data.title,
        type: 'Issue',
        state: data.state,
        url: data.url,
        assignee: data.assignees?.[0]?.login,
        labels: data.labels?.map((l: { name: string }) => l.name),
      }
    } catch {
      return null
    }
  },

  async listWorkItems(ids: number[], repoInfo: RepoInfo): Promise<WorkItem[]> {
    const results: WorkItem[] = []
    for (const id of ids) {
      const item = await this.getWorkItem(id, repoInfo)
      if (item) {
        results.push(item)
      }
    }
    return results
  },

  getCloneUrl(repoInfo: RepoInfo): string {
    return `https://github.com/${repoInfo.owner}/${repoInfo.repo}.git`
  },

  getWorkItemLabel(): string {
    return 'Issue'
  },

  getPrLabel(): string {
    return 'Pull Request'
  },
}

// Register the GitHub provider
registerProvider(githubProvider)

// Export for direct access
export default githubProvider
