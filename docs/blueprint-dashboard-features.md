# Blueprint: Orcha Dashboard Enhanced Features

## Goal

Extend the orcha web dashboard with four key capabilities:
1. **Session filtering** - Select which sessions to display (Ctrl+click panels, click repo names)
2. **Session renaming** - Custom names for sessions with optional auto-naming
3. **Spawn from repo** - Create new sessions from the UI, auto-creating worktrees
4. **Panel fullscreen** - Maximize a single panel within the grid view

---

## Non-Goals (Out of Scope)

- React migration or state management library changes
- Persistent layout preferences across sessions
- Drag-and-drop panel reordering
- Multi-user support or authentication
- Mobile/responsive design beyond what exists
- Terminal themes/customization beyond current dark theme

---

## Acceptance Criteria

### Session Filtering
- [ ] Default: all sessions visible in grid
- [ ] Ctrl+click a panel toggles its visibility (selected/deselected)
- [ ] Click repo name in sidebar shows only sessions from that repo
- [ ] "Show All" button restores full view
- [ ] Visual indicator (dimmed/badge) shows when filtering is active
- [ ] Filter state persists within browser session (not across reloads)

### Session Renaming
- [ ] Click session name in panel header to edit inline
- [ ] API endpoint `PUT /api/sessions/:id/name` to persist name
- [ ] Names stored in session metadata (sessions.json)
- [ ] Auto-naming: sessions auto-labeled with worktree branch or "Session #N"
- [ ] Custom names override auto-names

### Spawn from Repo
- [ ] "+ New Session" button in sidebar (per-repo section)
- [ ] Modal/dropdown to select: repo, branch (optional), mode (claude/gemini/shell)
- [ ] Backend creates worktree + tmux pane + session entry
- [ ] API endpoint `POST /api/sessions` with { repoPath, branch?, mode }
- [ ] New panel appears in grid without page reload

### Panel Fullscreen
- [ ] Double-click panel OR click fullscreen icon in header to maximize
- [ ] Maximized panel takes entire grid area (sidebar remains)
- [ ] Press Escape OR click fullscreen icon again to restore grid
- [ ] Keyboard shortcut: Ctrl+Enter when panel focused
- [ ] Terminal auto-resizes to fill available space

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (app.js)                          │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐     │
│  │ FilterState │  │ NameEditor   │  │ FullscreenManager  │     │
│  │ (Set<key>)  │  │ (inline edit)│  │ (single maximized) │     │
│  └─────────────┘  └──────────────┘  └────────────────────┘     │
│                          │                                      │
│                 ┌────────▼────────┐                            │
│                 │  render()       │                            │
│                 │  applyFilter()  │                            │
│                 └─────────────────┘                            │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP/WebSocket
┌────────────────────────────▼────────────────────────────────────┐
│                    Backend (server.ts)                          │
│                                                                 │
│  GET  /api/sessions         - List sessions (unchanged)         │
│  PUT  /api/sessions/:id/name - Rename session (NEW)            │
│  POST /api/sessions          - Create session (NEW)            │
│  DELETE /api/sessions/:id    - Kill session (NEW)              │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                    Core (session-store.ts)                      │
│                                                                 │
│  SessionMetadata.customName?: string  (NEW field)               │
│  updateSessionName()                  (NEW function)           │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Filtering**: Pure frontend state. `state.visibleSessions: Set<string>` controls which panels render.
2. **Renaming**: UI triggers `PUT /api/sessions/:id/name` → updates `sessions.json` → broadcasts to other tabs (optional).
3. **Spawning**: UI sends `POST /api/sessions` → backend calls `SessionManager.createSession()` + `TmuxRenderer.createPane()` → returns new session → frontend adds panel.
4. **Fullscreen**: Pure frontend. `state.fullscreenKey: string | null` triggers CSS class change.

---

## File Layout (Key Changes)

```
src/
├── web/
│   ├── server.ts           # Add PUT/POST/DELETE endpoints
│   └── public/
│       ├── index.html      # Add modal for new session
│       ├── app.js          # Add filter, rename, fullscreen logic
│       └── style.css       # Add fullscreen styles, filter indicators
└── core/
    └── session-store.ts    # Add customName field, updateSessionName()
```

---

## Milestones

### Milestone 1: Panel Fullscreen (simplest, no backend)

**Intent**: Add maximize/restore capability to panels for focused work.

