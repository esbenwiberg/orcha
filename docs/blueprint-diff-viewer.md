# Blueprint: Pre-Review Diff Viewer Dialog

## Goal

Add a "Review Changes" button to the session panel header that opens a dialog showing:
1. List of changed files (staged, modified, untracked)
2. File diffs with syntax highlighting
3. Summary stats useful for local pre-review before committing

## Non-Goals

- **Not** a full git staging interface (no checkbox to stage/unstage individual files)
- **Not** a code editor (no inline editing of diffs)
- **Not** a merge conflict resolver
- **Not** replacing the existing commit/PR dialogs

## Acceptance Criteria

- [ ] New button appears in session panel header (icon: eye or diff symbol)
- [ ] Button opens a dialog modal using existing overlay pattern
- [ ] Dialog shows **all changes since diverging from main** (commits + uncommitted)
- [ ] Shows commit list (hash + message) for commits on branch
- [ ] Shows file list with status icons (M=modified, A=added, D=deleted)
- [ ] Uncommitted files marked distinctly (e.g., asterisk or different color)
- [ ] Clicking a file shows its diff in the main panel
- [ ] Diff renders with syntax coloring (green=additions, red=deletions)
- [ ] Dialog shows summary: X commits, Y files changed, +Z/-W lines
- [ ] Escape key and backdrop click close the dialog
- [ ] Keyboard shortcut: `Ctrl+A, R` for "Review"
- [ ] Works when there are no changes (shows "No changes" message)
- [ ] Works when on main (shows uncommitted changes only)

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────────┐
│ Frontend (app.js)                                               │
│  ├─ showDiffViewerDialog(instanceId) - new function             │
│  ├─ fetchDiffData(instanceId) - API call                        │
│  └─ renderDiff(diffText) - ANSI to HTML rendering               │
├─────────────────────────────────────────────────────────────────┤
│ Backend (server.ts)                                             │
│  └─ POST /api/git/diff - new endpoint                           │
│     ├─ returns file list with status                            │
│     └─ returns diff content per file or combined                │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. User clicks review button → `showDiffViewerDialog(instanceId)`
2. Dialog shows loading state
3. Fetch `POST /api/git/diff { instanceId }`
4. Backend runs:
   - `git merge-base origin/main HEAD` → find divergence point
   - `git diff <merge-base>...HEAD` → all committed changes on branch
   - `git diff HEAD` → uncommitted working changes
   - `git diff <merge-base>` → **combined view** (commits + uncommitted = full PR preview)
   - `git diff --stat <merge-base>` → summary stats
5. Response:
   ```json
   {
     "branch": "feature/diff-viewer",
     "baseBranch": "origin/main",
     "commits": [
       { "hash": "abc123", "message": "feat: add diff endpoint" },
       { "hash": "def456", "message": "feat: add dialog UI" }
     ],
     "files": [
       { "path": "src/foo.ts", "status": "M", "committed": true },
       { "path": "src/bar.ts", "status": "A", "committed": false }
     ],
     "diff": "full diff text (all branch changes + uncommitted)",
     "stats": { "files": 5, "insertions": 245, "deletions": 32 }
   }
   ```
6. Frontend renders file list + diff view

### UI Layout

```
┌────────────────────────────────────────────────────────┐
│ 📋 Review Changes                              [×]     │
│ orcha-session-1 · feature/diff-viewer → origin/main   │
├──────────────┬─────────────────────────────────────────┤
│ Commits (2)  │ src/web/public/app.js                   │
│ ─────────    │ ─────────────────────────────────────── │
│ ● abc123     │ @@ -173,6 +173,45 @@                   │
│ ● def456     │ +function showDiffViewer() {            │
│              │ +  const overlay = document...          │
│ Files (3)    │ +}                                       │
│ ─────────    │                                          │
│ M app.js     │ @@ -1620,0 +1665,8 @@                   │
│ M server.ts  │ +// Review button                        │
│ • new.md  *  │                                          │
│   (* = uncommitted)                                    │
├──────────────┴─────────────────────────────────────────┤
│ 2 commits · 3 files changed · +127 -23 lines           │
└────────────────────────────────────────────────────────┘
```

