/**
 * VCS Provider Abstraction
 *
 * Provides a unified interface for working with different version control
 * hosting services (GitHub, Azure DevOps, etc.)
 */

import {
  VcsProviderType,
  RepoInfo,
  CreatePrOptions,
  PrResult,
  WorkItem,
} from './types.js'

// ============================================================================
// Provider Interface
// ============================================================================

export interface VcsProvider {
  readonly type: VcsProviderType

  // Detection
  matchesRemoteUrl(url: string): boolean

  // Repo info extraction
  parseRemoteUrl(url: string): RepoInfo | null

  // PR operations
  createPullRequest(options: CreatePrOptions): Promise<PrResult>

  // Work item / issue operations
  getWorkItem(id: number, repoInfo: RepoInfo): Promise<WorkItem | null>
  listWorkItems(ids: number[], repoInfo: RepoInfo): Promise<WorkItem[]>

  // Clone support
  getCloneUrl(repoInfo: RepoInfo): string

  // UI hints
  getWorkItemLabel(): string // "Issue" for GitHub, "Work Item" for ADO
  getPrLabel(): string // "Pull Request" for both
}

// ============================================================================
// URL Pattern Matching
// ============================================================================

// GitHub patterns
const GITHUB_HTTPS_PATTERN = /github\.com[/:]([^/]+)\/([^/.]+)/
const GITHUB_SSH_PATTERN = /git@github\.com:([^/]+)\/([^/.]+)/

// Azure DevOps patterns
const ADO_HTTPS_PATTERN =
  /dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/?#]+)/
const ADO_VS_HTTPS_PATTERN =
  /(?:https?:\/\/)?([^./]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/?#]+)/
const ADO_SSH_PATTERN = /ssh\.dev\.azure\.com\/v3\/([^/]+)\/([^/]+)\/([^/?#]+)/
const ADO_VS_SSH_PATTERN =
  /([^@]+)@vs-ssh\.visualstudio\.com[/:]v3\/([^/]+)\/([^/]+)\/([^/?#]+)/

// ============================================================================
// Provider Detection
// ============================================================================

/**
 * Detect the VCS provider type from a remote URL
 */
export function detectProvider(remoteUrl: string): VcsProviderType {
  if (!remoteUrl) {
    return 'generic'
  }

  // Check GitHub
  if (
    GITHUB_HTTPS_PATTERN.test(remoteUrl) ||
    GITHUB_SSH_PATTERN.test(remoteUrl)
  ) {
    return 'github'
  }

  // Check Azure DevOps
  if (
    ADO_HTTPS_PATTERN.test(remoteUrl) ||
    ADO_VS_HTTPS_PATTERN.test(remoteUrl) ||
    ADO_SSH_PATTERN.test(remoteUrl) ||
    ADO_VS_SSH_PATTERN.test(remoteUrl)
  ) {
    return 'azure-devops'
  }

  return 'generic'
}

/**
 * Parse a remote URL and extract repository information
 */
export function parseRemoteUrl(remoteUrl: string): RepoInfo | null {
  if (!remoteUrl) {
    return null
  }

  // Try GitHub HTTPS
  let match = remoteUrl.match(GITHUB_HTTPS_PATTERN)
  if (match) {
    return {
      type: 'github',
      owner: match[1],
      repo: match[2].replace(/\.git$/, ''),
      remoteUrl,
    }
  }

  // Try GitHub SSH
  match = remoteUrl.match(GITHUB_SSH_PATTERN)
  if (match) {
    return {
      type: 'github',
      owner: match[1],
      repo: match[2].replace(/\.git$/, ''),
      remoteUrl,
    }
  }

  // Try Azure DevOps HTTPS (dev.azure.com)
  match = remoteUrl.match(ADO_HTTPS_PATTERN)
  if (match) {
    return {
      type: 'azure-devops',
      owner: match[1], // organization
      project: match[2],
      repo: match[3].replace(/\.git$/, ''),
      remoteUrl,
    }
  }

  // Try Azure DevOps HTTPS (visualstudio.com)
  match = remoteUrl.match(ADO_VS_HTTPS_PATTERN)
  if (match) {
    return {
      type: 'azure-devops',
      owner: match[1], // organization
      project: match[2],
      repo: match[3].replace(/\.git$/, ''),
      remoteUrl,
    }
  }

  // Try Azure DevOps SSH (ssh.dev.azure.com)
  match = remoteUrl.match(ADO_SSH_PATTERN)
  if (match) {
    return {
      type: 'azure-devops',
      owner: match[1], // organization
      project: match[2],
      repo: match[3].replace(/\.git$/, ''),
      remoteUrl,
    }
  }

  // Try Azure DevOps SSH (vs-ssh.visualstudio.com)
  match = remoteUrl.match(ADO_VS_SSH_PATTERN)
  if (match) {
    return {
      type: 'azure-devops',
      owner: match[2], // organization (skip username in match[1])
      project: match[3],
      repo: match[4].replace(/\.git$/, ''),
      remoteUrl,
    }
  }

  // Generic fallback - try to extract repo name from URL
  const pathMatch = remoteUrl.match(/\/([^/]+?)(\.git)?$/)
  if (pathMatch) {
    return {
      type: 'generic',
      repo: pathMatch[1],
      remoteUrl,
    }
  }

  return null
}

// ============================================================================
// Provider Registry
// ============================================================================

// Provider instances are registered here
const providerRegistry: Map<VcsProviderType, VcsProvider> = new Map()

/**
 * Register a VCS provider
 */
export function registerProvider(provider: VcsProvider): void {
  providerRegistry.set(provider.type, provider)
}

/**
 * Get a provider by type
 */
export function getProviderByType(type: VcsProviderType): VcsProvider | null {
  return providerRegistry.get(type) || null
}

/**
 * Get the appropriate provider for a remote URL
 */
export function getProvider(remoteUrl: string): VcsProvider | null {
  const type = detectProvider(remoteUrl)
  return getProviderByType(type)
}

/**
 * Get all registered providers
 */
export function getRegisteredProviders(): VcsProvider[] {
  return Array.from(providerRegistry.values())
}

// ============================================================================
// Generic Provider (fallback for unrecognized URLs)
// ============================================================================

export const genericProvider: VcsProvider = {
  type: 'generic',

  matchesRemoteUrl(_url: string): boolean {
    // Generic matches anything not matched by other providers
    return true
  },

  parseRemoteUrl(url: string): RepoInfo | null {
    return parseRemoteUrl(url)
  },

  async createPullRequest(_options: CreatePrOptions): Promise<PrResult> {
    return {
      success: false,
      error: 'Pull request creation not supported for this repository type',
    }
  },

  async getWorkItem(_id: number, _repoInfo: RepoInfo): Promise<WorkItem | null> {
    return null
  },

  async listWorkItems(_ids: number[], _repoInfo: RepoInfo): Promise<WorkItem[]> {
    return []
  },

  getCloneUrl(repoInfo: RepoInfo): string {
    return repoInfo.remoteUrl
  },

  getWorkItemLabel(): string {
    return 'Issue'
  },

  getPrLabel(): string {
    return 'Pull Request'
  },
}

// Register the generic provider as fallback
registerProvider(genericProvider)
