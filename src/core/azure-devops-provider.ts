/**
 * Azure DevOps VCS Provider
 *
 * Implements VCS operations for Azure DevOps repositories using MCP tools.
 * Falls back to az CLI if MCP tools are unavailable.
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

const ADO_HTTPS_PATTERN =
  /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/
const ADO_VS_HTTPS_PATTERN =
  /(?:https?:\/\/)?([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/
const ADO_SSH_PATTERN = /ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/?#]+)/
const ADO_VS_SSH_PATTERN =
  /([^@]+)@vs-ssh\.visualstudio\.com[/:]v3\/([^/]+)\/([^/]+)\/([^/?#]+)/

// ============================================================================
// MCP Tool Invocation Helper
// ============================================================================

interface McpToolResult {
  success: boolean
  data?: unknown
  error?: string
}

/**
 * Invoke an MCP tool via Claude Code's internal mechanism.
 *
 * Note: In actual runtime, MCP tools are invoked by Claude Code itself.
 * This provider is designed to be called from server.ts which has access
 * to execute commands. The provider returns the MCP tool name and parameters
 * needed, and the server handles the actual invocation.
 *
 * For now, we attempt to use az CLI as the primary implementation since
 * MCP tools require Claude Code's runtime context.
 */
async function invokeAzCli(args: string[], cwd?: string): Promise<McpToolResult> {
  try {
    const result = spawnSync('az', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 60000,
    })

    if (result.status !== 0) {
      return {
        success: false,
        error: result.stderr || `az CLI failed with exit code ${result.status}`,
      }
    }

    try {
      const data = JSON.parse(result.stdout)
      return { success: true, data }
    } catch {
      // Non-JSON output
      return { success: true, data: result.stdout.trim() }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error invoking az CLI',
    }
  }
}

/**
 * Check if az CLI is available and logged in
 */
function isAzCliAvailable(): boolean {
  try {
    const result = spawnSync('az', ['account', 'show'], {
      encoding: 'utf-8',
      timeout: 10000,
    })
    return result.status === 0
  } catch {
    return false
  }
}

// ============================================================================
// Azure DevOps Provider Implementation
// ============================================================================

export const azureDevOpsProvider: VcsProvider = {
  type: 'azure-devops' as VcsProviderType,

  matchesRemoteUrl(url: string): boolean {
    return (
      ADO_HTTPS_PATTERN.test(url) ||
      ADO_VS_HTTPS_PATTERN.test(url) ||
      ADO_SSH_PATTERN.test(url) ||
      ADO_VS_SSH_PATTERN.test(url)
    )
  },

  parseRemoteUrl(url: string): RepoInfo | null {
    return parseRemoteUrl(url)
  },

  async createPullRequest(options: CreatePrOptions): Promise<PrResult> {
    const { title, body, sourceBranch, targetBranch, repoPath, repoInfo } = options

    // Check if az CLI is available
    if (!isAzCliAvailable()) {
      return {
        success: false,
        error: 'Azure CLI (az) not available or not logged in. Run "az login" to authenticate.',
      }
    }

    if (!repoInfo.owner || !repoInfo.project) {
      return {
        success: false,
        error: 'Missing organization or project information in repository URL',
      }
    }

    try {
      const args = [
        'repos',
        'pr',
        'create',
        '--title',
        title,
        '--source-branch',
        sourceBranch,
        '--target-branch',
        targetBranch,
        '--organization',
        `https://dev.azure.com/${repoInfo.owner}`,
        '--project',
        repoInfo.project,
        '--repository',
        repoInfo.repo,
        '--output',
        'json',
      ]

      if (body) {
        args.push('--description', body)
      }

      const result = await invokeAzCli(args, repoPath)

      if (!result.success) {
        return {
          success: false,
          error: result.error || 'Failed to create pull request',
        }
      }

      const prData = result.data as { pullRequestId?: number; url?: string }
      return {
        success: true,
        prUrl: prData.url,
        prNumber: prData.pullRequestId,
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  },

  async getWorkItem(id: number, repoInfo: RepoInfo): Promise<WorkItem | null> {
    if (!isAzCliAvailable()) {
      return null
    }

    if (!repoInfo.owner || !repoInfo.project) {
      return null
    }

    try {
      const result = await invokeAzCli([
        'boards',
        'work-item',
        'show',
        '--id',
        id.toString(),
        '--organization',
        `https://dev.azure.com/${repoInfo.owner}`,
        '--output',
        'json',
      ])

      if (!result.success || !result.data) {
        return null
      }

      const data = result.data as {
        id: number
        fields: {
          'System.Title'?: string
          'System.WorkItemType'?: string
          'System.State'?: string
          'System.AssignedTo'?: { displayName?: string }
          'System.Tags'?: string
        }
        url?: string
        _links?: { html?: { href?: string } }
      }

      return {
        id: data.id,
        title: data.fields['System.Title'] || `Work Item ${id}`,
        type: data.fields['System.WorkItemType'] || 'Work Item',
        state: data.fields['System.State'] || 'Unknown',
        url: data._links?.html?.href || data.url || `https://dev.azure.com/${repoInfo.owner}/${repoInfo.project}/_workitems/edit/${id}`,
        assignee: data.fields['System.AssignedTo']?.displayName,
        labels: data.fields['System.Tags']?.split(';').map(t => t.trim()).filter(Boolean),
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
    if (repoInfo.owner && repoInfo.project) {
      return `https://dev.azure.com/${repoInfo.owner}/${repoInfo.project}/_git/${repoInfo.repo}`
    }
    return repoInfo.remoteUrl
  },

  getWorkItemLabel(): string {
    return 'Work Item'
  },

  getPrLabel(): string {
    return 'Pull Request'
  },
}

// Register the Azure DevOps provider
registerProvider(azureDevOpsProvider)

// Export for direct access
export default azureDevOpsProvider
