# Orcha Web Dashboard - Implementation Plan

## Vision
Build a Maestro-style web dashboard with fully interactive terminal panels for orcha sessions.

**Reference:** Maestro screenshot shows:
- Left sidebar with Running/Paused sections, status dots
- Grid of terminal panels with headers showing session name + badges
- Real terminal output in each panel (fully interactive)
- Dark purple theme with cute wizard mascot
- 6 panels visible simultaneously

---

## MVP (Phase 1) - What We Build Now

### Goal
Get interactive terminals working in browser. Basic but functional.

### Architecture
```
Browser (localhost:3847)
┌──────────┬────────────────────────────────────┐
│ Sidebar  │  ┌───────────┐  ┌───────────┐      │
│          │  │ Terminal 1│  │ Terminal 2│      │
│ ● #1     │  │ (xterm.js)│  │ (xterm.js)│      │
│ ○ #2     │  └───────────┘  └───────────┘      │
│ ◐ #3     │  ┌───────────┐  ┌───────────┐      │
│          │  │ Terminal 3│  │ Terminal 4│      │
└──────────┴──└───────────┘──└───────────┘──────┘
                ↕ WebSocket (node-pty → tmux pane)
```

### MVP Features
- [x] Express + WebSocket server (started)
- [ ] HTML page with xterm.js (CDN)
- [ ] Grid layout for terminal panels
- [ ] Click panel to focus, type to interact
- [ ] Basic sidebar with session list
- [ ] Dark theme
- [ ] `orcha web` CLI command

### MVP Files
| File | Action |
|------|--------|
| `src/web/server.ts` | Fix/complete |
| `src/web/public/index.html` | Create |
| `src/web/public/app.js` | Create |
| `src/web/public/style.css` | Create |
| `src/cli/index.ts` | Add `orcha web` |

---

## End Goal (Phase 2+) - Full Maestro Experience

### Additional Features
- Running/Paused/Stopped sections in sidebar
- Session badges with status (like "Claude Code v1.53")
- Resizable panels (drag borders)
- Panel maximize/minimize
- Custom themes / purple Maestro theme
- Session creation from UI (+ button)
- Keyboard shortcuts (Ctrl+1-9 to focus)
- Toast notifications for status changes
- Persistent layout preferences
- Cute mascot? 🧙

### Future Tech Additions
- React migration for complex state
- Zustand/Redux for state management
- Tailwind for styling
- Panel drag-and-drop reorder

---

## Implementation Steps (MVP)

### Step 1: Frontend HTML/CSS
- Dark theme base
- CSS Grid for terminal layout
- Sidebar with session list

### Step 2: xterm.js Integration
- Load from CDN (no build step)
- Create terminal instance per session
- Fit addon for auto-resize

### Step 3: WebSocket Wiring
- Connect each terminal to server
- Bidirectional data flow
- Handle reconnection

### Step 4: CLI Command
- `orcha web` - start and open browser
- `orcha web --port 4000` - custom port
- `orcha web --no-open` - server only

### Step 5: Polish
- Focus indicator on selected terminal
- Status colors in sidebar
- Error handling

---

## Verification (MVP)

1. `orcha start -n 3 --no-attach` - Start 3 sessions
2. `orcha web` - Launch dashboard
3. Browser opens with 3 interactive terminals
4. Click terminal #2, type "hello" - verify it appears in that tmux pane
5. Sidebar shows correct status for each session

---

## Dependencies

**Already installed:**
- express, ws, node-pty

**CDN (no install):**
- xterm.js
- xterm-addon-fit
- xterm-addon-web-links
