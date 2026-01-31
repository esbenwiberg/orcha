/**
 * Instance ID generation for multi-repo support
 *
 * Generates unique instance IDs from repository paths:
 * - Format: orcha-{repo-name}
 * - Collision handling: append hash suffix for same-named repos
 */

import { createHash } from 'crypto'
import { basename, resolve } from 'path'

/**
 * Generate instance ID from repository path
 *
 * @param repoPath - Absolute or relative path to repository
 * @returns Instance ID like "orcha-myproject"
 */
export function generateInstanceId(repoPath: string): string {
  const absolutePath = resolve(repoPath)
  const repoName = sanitizeRepoName(basename(absolutePath))

  return `orcha-${repoName}`
}

/**
 * Generate instance ID with hash suffix for collision resolution
 *
 * @param repoPath - Absolute path to repository
 * @returns Instance ID with hash like "orcha-myproject-a1b2"
 */
export function generateInstanceIdWithHash(repoPath: string): string {
  const absolutePath = resolve(repoPath)
  const repoName = sanitizeRepoName(basename(absolutePath))
  const hash = createPathHash(absolutePath)

  return `orcha-${repoName}-${hash}`
}

/**
 * Extract repo name from instance ID
 *
 * @param instanceId - Instance ID like "orcha-myproject" or "orcha-myproject-a1b2"
 * @returns Repo name portion
 */
export function extractRepoName(instanceId: string): string {
  // Remove "orcha-" prefix
  const withoutPrefix = instanceId.replace(/^orcha-/, '')

  // Remove hash suffix if present (4 hex chars at end after dash)
  return withoutPrefix.replace(/-[a-f0-9]{4}$/, '')
}

/**
 * Check if an instance ID looks like it has a hash suffix
 */
export function hasHashSuffix(instanceId: string): boolean {
  return /-[a-f0-9]{4}$/.test(instanceId)
}

/**
 * Sanitize repository name for use in tmux session names
 * - Replace non-alphanumeric with dashes
 * - Lowercase
 * - Remove consecutive dashes
 * - Trim leading/trailing dashes
 */
function sanitizeRepoName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    || 'repo'
}

/**
 * Create a short hash from a path for collision resolution
 *
 * @param path - Full path to hash
 * @returns 4-character hex hash
 */
function createPathHash(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 4)
}

/**
 * Validate that a string is a valid instance ID
 */
export function isValidInstanceId(id: string): boolean {
  return /^orcha-[a-z0-9-]+$/.test(id)
}
