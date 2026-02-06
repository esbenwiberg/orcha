# Blueprint: Session Creation Info Display

## Goal

When a new session is created, display useful git/worktree context information directly in the terminal session so the user immediately knows the state of their branch — whether a worktree was reused, whether the branch exists on origin, and whether local is in sync with remote.

## Non-Goals

- No new UI dialogs or modals — info goes into the terminal as styled echo output
- No changes to the "New Session" dialog form itself
- No changes to worktree creation logic
- No persistent storage of this info

## Acceptance Criteria

- [ ] On session create, the terminal shows whether a **new worktree was created** or an **existing worktree was reused**
- [ ] Shows whether the **branch exists on origin** (remote tracking)
- [ ] If branch exists on origin, shows whether **local is up-to-date, ahead, behind, or diverged**
- [ ] Shows the **worktree path** for reference
- [ ] Shows the **base branch** the new branch was created from (when creating a new branch)
- [ ] Info is displayed as a compact block of colored echo lines at the top of the terminal, before the AI command runs
- [ ] Frontend toast still shows for worktree reuse (existing behavior preserved)
- [ ] No display when `useWorktree=false` (no worktree mode)

## Architecture

### Approach: Echo lines in tmux pane

The simplest and most useful approach — echo styled info directly into the terminal pane before the AI command starts. This is where the user is looking, requires no new UI components, and the info naturally scrolls away once work begins.

### Data Flow

```
POST /api/sessions
  → WorktreeManager gathers branch/worktree info
  → Server builds info lines
  → TmuxRenderer.runInPane() echoes info block
  → AI command runs after info is displayed
```

### Info Block Format (example output)

```
─── Session #3 ──────────────────────────
  Branch:    orcha/session-3-20260206
  Worktree:  ~/.orcha/worktrees/orcha/session-1-abc1 (reused)
  Origin:    branch exists, local is 2 commits behind
─────────────────────────────────────────
```

Or for a fresh branch:

```
─── Session #1 ──────────────────────────
  Branch:    orcha/feature-xyz (new, from origin/main)
  Worktree:  ~/.orcha/worktrees/orcha/session-1-abc1
  Origin:    branch not on remote
─────────────────────────────────────────
```

## Key Files

| File | Change |
|------|--------|
| `src/web/server.ts` | Gather git info, build info lines, echo to pane |
| `src/core/worktree-manager.ts` | Add `getBranchSyncStatus()` helper |
| `src/web/public/app.js` | Enhance response handling (pass more info for toast) |
| `dist/web/public/app.js` | Copy of above |

## Milestones

### Milestone 1: Add branch sync status helper to WorktreeManager

**Intent:** Add a method that checks whether a branch exists on origin and reports sync status (ahead/behind/diverged/up-to-date).

**Files touched:**
- `src/core/worktree-manager.ts` — add `getBranchSyncStatus(branch: string, worktreePath?: string)` method

**Method returns:**
```typescript
interface BranchSyncInfo {
  existsOnOrigin: boolean
  ahead: number        // commits ahead of origin
  behind: number       // commits behind origin
  baseBranch?: string  // e.g. "origin/main" (only for new branches)
}
```

**Implementation:**
- Use `git rev-parse --verify origin/{branch}` to check if remote branch exists
- If exists, use `git rev-list --left-right --count origin/{branch}...{branch}` to get ahead/behind
- If working in a worktree, use `git -C {worktreePath}` to run commands in the right context

**Verification:**
```bash
npx tsc --noEmit
```

### Milestone 2: Build and echo info block in server.ts

**Intent:** After session creation, gather info and echo a formatted block into the tmux pane before the AI command runs.

**Files touched:**
- `src/web/server.ts` — in `POST /api/sessions` handler, between pane creation and AI command execution

**Logic:**
1. After worktree is created/reused (line ~446), gather info:
   - `reusedWorktree` (already available)
   - Call `worktreeManager.getBranchSyncStatus(branch, workDir)`
2. Build info lines array
3. Echo each line into the pane using `sessionTmux.runInPane()`
4. Then run the AI command (existing code)

**Also add to response:**
- `branchInfo.existsOnOrigin`, `branchInfo.ahead`, `branchInfo.behind` in the JSON response so the frontend could use it if needed

**Verification:**
```bash
npx tsc --noEmit
# Manual: create a session and observe info block in terminal
```

### Milestone 3: Frontend toast enhancement (optional)

**Intent:** Show richer toast when session is created — e.g. "Session created on orcha/feature-xyz (2 behind origin)".

**Files touched:**
- `src/web/public/app.js` — update `createSession()` response handling
- `dist/web/public/app.js` — copy

**Verification:**
```bash
cp src/web/public/app.js dist/web/public/app.js
# Manual: create session, check toast message
```

## Risks & Unknowns

| Risk | Mitigation |
|------|-----------|
| `git rev-list --left-right` may fail if branch is brand new (no common ancestor) | Wrap in try/catch, return `{ existsOnOrigin: false, ahead: 0, behind: 0 }` |
| Echoing multiple lines via tmux `send-keys` may have timing issues | Use a single `echo -e` with `\n` for the whole block, or chain with `&&` |
| `git -C` in worktree path — need to ensure the worktree is fully initialized before querying | Query happens after `createSession()` returns, so worktree should be ready |
| Fetch already happens in `WorktreeManager.create()` | No need to fetch again; sync status will be based on already-fetched refs |

## Summary

This is a ~2 milestone task (M3 is optional polish). The core change is:
1. A small helper method on WorktreeManager
2. ~30 lines in server.ts to build and echo the info block

The echo approach is the right call — it's where the user is already looking, it requires no new UI, and it naturally scrolls away.

---

Next: /probe 'Milestone 1 - add getBranchSyncStatus to WorktreeManager'
