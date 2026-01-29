/**
 * Core types for Orcha - Parallel AI Session Orchestrator
 */

// ============================================================================
// Session Types
// ============================================================================

export type SessionState =
  | 'initializing'
  | 'idle'
  | 'working'
  | 'waiting'
  | 'done'
  | 'error'

export type SessionMode = 'claude' | 'gemini' | 'codex' | 'shell'

export interface SessionStatus {
  state: SessionState
  message: string
  lastActivity: Date
  needsInput?: string // Prompt text if waiting for user input
  progress?: number // 0-100 if available
}

export interface Session {
  id: string
  displayId: number // Human-friendly #1, #2, etc.
  branch: string | null
  worktreePath: string | null
  status: SessionStatus
  mode: SessionMode
  pid: number | null
  createdAt: Date
  repoPath: string
}

export interface SessionConfig {
  branch?: string
  mode?: SessionMode
  workingDirectory: string
  repoPath: string
}

// ============================================================================
// Worktree Types
// ============================================================================

export interface WorktreeInfo {
  path: string
  branch: string
  commit: string
  sessionId: string | null // null if not managed by orcha
  isMain: boolean
}

export interface WorktreeConfig {
  baseDir: string // Default: ~/.orcha/worktrees
}

// ============================================================================
// Status Types
// ============================================================================

export interface StatusFileContent {
  agentId: string
  state: SessionState
  message: string
  timestamp: string // ISO 8601
  needsInputPrompt?: string
  progress?: number
}

export interface StatusMonitorConfig {
  statusDir: string // Default: /tmp/orcha/agents
  pollInterval: number // ms, for fallback polling
  idleTimeout: number // ms, mark idle after no activity
}

// ============================================================================
// Process Types
// ============================================================================

export interface ProcessInfo {
  pid: number
  sessionId: string
  command: string
  startedAt: Date
}

// ============================================================================
// Event Types
// ============================================================================

export interface SessionEvent {
  type: 'created' | 'updated' | 'destroyed'
  sessionId: string
  session?: Session
  timestamp: Date
}

export interface StatusEvent {
  type: 'status-change' | 'needs-input' | 'error' | 'done'
  sessionId: string
  status: SessionStatus
  previousState?: SessionState
  timestamp: Date
}

// ============================================================================
// CLI Types
// ============================================================================

export interface StartOptions {
  count: number
  repo: string
  branches?: string[]
  mode?: SessionMode
  preset?: string
}

export interface PresetConfig {
  name: string
  description?: string
  sessions: Array<{
    branch?: string
    mode?: SessionMode
  }>
  repoPath: string
}

// ============================================================================
// Display Types (for CLI/GUI rendering)
// ============================================================================

export interface SessionDisplay {
  id: string
  displayId: number
  state: SessionState
  stateIcon: string // ●, ◐, ○, ✓, ✗
  branch: string
  mode: SessionMode
  message: string
  activity: string // "3s ago", "5m ago"
  needsInput: boolean
}

export const STATE_ICONS: Record<SessionState, string> = {
  initializing: '◌',
  idle: '○',
  working: '●',
  waiting: '◐',
  done: '✓',
  error: '✗',
}

export const STATE_COLORS: Record<SessionState, string> = {
  initializing: 'gray',
  idle: 'white',
  working: 'green',
  waiting: 'yellow',
  done: 'cyan',
  error: 'red',
}

// ============================================================================
// Utility Types
// ============================================================================

export type EventHandler<T> = (event: T) => void

export interface Disposable {
  dispose(): void
}
