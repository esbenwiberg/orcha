/**
 * VCS Provider Tests
 */

import { describe, it, expect } from 'vitest'
import {
  detectProvider,
  parseRemoteUrl,
  getProvider,
  getProviderByType,
} from '../core/vcs-provider.js'
// Import to ensure providers are registered
import '../core/github-provider.js'
import '../core/azure-devops-provider.js'

describe('VCS Provider Detection', () => {
  describe('detectProvider', () => {
    it('detects GitHub HTTPS URLs', () => {
      expect(detectProvider('https://github.com/owner/repo')).toBe('github')
      expect(detectProvider('https://github.com/owner/repo.git')).toBe('github')
      expect(detectProvider('https://github.com/org/my-repo')).toBe('github')
    })

    it('detects GitHub SSH URLs', () => {
      expect(detectProvider('git@github.com:owner/repo.git')).toBe('github')
      expect(detectProvider('git@github.com:org/my-repo.git')).toBe('github')
    })

    it('detects Azure DevOps dev.azure.com URLs', () => {
      expect(detectProvider('https://dev.azure.com/org/project/_git/repo')).toBe('azure-devops')
      expect(detectProvider('https://dev.azure.com/myorg/myproject/_git/myrepo')).toBe('azure-devops')
    })

    it('detects Azure DevOps visualstudio.com URLs', () => {
      expect(detectProvider('https://org.visualstudio.com/project/_git/repo')).toBe('azure-devops')
    })

    it('detects Azure DevOps SSH URLs', () => {
      expect(detectProvider('ssh.dev.azure.com/v3/org/project/repo')).toBe('azure-devops')
    })

    it('returns generic for unknown URLs', () => {
      expect(detectProvider('https://gitlab.com/owner/repo')).toBe('generic')
      expect(detectProvider('https://bitbucket.org/owner/repo')).toBe('generic')
      expect(detectProvider('')).toBe('generic')
    })
  })

  describe('parseRemoteUrl', () => {
    it('parses GitHub HTTPS URLs', () => {
      const result = parseRemoteUrl('https://github.com/owner/repo')
      expect(result).toMatchObject({
        type: 'github',
        owner: 'owner',
        repo: 'repo',
      })
    })

    it('parses GitHub SSH URLs', () => {
      const result = parseRemoteUrl('git@github.com:owner/repo.git')
      expect(result).toMatchObject({
        type: 'github',
        owner: 'owner',
        repo: 'repo',
      })
    })

    it('parses Azure DevOps dev.azure.com URLs', () => {
      const result = parseRemoteUrl('https://dev.azure.com/myorg/myproject/_git/myrepo')
      expect(result).toMatchObject({
        type: 'azure-devops',
        owner: 'myorg',
        project: 'myproject',
        repo: 'myrepo',
      })
    })

    it('parses Azure DevOps visualstudio.com URLs', () => {
      const result = parseRemoteUrl('https://contoso.visualstudio.com/myproject/_git/myrepo')
      expect(result).toMatchObject({
        type: 'azure-devops',
        owner: 'contoso',
        project: 'myproject',
        repo: 'myrepo',
      })
    })

    it('parses Azure DevOps SSH URLs', () => {
      const result = parseRemoteUrl('ssh.dev.azure.com/v3/org/project/repo')
      expect(result).toMatchObject({
        type: 'azure-devops',
        owner: 'org',
        project: 'project',
        repo: 'repo',
      })
    })

    it('returns null for empty URL', () => {
      expect(parseRemoteUrl('')).toBeNull()
    })
  })

  describe('Provider Registry', () => {
    it('returns GitHub provider for GitHub URLs', () => {
      const provider = getProvider('https://github.com/owner/repo')
      expect(provider).toBeTruthy()
      expect(provider?.type).toBe('github')
      expect(provider?.getWorkItemLabel()).toBe('Issue')
      expect(provider?.getPrLabel()).toBe('Pull Request')
    })

    it('returns generic provider for unknown URLs', () => {
      const provider = getProvider('https://gitlab.com/owner/repo')
      expect(provider).toBeTruthy()
      expect(provider?.type).toBe('generic')
    })

    it('can get provider by type', () => {
      const github = getProviderByType('github')
      expect(github).toBeTruthy()
      expect(github?.type).toBe('github')

      const generic = getProviderByType('generic')
      expect(generic).toBeTruthy()
      expect(generic?.type).toBe('generic')
    })

    it('returns Azure DevOps provider for Azure DevOps URLs', () => {
      const provider = getProvider('https://dev.azure.com/org/project/_git/repo')
      expect(provider).toBeTruthy()
      expect(provider?.type).toBe('azure-devops')
      expect(provider?.getWorkItemLabel()).toBe('Work Item')
      expect(provider?.getPrLabel()).toBe('Pull Request')
    })

    it('can get Azure DevOps provider by type', () => {
      const ado = getProviderByType('azure-devops')
      expect(ado).toBeTruthy()
      expect(ado?.type).toBe('azure-devops')
    })
  })

  describe('Azure DevOps Provider', () => {
    it('generates correct clone URL', () => {
      const provider = getProviderByType('azure-devops')
      expect(provider).toBeTruthy()

      const repoInfo = {
        type: 'azure-devops' as const,
        owner: 'myorg',
        project: 'myproject',
        repo: 'myrepo',
        remoteUrl: 'https://dev.azure.com/myorg/myproject/_git/myrepo',
      }

      const cloneUrl = provider!.getCloneUrl(repoInfo)
      expect(cloneUrl).toBe('https://dev.azure.com/myorg/myproject/_git/myrepo')
    })

    it('matches Azure DevOps URL patterns', () => {
      const provider = getProviderByType('azure-devops')
      expect(provider).toBeTruthy()

      // dev.azure.com URLs
      expect(provider!.matchesRemoteUrl('https://dev.azure.com/org/project/_git/repo')).toBe(true)

      // visualstudio.com URLs
      expect(provider!.matchesRemoteUrl('https://org.visualstudio.com/project/_git/repo')).toBe(true)

      // SSH URLs
      expect(provider!.matchesRemoteUrl('ssh.dev.azure.com/v3/org/project/repo')).toBe(true)

      // Non-matching URLs
      expect(provider!.matchesRemoteUrl('https://github.com/owner/repo')).toBe(false)
      expect(provider!.matchesRemoteUrl('https://gitlab.com/owner/repo')).toBe(false)
    })
  })
})
