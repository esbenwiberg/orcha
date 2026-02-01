# Blueprint: Git Actions Menu for Sessions

## Goal

Add a git actions menu to the web dashboard that allows users to perform common git operations (commit, push, create PR, merge origin/main) on the repository associated with a session, with a "What? Why? How?" template for PR creation.

## Non-Goals

- Full git GUI/client functionality (viewing diffs, staging individual files, etc.)
- Git history visualization or log browser
- Conflict resolution UI
- Branch creation/management UI
- Multiple remote support (assume origin only)

## Acceptance Criteria

- [ ] Actions menu accessible from session panel header (⋮ button or similar)
- [ ] Menu contains: Commit, Push, Create PR, Merge origin/main
- [ ] Commit action opens a dialog for commit message input
- [ ] Push executes `git push` on the session's repo
- [ ] Create PR opens dialog with "What? Why? How?" template, uses `gh pr create`
- [ ] Merge origin/main executes `git fetch origin && git merge origin/main`
- [ ] Actions execute in the correct repository directory (from instance's `repoPath`)
- [ ] Visual feedback during execution (loading state)
- [ ] Success/error notifications after completion
- [ ] Actions accessible via keyboard shortcuts (Ctrl+A g for git menu)

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        Frontend (app.js)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐ │
│  │ Actions Menu│  │ Commit      │  │ PR Dialog               │ │
│  │ (dropdown)  │──│ Dialog      │  │ (What/Why/How template) │ │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘ │
│         │                │                    │                 │
│         └────────────────┴────────────────────┘                 │
│                          │                                      │
│                    POST /api/git/:action                        │
└──────────────────────────┼──────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│                     Backend (server.ts)                         │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │ /api/git/:action endpoint                                   ││
│  │ - Validates instanceId                                      ││
│  │ - Executes git commands via child_process in repoPath       ││
│  │ - Returns { success, output, error }                        ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. User clicks actions menu (⋮) on session panel → shows dropdown
2. User selects action (e.g., "Create PR")
3. If action needs input → dialog opens
4. Frontend sends POST `/api/git/{action}` with `{ instanceId, ...params }`
5. Backend looks up `repoPath` from instance registry
6. Backend executes git command with `cwd: repoPath`
7. Backend returns result
8. Frontend shows success/error toast notification

### API Endpoints

```
POST /api/git/status
  Body: { instanceId }
  Returns: { branch, hasChanges, ahead, behind }

POST /api/git/commit
  Body: { instanceId, message }
  Returns: { success, commitHash?, error? }

POST /api/git/push
  Body: { instanceId }
  Returns: { success, output?, error? }

POST /api/git/pull-main
  Body: { instanceId }
  Returns: { success, output?, error? }

POST /api/git/create-pr
  Body: { instanceId, title, body }
  Returns: { success, prUrl?, error? }
```

## File Layout

```
src/
├── web/
│   ├── server.ts           # ADD: /api/git/* endpoints
│   └── public/
│       ├── app.js          # ADD: GitActionsMenu, dialogs, handlers
│       ├── style.css       # ADD: Menu, dialog, toast styles
│       └── index.html      # (no changes expected)
└── core/
    └── (existing files unchanged)
```

## Milestones

### Milestone 1: Backend Git API

**Intent**: Add server endpoints for executing git commands safely.

**Files**:
- `src/web/server.ts` - Add `/api/git/*` routes

**Implementation**:
- Add helper function `executeGitCommand(instanceId, command, args)`
- Add `/api/git/status` endpoint (get branch, check for changes)
- Add `/api/git/commit` endpoint
- Add `/api/git/push` endpoint
- Add `/api/git/pull-main` endpoint
- Add `/api/git/create-pr` endpoint (uses `gh pr create`)

**Verification**:
```bash
# Build and start server
npm run build && npm run dev

# Test endpoints with curl
curl -X POST http://localhost:3847/api/git/status \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"orcha"}'
```

### Milestone 2: Actions Menu UI

**Intent**: Add dropdown menu to session panels with git action options.

**Files**:
- `src/web/public/app.js` - Add menu rendering and toggle logic
- `src/web/public/style.css` - Add menu styles

**Implementation**:
- Add "Actions" button (⋮ icon) to panel header
- Create dropdown menu component with options
- Wire up menu toggle on button click
- Close menu on click outside
- Connect menu items to action handlers (stubs initially)

**Verification**:
- Open dashboard in browser
- Click ⋮ button on any panel
- Verify dropdown appears with options
- Verify clicking outside closes menu

### Milestone 3: Commit Dialog

**Intent**: Add commit action with message input dialog.

**Files**:
- `src/web/public/app.js` - Add commit dialog and handler
- `src/web/public/style.css` - Dialog styles (reuse add-repo pattern)

**Implementation**:
- Create dialog with textarea for commit message
- Add "Stage All & Commit" button
- Call `/api/git/commit` on submit
- Show success/error toast

**Verification**:
- Make a change in a test repo
- Open Actions → Commit
- Enter message and submit
- Verify commit was created via `git log`

### Milestone 4: Push and Pull-Main Actions

**Intent**: Add one-click push and merge origin/main actions.

**Files**:
- `src/web/public/app.js` - Add handlers for push/pull

**Implementation**:
- Push: Confirmation dialog → call `/api/git/push`
- Pull Main: Confirmation dialog → call `/api/git/pull-main`
- Toast notifications for results

**Verification**:
- Push: Verify branch is pushed to origin
- Pull Main: Verify latest main is merged in

### Milestone 5: Create PR Dialog

**Intent**: Add PR creation with What/Why/How template.

**Files**:
- `src/web/public/app.js` - Add PR dialog with template

**Implementation**:
- Dialog with:
  - Title input
  - Template body: "## What?\n\n## Why?\n\n## How?\n\n"
  - Pre-filled placeholders
- Call `/api/git/create-pr`
- Show PR URL on success

**Verification**:
- Create a branch with changes
- Open Actions → Create PR
- Fill out template
- Verify PR is created on GitHub

### Milestone 6: Keyboard Shortcuts

**Intent**: Add `Ctrl+A g` to open git actions menu.

**Files**:
- `src/web/public/app.js` - Extend keyboard shortcut handler

**Implementation**:
- Add `g` case in prefix mode switch
- Opens git menu on focused session
- Update shortcut help modal

**Verification**:
- Press `Ctrl+A g`
- Verify git menu opens

## Risks and Unknowns

| Risk | Impact | Mitigation / Probe |
|------|--------|-------------------|
| `gh` CLI not installed | Create PR fails | Check `which gh` on startup, gray out PR option if missing |
| No GitHub remote | Create PR fails | Check remote URL before showing PR option |
| Repo has uncommitted changes | Commit may include unintended files | Show `git status` summary before commit |
| Merge conflicts on pull-main | User left with broken state | Show clear error message, suggest manual resolution |
| Long-running operations | UI appears frozen | Add loading spinner, consider async with polling |

**Probes**:
1. Test `gh pr create` from CLI to understand output format
2. Check how to detect if repo has GitHub remote: `git remote get-url origin`
3. Verify execSync vs exec for long operations (push to slow remote)

## UX Considerations

1. **Menu Location**: Panel header (⋮ button) - consistent with modern UIs
2. **Confirmation**: Destructive/irreversible actions (push, PR) need confirmation
3. **Feedback**: Loading states during execution, toast for results
4. **Accessibility**: Keyboard shortcut `Ctrl+A g` for power users
5. **Context**: Show current branch in menu header for clarity

---

Next: `/probe 'Milestone 1: Backend Git API'`
