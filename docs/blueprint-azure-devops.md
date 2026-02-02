# Blueprint: Azure DevOps Repository Support

## Goal

Enable Orcha to work with Azure DevOps repositories in addition to GitHub, including:
1. Adding Azure DevOps repos to the dashboard (clone or local)
2. Git operations (commit, push, create PR) via Azure DevOps APIs
3. Batch processing Azure DevOps work items (similar to GitHub issues)

---

## Non-Goals (Out of Scope)

- **Azure DevOps Pipelines integration** - No build/deploy triggers from Orcha
- **Azure DevOps Wiki** - Focus on repos and work items only
- **Azure DevOps Test Plans** - Out of scope for this feature
- **Migration from GitHub** - This adds support, doesn't replace
- **Azure DevOps Server (on-premises)** - Focus on Azure DevOps Services (cloud)
- **Multiple organization support** - Single org configured at a time

---

## Acceptance Criteria

- [ ] Can add a local repo with Azure DevOps remote to the dashboard
- [ ] Can clone an Azure DevOps repo via URL (https://dev.azure.com/org/project/_git/repo)
- [ ] Dashboard detects repo provider type (GitHub vs Azure DevOps)
- [ ] Git actions menu works for Azure DevOps repos:
  - [ ] Commit (uses local git - same as before)
  - [ ] Push (uses local git - same as before)
  - [ ] Create PR (uses MCP azure-devops tools or `az repos pr create`)
- [ ] Batch work items feature (like batch issues):
  - [ ] Input: work item IDs or URLs
  - [ ] Creates sessions with branch per work item
  - [ ] Links work items to PRs when created
- [ ] Repository provider type displayed in UI (subtle indicator)
- [ ] Non-GitHub repos gracefully disable GitHub-specific features

---

## Architecture

### Current State

```
┌─────────────────────────────────────────────────────────────────┐
│                       Current Architecture                       │
│                                                                  │
│  ┌─────────────┐     ┌──────────────┐     ┌─────────────────┐   │
│  │ Dashboard   │────▶│ server.ts    │────▶│ GitHub API      │   │
│  │ (app.js)    │     │ /api/git/*   │     │ (gh CLI)        │   │
│  └─────────────┘     └──────────────┘     └─────────────────┘   │
│         │                   │                                    │
│         │                   │              ┌─────────────────┐   │
│         │                   └─────────────▶│ Local Git       │   │
│         │                                  │ (spawnSync)     │   │
│         │                                  └─────────────────┘   │
│         │                                                        │
│         ▼                                                        │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ Hard-coded GitHub assumptions:                               ││
│  │ - Remote URL parsing: /github\.com[:/]/                      ││
│  │ - PR creation: gh pr create                                  ││
│  │ - Issue fetching: gh issue view                              ││
│  │ - Clone: gh repo clone                                       ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Proposed Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                      Proposed Architecture                           │
│                                                                      │
│  ┌─────────────┐     ┌──────────────┐     ┌────────────────────────┐│
│  │ Dashboard   │────▶│ server.ts    │────▶│ VCS Provider Resolver  ││
│  │ (app.js)    │     │ /api/git/*   │     │ (vcs-provider.ts)      ││
│  └─────────────┘     └──────────────┘     └───────────┬────────────┘│
│                                                        │             │
│                            ┌───────────────────────────┼────────────┐│
│                            │                           │            ││
│                            ▼                           ▼            ││
│                   ┌─────────────────┐       ┌───────────────────┐  ││
│                   │ GitHubProvider  │       │ AzureDevOpsProvider │ ││
│                   │ (gh CLI)        │       │ (MCP tools / az CLI)│  ││
│                   └─────────────────┘       └───────────────────┘  ││
│                            │                           │            ││
│                            ▼                           ▼            ││
│                   ┌─────────────────────────────────────────────┐  ││
│                   │              Local Git                       │  ││
│                   │   (shared: commit, push, branch, worktree)   │  ││
│                   └─────────────────────────────────────────────┘  ││
└─────────────────────────────────────────────────────────────────────┘
```

### Provider Interface

```typescript
// src/core/vcs-provider.ts

interface VcsProvider {
  type: 'github' | 'azure-devops' | 'generic'

  // Detection
  matchesRemoteUrl(url: string): boolean

  // Repo info extraction
  parseRemoteUrl(url: string): RepoInfo | null

  // PR operations
  createPullRequest(options: CreatePrOptions): Promise<PrResult>

  // Work item / issue operations
  getWorkItem(id: number): Promise<WorkItem | null>
  listWorkItems(ids: number[]): Promise<WorkItem[]>

  // Clone support
  getCloneUrl(repoInfo: RepoInfo): string

  // UI hints
  getWorkItemLabel(): string  // "Issue" for GitHub, "Work Item" for ADO
  getPrLabel(): string        // "Pull Request" for both
}

interface RepoInfo {
  type: 'github' | 'azure-devops' | 'generic'
  owner?: string        // GitHub: owner, ADO: organization
  project?: string      // ADO only: project name
  repo: string          // Repository name
  remoteUrl: string     // Original remote URL
}
```

### Remote URL Detection

| Provider | URL Patterns |
|----------|-------------|
| GitHub | `github.com/owner/repo` |
|        | `git@github.com:owner/repo.git` |
| Azure DevOps | `dev.azure.com/org/project/_git/repo` |
|              | `org.visualstudio.com/project/_git/repo` |
|              | `ssh.dev.azure.com/v3/org/project/repo` |
|              | `org@vs-ssh.visualstudio.com/project/repo` |

---

## Key Decisions

### 1. MCP vs Azure CLI for Azure DevOps Operations

**Decision:** Use MCP tools as primary, with `az repos` CLI as fallback.

**Rationale:**
- MCP tools (`mcp__azure-devops__*`) are already available in the environment
- MCP provides consistent interface with built-in auth
- `az repos pr create` requires separate Azure CLI install + login
- MCP tools support all needed operations (PR create, work item read)

**Implementation:**
- Check if MCP tools are callable (try invoke, catch error)
- Fall back to `az repos` CLI if MCP unavailable
- Fall back to "not supported" gracefully if neither available

### 2. Authentication Strategy

**Decision:** Rely on pre-configured MCP authentication.

**Rationale:**
- MCP azure-devops tools handle their own auth
- User configures auth once for all MCP tools
- No need for Orcha to manage Azure DevOps credentials
- `az repos` CLI also uses its own auth (`az login`)

### 3. Work Items vs Issues Naming

**Decision:** Use provider-specific terminology in UI.

- GitHub: "Issues", "PR"
- Azure DevOps: "Work Items", "Pull Request"

The backend uses generic terms (`workItem`, `pullRequest`), UI adapts.

### 4. Clone Location

**Decision:** Use same clone directory for both providers.

```
/mnt/c/repos/.workspace/clones/{repo-name}/
```

Note: Azure DevOps repos may have naming collisions (same repo name in different projects). Handle by appending project name if collision detected.

---

## File Layout (Key Changes)

```
src/
├── core/
│   ├── vcs-provider.ts      # NEW: VCS provider interface + resolver
│   ├── github-provider.ts   # NEW: GitHub-specific operations
│   ├── azure-devops-provider.ts  # NEW: Azure DevOps-specific operations
│   ├── types.ts             # UPDATE: Add VcsProviderType, RepoInfo
│   └── instance-registry.ts # UPDATE: Store provider type with instance
├── web/
│   ├── server.ts            # UPDATE: Use provider abstraction
│   └── public/
│       ├── app.js           # UPDATE: Provider-aware UI
│       └── style.css        # UPDATE: Provider indicator styles
```

---

## Milestones

### Milestone 1: VCS Provider Abstraction Layer

**Intent:** Create provider interface and detection logic without changing behavior.

**Files touched/created:**
- `src/core/vcs-provider.ts` (NEW)
- `src/core/github-provider.ts` (NEW)
- `src/core/types.ts` (UPDATE)

**Key changes:**
```typescript
// vcs-provider.ts
export type VcsProviderType = 'github' | 'azure-devops' | 'generic'

export interface VcsProvider { ... }

export function detectProvider(remoteUrl: string): VcsProviderType
export function getProvider(remoteUrl: string): VcsProvider
```

**Verification:**
```bash
npm run build
# Add test: detectProvider('https://github.com/foo/bar') === 'github'
# Add test: detectProvider('https://dev.azure.com/org/project/_git/repo') === 'azure-devops'
```

---

### Milestone 2: GitHub Provider Implementation

**Intent:** Extract existing GitHub logic into dedicated provider.

**Files touched:**
- `src/core/github-provider.ts` (UPDATE from scaffold)
- `src/web/server.ts` (UPDATE: delegate to provider)

**Key changes:**
- Move `gh CLI` calls from server.ts into GitHubProvider
- Keep existing behavior, just reorganized

**Verification:**
```bash
npm run build
# Test: Add GitHub repo, commit, push, create PR - all work as before
```

---

### Milestone 3: Azure DevOps Provider Implementation

**Intent:** Implement Azure DevOps provider with MCP tools.

**Files touched/created:**
- `src/core/azure-devops-provider.ts` (NEW)
- `src/core/mcp-client.ts` (NEW - helper for calling MCP tools)

**Key changes:**
```typescript
// azure-devops-provider.ts
export class AzureDevOpsProvider implements VcsProvider {
  async createPullRequest(options: CreatePrOptions): Promise<PrResult> {
    // Call mcp__azure-devops__repo_create_pull_request
  }

  async getWorkItem(id: number): Promise<WorkItem | null> {
    // Call mcp__azure-devops__wit_get_work_item
  }
}
```

**Verification:**
```bash
npm run build
# Test: Add Azure DevOps repo, verify provider detection
# Test: Create PR on ADO repo (requires ADO MCP config)
```

---

### Milestone 4: Update Instance Registry with Provider Type

**Intent:** Store and retrieve provider type with each instance.

**Files touched:**
- `src/core/instance-registry.ts` (UPDATE)
- `src/core/types.ts` (UPDATE)

**Key changes:**
```typescript
// types.ts
export interface InstanceInfo {
  // ... existing fields
  providerType: VcsProviderType  // NEW
  repoInfo?: RepoInfo            // NEW
}
```

**Verification:**
```bash
npm run build
# Test: Register instance, verify providerType stored in ~/.orcha/instances.json
```

---

### Milestone 5: Update Server APIs to Use Provider

**Intent:** Route PR creation and work item fetching through provider.

**Files touched:**
- `src/web/server.ts` (UPDATE)

**Key changes:**
- `/api/git/create-pr` uses `provider.createPullRequest()`
- `/api/github/issues` becomes `/api/workitems` with provider-aware logic
- `/api/instances/clone` supports Azure DevOps URLs

**Verification:**
```bash
npm run build
curl -X POST http://localhost:3847/api/instances/clone -H 'Content-Type: application/json' \
  -d '{"repoUrl": "https://dev.azure.com/org/project/_git/repo"}'
# Should clone and register with providerType: 'azure-devops'
```

---

### Milestone 6: Update Dashboard UI

**Intent:** Add provider indicator and adapt batch dialog.

**Files touched:**
- `src/web/public/app.js` (UPDATE)
- `src/web/public/style.css` (UPDATE)

**Key changes:**
- Show provider icon/badge next to repo name in sidebar
- "Batch Issues" becomes "Batch Work Items" for ADO repos
- Add repo dialog supports Azure DevOps URL format
- Disable GitHub-specific features for non-GitHub repos gracefully

**UI mockup:**
```
SIDEBAR:
├── [gh] orcha               ← GitHub indicator
│   └── session-1
├── [ado] my-ado-project     ← Azure DevOps indicator
│   └── session-2
└── [+] Add Repo
```

**Verification:**
```bash
npm run build
cp src/web/public/* dist/web/public/
# Test: Add ADO repo, verify indicator shows
# Test: Batch Work Items dialog opens for ADO repos
```

---

### Milestone 7: Batch Work Items Feature

**Intent:** Enable batch processing of Azure DevOps work items.

**Files touched:**
- `src/web/server.ts` (UPDATE: add `/api/batch-workitems`)
- `src/web/public/app.js` (UPDATE: batch dialog for work items)

**Key changes:**
- New endpoint `/api/batch-workitems` (mirrors `/api/batch-issues`)
- Work item URL parsing: `https://dev.azure.com/org/project/_workitems/edit/123`
- Creates branches like `fix/workitem-123-{date}`
- Uses `/flow-auto` with work item URL

**Verification:**
```bash
npm run build
# Test: Enter work item IDs in batch dialog
# Test: Sessions created with correct branches
```

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| MCP tools unavailable | Can't create PRs for ADO | Graceful fallback to "not supported" message; document MCP setup |
| ADO auth complexity | Users can't connect | Clear error messages; link to MCP azure-devops setup docs |
| URL parsing edge cases | Wrong provider detected | Comprehensive regex patterns; fallback to 'generic' |
| Repo name collision | Wrong instance matched | Use org+project+repo as unique key |
| Different ADO URL formats | Some URLs not recognized | Support all known formats (dev.azure.com, visualstudio.com, SSH) |

---

## Open Questions

1. **Should we support Azure DevOps Server (on-premises)?**
   - Current scope: No, focus on Azure DevOps Services (cloud)
   - Future: Could add with custom organization URL config

2. **How to handle ADO repos without MCP configured?**
   - Recommendation: Show "Configure Azure DevOps MCP to enable PR creation"
   - Allow commit/push (local git works), disable PR/work item features

3. **Should batch work items support different work item types?**
   - GitHub issues are simple; ADO has User Stories, Bugs, Tasks, etc.
   - Recommendation: Treat uniformly for now; type info in preview

4. **PR auto-linking to work items?**
   - ADO has AB#123 syntax in commit messages
   - Recommendation: Auto-include "AB#{workItemId}" in PR description

---

## Implementation Order

1. **Milestone 1** - Provider abstraction (foundation)
2. **Milestone 2** - GitHub provider (no behavior change, refactor)
3. **Milestone 4** - Instance registry update (small, needed early)
4. **Milestone 3** - Azure DevOps provider (core feature)
5. **Milestone 5** - Server API updates (integration)
6. **Milestone 6** - Dashboard UI (user-visible)
7. **Milestone 7** - Batch work items (full feature parity)

**Estimated scope:** Medium-sized feature (5-7 patches across milestones)

---

## Dependencies

- **MCP Azure DevOps tools** - Must be configured for full functionality
- **No new npm packages** - Uses existing infrastructure
- **No breaking changes** - GitHub repos continue working identically

---

Next: `/probe 'Milestone 1 - VCS Provider Abstraction Layer'`