## File Layout

```
src/web/
├── public/
│   ├── app.js          # Add showDiffViewerDialog(), button in createTerminalPanel()
│   └── style.css       # Add .diff-viewer-* styles
└── server.ts           # Add /api/git/diff endpoint
```

## Milestones

### Milestone 1: Backend Endpoint
**Intent**: Create `/api/git/diff` endpoint that returns file list and diff data

**Files touched**:
- `src/web/server.ts` - add new endpoint

**Verification**:
```bash
# Build and start server
npm run build && npm start

# Test endpoint (use existing instanceId)
curl -X POST http://localhost:3000/api/git/diff \
  -H "Content-Type: application/json" \
  -d '{"instanceId":"orcha-session-1"}' | jq
```

### Milestone 2: Basic Dialog UI
**Intent**: Add button to header, create dialog with file list

**Files touched**:
- `src/web/public/app.js` - add button + dialog function
- `src/web/public/style.css` - add dialog styles

**Verification**:
- Click review button → dialog appears
- File list renders
- Close on Escape/backdrop

**Sync dist**:
```bash
cp src/web/public/app.js dist/web/public/
cp src/web/public/style.css dist/web/public/
```

### Milestone 3: Diff Rendering
**Intent**: Display actual diff content with syntax coloring

**Files touched**:
- `src/web/public/app.js` - add diff rendering logic

**Verification**:
- Select file → diff content appears
- Lines starting with `+` are green
- Lines starting with `-` are red
- `@@` headers are cyan/purple

### Milestone 4: Keyboard Shortcut
**Intent**: Add `Ctrl+A, R` shortcut for quick access

**Files touched**:
- `src/web/public/app.js` - add to keyboard handler

**Verification**:
- Focus a panel
- Press `Ctrl+A`, then `R`
- Dialog opens

## Risks & Unknowns

| Risk | Mitigation / Probe |
|------|-------------------|
| Large diffs may be slow | Add `--stat` summary first, load full diff on demand |
| Binary files in diff | Filter with `git diff --numstat` to detect, show "binary" badge |
| ANSI escape codes rendering | Use simple regex replacement or existing xterm.js parsing |
| Diff for untracked files | Use `git diff --no-index /dev/null <file>` or just show file content |

### Quick Probes Before Starting

1. **Test diff commands for full branch review**:
   ```bash
   cd ~/.orcha/worktrees/orcha/session-1-les9
   # Find merge base (where branch diverged from main)
   git merge-base origin/main HEAD

   # All committed changes on branch
   git diff origin/main...HEAD --stat

   # Full PR preview (commits + uncommitted)
   BASE=$(git merge-base origin/main HEAD)
   git diff $BASE --stat

   # Commits on branch
   git log origin/main..HEAD --oneline
   ```

2. **Check existing ANSI handling**: Look for any existing ANSI-to-HTML in the codebase

## Decision: Diff Scope

**Question**: What should "Review Changes" show?

**Answer**: Everything that would go into a PR:
- All commits on the branch since diverging from `origin/main`
- Plus any uncommitted working directory changes

This is achieved with:
```bash
BASE=$(git merge-base origin/main HEAD)
git diff $BASE  # Full PR preview
```

**Edge cases**:
- On `main` branch → show only uncommitted changes
- No `origin/main` → fall back to `origin/master`, then just uncommitted
- Detached HEAD → show uncommitted only

---

## Decision: Diff Rendering Approach

**Options**:
1. **Raw monospace** - Just `<pre>` with line coloring via CSS classes
2. **ANSI rendering** - Convert git's color output to HTML
3. **diff2html library** - Rich split/unified view with syntax highlighting

**Recommendation**: Start with Option 1 (raw monospace) for MVP. It's fast, works offline, no dependencies. Can upgrade to diff2html later if needed.

---

*Blueprint created: 2026-02-02*

Next: /probe 'Milestone 1 - backend diff endpoint'
