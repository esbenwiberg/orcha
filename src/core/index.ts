/**
 * Orcha Core Library
 * Re-exports all core types and classes
 */

export * from './types.js'
export {
  StatusMonitor,
  getStatusDirForInstance,
  migrateStatusFromLegacyPaths,
  discoverOrphanedTmuxSessions,
} from './status-monitor.js'
export { WorktreeManager } from './worktree-manager.js'
export { ProcessRegistry } from './process-registry.js'
export { SessionManager } from './session-manager.js'
export { ConfigLoader } from './config-loader.js'
export type { PresetInfo } from './config-loader.js'

// Instance management (multi-repo support)
export {
  generateInstanceId,
  generateInstanceIdWithHash,
  extractRepoName,
  hasHashSuffix,
  isValidInstanceId,
} from './instance-id.js'

export {
  loadRegistry,
  saveRegistry,
  registerInstance,
  unregisterInstance,
  updateInstanceSessionCount,
  updateInstanceProviderInfo,
  getInstance,
  getInstanceByPath,
  findInstanceFromCwd,
  listInstances,
  cleanupStaleInstances,
  getInstanceStatusDir,
  getOrchaDir,
} from './instance-registry.js'

// Session metadata persistence
export {
  loadSessionStore,
  saveSessionStore,
  addSession,
  removeSession,
  clearSessionStore,
  getSessionMetadata,
  getSessionByDisplayId,
} from './session-store.js'
export type { SessionMetadata, SessionStoreData } from './session-store.js'

// Hook installer for Claude Code status updates
export { ensureHooksInstalled, isHookInstalled, installHooks } from './hook-installer.js'

// VCS Provider abstraction (multi-provider support)
export {
  detectProvider,
  parseRemoteUrl,
  registerProvider,
  getProviderByType,
  getProvider,
  getRegisteredProviders,
  genericProvider,
} from './vcs-provider.js'
export type { VcsProvider } from './vcs-provider.js'

// GitHub provider
export { githubProvider } from './github-provider.js'

// Azure DevOps provider
export { azureDevOpsProvider } from './azure-devops-provider.js'

// Cleanup utilities
export { detectDeadSessions, cleanupDeadSessions, cleanupInstanceRegistry } from './cleanup.js'
export type { DeadSession, CleanupResult } from './cleanup.js'
