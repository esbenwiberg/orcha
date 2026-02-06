# Blueprint: Multiple Source Branch Support

## Goal

Allow sessions to branch from **any** source branch (e.g. `release/2.2.0`, `develop`), not just `origin/main` or `origin/master`. This enables workflows like spinning up hotfix branches based on release branches.

## Non-Goals

- Per-repo persistent config files (`.orcharc`, `orcha.config.json`) — keep it runtime params for now
- Changing the branch naming convention (`orcha/session-*`)
- Auto-detecting "the right" source branch from context
- PR target branch logic (already handled separately via `targetBranch` in `CreatePrOptions`)

## Acceptance Criteria

- [ ] Web UI "New Session" dialog has a "Source branch" input field (defaults empty = auto-detect main/master)
- [ ] API `POST /api/sessions` accepts optional `sourceBranch` parameter
- [ ] CLI `orcha start` accepts `--source <branch>` flag
- [ ] `WorktreeManager.create()` accepts optional `sourceBranch` and uses it instead of `getDefaultBranch()`
- [ ] Session info block displays correct source (e.g. `(new, from origin/release/2.2.0)`)
- [ ] Existing behavior unchanged when `sourceBranch` is omitted — still falls back to `origin/main` → `origin/master` → `HEAD`
- [ ] Works with both local and remote branch refs (e.g. `release/2.2.0` resolves to `origin/release/2.2.0` if remote exists)

## Architecture

### Data Flow

```
User specifies source branch (UI input / CLI flag / API param)
  ↓
POST /api/sessions { ..., sourceBranch: "release/2.2.0" }
  ↓
server.ts → passes sourceBranch into SessionConfig
  ↓
SessionManager.createSession() → passes to WorktreeManager.create()
  ↓
WorktreeManager.create(sessionId, branch, sourceBranch?)
  ↓
If sourceBranch provided:
  → resolve to origin ref if needed (try origin/<sourceBranch> first, then raw)
  → git worktree add -b <branch> <path> origin/<sourceBranch>
Else:
  → existing getDefaultBranch() logic (origin/main → origin/master → HEAD)
  ↓
BranchSyncInfo.baseBranch reflects actual source used
```

### Components Modified

| File | Change |
|------|--------|
| `src/core/types.ts` | Add `sourceBranch?: string` to `SessionConfig` |
| `src/core/worktree-manager.ts` | `create()` accepts `sourceBranch`, resolve logic |
| `src/core/session-manager.ts` | Pass `sourceBranch` through to `worktrees.create()` |
| `src/web/server.ts` | Accept `sourceBranch` from API, pass through |
| `src/web/public/app.js` | Add source branch input to new-session dialog |
| `src/cli/index.ts` | Add `--source` flag to `orcha start` |

No new files needed. All changes are additive to existing files.

## Milestones

### Milestone 1: Core — WorktreeManager + Types

**Intent:** Thread `sourceBranch` through the core layer so worktrees branch from the right ref.

**Key files:**
- `src/core/types.ts` — add `sourceBranch?: string` to `SessionConfig`
- `src/core/worktree-manager.ts` — modify `create(sessionId, branch, sourceBranch?)`:
  1. If `sourceBranch` provided, resolve it (try `origin/<sourceBranch>` first, then raw ref)
  2. Validate ref exists before attempting worktree creation
  3. Otherwise fall back to existing `getDefaultBranch()`
  4. Use resolved ref in `git worktree add -b ...`
- `src/core/session-manager.ts` — pass `config.sourceBranch` to `this.worktrees.create()`

**Verification:**
```bash
npx tsc --noEmit
```

### Milestone 2: Web API + Server

**Intent:** Accept `sourceBranch` from the HTTP API and thread it to session creation.

**Key files:**
- `src/web/server.ts` — extract `sourceBranch` from request body in `POST /api/sessions`, pass to `SessionConfig`, update info block display to show actual source

**Verification:**
```bash
npx tsc --noEmit
```

### Milestone 3: Web UI

**Intent:** Add a "Source branch" input to the New Session dialog.

**Key files:**
- `src/web/public/app.js` — add input field below branch name, send `sourceBranch` in `createSession()` fetch body
- Copy to `dist/web/public/app.js`

**Verification:**
```bash
cp src/web/public/app.js dist/web/public/app.js
# Manual: open web UI, verify source branch field appears, create session with release branch
```

### Milestone 4: CLI Support

**Intent:** Add `--source <branch>` flag to `orcha start`.

**Key files:**
- `src/cli/index.ts` — add `.option('--source <branch>', 'Source branch to create worktrees from')`, pass to `SessionConfig`

**Verification:**
```bash
npx tsc --noEmit
```

## Risks / Unknowns

| Risk | Mitigation |
|------|------------|
| User types `release/2.2.0` but remote ref is `origin/release/2.2.0` | Resolve logic: try `origin/<input>` first, then raw `<input>`, then fail with clear error |
| Source branch doesn't exist | Validate ref before `git worktree add`; fail early with descriptive message |
| `getBranchSyncStatus()` hardcodes `getDefaultBranch()` as base | Pass actual source used; `baseBranch` already exists in `BranchSyncInfo` type |
| PR target branch should default to source branch not main | Out of scope — note for follow-up |

---

Next: /probe 'Milestone 1: Core — WorktreeManager + Types'
