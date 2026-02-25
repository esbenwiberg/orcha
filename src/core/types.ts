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
  sourceBranch?: string // Base branch to create worktree from (e.g. "release/2.2.0")
  mode?: SessionMode
  workingDirectory: string
  repoPath: string
  existingWorktreePath?: string // Reuse an existing worktree instead of creating one
  ephemeral?: boolean // If true, session and worktree are cleaned up automatically when done
  profileId?: string // Optional: provider profile ID
  model?: string // Optional: AI model override (e.g. "claude-opus-4-6")
  apiKey?: string // Optional: ANTHROPIC_API_KEY override
  baseUrl?: string // Optional: ANTHROPIC_BASE_URL override
  useLogin?: boolean // Optional: use claude login credentials (unsets ANTHROPIC_API_KEY)
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

export interface BranchSyncInfo {
  existsOnOrigin: boolean
  ahead: number
  behind: number
  baseBranch?: string // e.g. "origin/main" — only set for newly created branches
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

// ============================================================================
// Instance Types (Multi-Repo Support)
// ============================================================================

export interface InstanceInfo {
  instanceId: string // "orcha-myproject"
  repoPath: string // Absolute path to repository
  tmuxSession: string // tmux session name (same as instanceId)
  pid: number // orcha process PID
  startedAt: string // ISO 8601 timestamp
  sessionCount: number // Number of AI sessions
  providerType?: VcsProviderType // VCS provider type (github, azure-devops, generic)
  repoInfo?: RepoInfo // Parsed repository information
}

export interface InstanceRegistry {
  version: number // Schema version
  instances: Record<string, InstanceInfo> // keyed by instanceId
}

// ============================================================================
// VCS Provider Types (Multi-Provider Support)
// ============================================================================

export type VcsProviderType = 'github' | 'azure-devops' | 'generic'

export interface RepoInfo {
  type: VcsProviderType
  owner?: string // GitHub: owner, Azure DevOps: organization
  project?: string // Azure DevOps only: project name
  repo: string // Repository name
  remoteUrl: string // Original remote URL
}

export interface CreatePrOptions {
  title: string
  body?: string
  sourceBranch: string
  targetBranch: string
  repoPath: string
  repoInfo: RepoInfo
}

export interface PrResult {
  success: boolean
  prUrl?: string
  prNumber?: number
  error?: string
}

export interface WorkItem {
  id: number
  title: string
  type: string // 'Issue' for GitHub, 'Bug'/'User Story'/'Task'/etc for ADO
  state: string
  url: string
  assignee?: string
  labels?: string[]
}

// ============================================================================
// Action Types (Custom Action Buttons)
// ============================================================================

export interface Action {
  id: string // UUID
  name: string // Display name (e.g., "Check Mail")
  icon: string // Single emoji/symbol (e.g., "📧")
  script: string // Shell script content to execute
  createdAt: string // ISO 8601 timestamp
  updatedAt: string // ISO 8601 timestamp
}

export interface ActionsStore {
  version: number // Schema version
  actions: Action[]
}

// ============================================================================
// Provider Profile Types (Per-Session Provider Config)
// ============================================================================

export interface ProviderProfile {
  id: string // UUID
  name: string // Display name (e.g., "Qwen via Azure", "Claude Work")
  model: string // Model identifier (e.g., "claude-opus-4-6", "qwen2.5-coder-32b-instruct")
  baseUrl?: string // ANTHROPIC_BASE_URL override
  apiKey?: string // ANTHROPIC_API_KEY (stored plaintext, file chmod 0o600)
  useLogin?: boolean // Use claude login credentials instead of an API key
  createdAt: string // ISO 8601 timestamp
  updatedAt: string // ISO 8601 timestamp
}

export interface ProfilesStore {
  version: number // Schema version
  profiles: ProviderProfile[]
}
