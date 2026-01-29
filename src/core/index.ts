/**
 * Orcha Core Library
 * Re-exports all core types and classes
 */

export * from './types.js'
export { StatusMonitor, getStatusDirForInstance } from './status-monitor.js'
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