**Files touched**:
- `src/web/public/app.js` - fullscreen state, double-click handler, Escape key
- `src/web/public/style.css` - `.terminal-panel.fullscreen` styles
- `src/web/public/index.html` - fullscreen icon in header template (optional)

**Verification**:
```bash
npm run build
orcha start -n 3 -r . --no-attach
orcha web --no-open
# Open http://localhost:3847
# Double-click a panel -> should maximize
# Press Escape -> should restore grid
# Ctrl+Enter with panel focused -> should toggle fullscreen
```

---

### Milestone 2: Session Filtering (frontend-only)

**Intent**: Allow user to show/hide sessions by clicking panels or repo headers.

**Files touched**:
- `src/web/public/app.js` - `state.visibleSessions`, Ctrl+click handler, repo click handler
- `src/web/public/style.css` - dimmed states, "Show All" button styles

**Verification**:
```bash
# With dashboard running:
# Ctrl+click a panel -> panel should toggle visibility
# Click repo name in sidebar -> only that repo's sessions visible
# Click "Show All" -> all panels visible
# Filter indicator shows when not viewing all
```

---

### Milestone 3: Session Renaming

**Intent**: Allow custom names for sessions, stored persistently.

**Files touched**:
- `src/core/session-store.ts` - add `customName` to `SessionMetadata`, add `updateSessionName()`
- `src/web/server.ts` - add `PUT /api/sessions/:id/name` endpoint
- `src/web/public/app.js` - inline edit on click, blur/Enter to save
- `src/web/public/style.css` - editable name styles

**Verification**:
```bash
npm run build
# With dashboard running:
# Click session name -> should become editable input
# Type new name, press Enter -> name persists after refresh
# Check /tmp/orcha/{instance}/sessions.json has customName field
```

---

### Milestone 4: Spawn Session from UI

**Intent**: Create new sessions directly from dashboard without CLI.

**Files touched**:
- `src/web/server.ts` - add `POST /api/sessions`, `DELETE /api/sessions/:id`
- `src/web/public/index.html` - add "+ New" button, modal/dropdown HTML
- `src/web/public/app.js` - modal logic, API call, add new panel
- `src/web/public/style.css` - modal styles, button styles

**Verification**:
```bash
npm run build
# With dashboard running:
# Click "+ New Session" in sidebar
# Select repo, optionally enter branch name, select mode
# Click "Create" -> new panel appears in grid
# New session visible in tmux: tmux list-panes -t orcha-<repo>
# Kill session via UI (if implemented) -> panel removed, tmux pane killed
```

---

## Risks & Probes

| Risk | Impact | Probe |
|------|--------|-------|
| **Worktree creation slow** | Spawn feels laggy | Measure `WorktreeManager.create()` time. If >2s, show loading indicator. |
| **Name conflicts** | Two sessions same name | Allow duplicates (names are display-only, IDs are unique). |
| **Fullscreen resize issues** | Terminal garbled after maximize | Test `fitAddon.fit()` in resize handler. May need `requestAnimationFrame` delay. |
| **Filter state lost on refresh** | User confusion | Intentional for MVP. Could use `sessionStorage` later. |
| **WebSocket reconnect during spawn** | New panel fails to connect | Add retry logic in `initTerminal()`. |

### Quick Probes to Run First

1. **Test worktree speed**:
   ```bash
   time git worktree add /tmp/test-wt -b test-branch
   git worktree remove /tmp/test-wt
   ```

2. **Test xterm resize in fullscreen**:
   ```javascript
   // In browser console with dashboard open:
   const term = state.terminals.values().next().value;
   term.fitAddon.fit();
   console.log(term.term.cols, term.term.rows);
   ```

3. **Check session-store write permissions**:
   ```bash
   touch /tmp/orcha/test-instance/sessions.json
   cat /tmp/orcha/test-instance/sessions.json
   ```

---

## Open Questions

1. **Auto-naming strategy**: Should auto-names use branch name, task description from Claude status, or just "Session #N"?
   - **Recommendation**: Use branch name if present, otherwise "Session #N"

2. **Spawn modal vs dropdown**: Full modal or simple dropdown?
   - **Recommendation**: Start with dropdown for simplicity (repo list, branch input, mode select)

3. **Filter persistence**: Should filter survive page refresh?
   - **Recommendation**: No for MVP (use `sessionStorage` if users request it)

---

Next: /probe 'Milestone 1 - Panel Fullscreen'
