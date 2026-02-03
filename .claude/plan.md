# Blueprint: Custom Action Buttons

## Goal

Add customizable action buttons to the Orcha web dashboard navbar (above stats section) that allow users to define and execute custom utility scripts (e.g., check email CLI, daily status reports, run personal tools) in new WSL sessions with a simple UI for configuration. Actions are global/personal utilities, not tied to specific repos.

## Non-Goals

- CLI-based action configuration (web UI only)
- Complex scripting language/DSL
- Action scheduling or automation
- Persistent logs/history of action executions
- Actions that modify existing sessions (only creates new sessions)
- Multi-step workflows or action chaining

## Acceptance Criteria

- [ ] User can open action editor dialog by holding modifier key (Ctrl/Cmd) + clicking a designated area in navbar
- [ ] Dialog allows setting: action name, icon (emoji/symbol), shell script content
- [ ] Actions are saved to `~/.orcha/actions.json` with persistence
- [ ] Action buttons appear in navbar above usage stats section
- [ ] Clicking action button opens new WSL session and executes script
- [ ] Actions are global (not tied to specific repo instances)
- [ ] User can edit/delete existing actions
- [ ] Visual feedback when action is triggered (toast notification)
- [ ] Actions sync between page reloads

## Architecture

### Components

**Frontend (client-side)**
- `ActionBar` component in sidebar (above usage stats)
- `ActionEditorDialog` modal for create/edit
- Client state management for actions array
- Event handlers for Ctrl+click gesture

**Backend (server-side)**
- `ActionsManager` class for CRUD operations
- REST API endpoints:
  - `GET /api/actions` - List all actions
  - `POST /api/actions` - Create action
  - `PUT /api/actions/:id` - Update action
  - `DELETE /api/actions/:id` - Delete action
  - `POST /api/actions/:id/execute` - Execute action (creates new session)

**Data Storage**
- `~/.orcha/actions.json` - JSON file storing global action definitions
- Each action: `{ id, name, icon, script, createdAt, updatedAt }`

**Example Actions**:
- "📧 Check Mail" → `mail-cli inbox --unread`
- "📊 Daily Status" → `daily-report --format=summary`
- "🔍 Search Logs" → `grep -r "ERROR" ~/logs/ | tail -20`
- "🐳 Docker Status" → `docker ps -a`

### Data Flow

1. **Load**: Page loads → fetch `/api/actions` → render action buttons
2. **Create**: User Ctrl+clicks → dialog opens → submits → POST `/api/actions` → save to file → return action → update UI
3. **Execute**: User clicks action → POST `/api/actions/:id/execute` → create tmux session → run script → return session info
4. **Edit**: User Ctrl+clicks button → dialog opens (prefilled) → submits → PUT `/api/actions/:id` → update file → update UI
5. **Delete**: User clicks delete in dialog → DELETE `/api/actions/:id` → remove from file → update UI

### Key Interfaces

```typescript
interface Action {
  id: string              // UUID
  name: string           // Display name (max 20 chars)
  icon: string           // Single emoji/symbol
  script: string         // Shell script content
  createdAt: string      // ISO timestamp
  updatedAt: string      // ISO timestamp
}

interface ActionExecutionResult {
  sessionId: string
  tmuxSession: string
  paneIndex: number
}
```

## Folder/File Layout

```
src/
├── core/
│   └── actions-manager.ts          # New: Action CRUD + execute
├── web/
│   ├── server.ts                   # Update: Add /api/actions/* endpoints
│   └── public/
│       ├── index.html              # Update: Add action bar placeholder
│       ├── app.js                  # Update: Add action UI logic
│       └── style.css               # Update: Add action button styles
└── cli/
    └── types.ts                    # Update: Export Action interface

dist/                                # Mirror src/ changes
~/.orcha/actions.json               # New: Action persistence
```

## Milestones

### Milestone 1: Foundation & Storage

**Intent**: Set up data model, persistence layer, and basic API endpoints without UI.

**Files touched/created**:
- `src/core/actions-manager.ts` - New class for action management
- `src/web/server.ts` - Add GET/POST/PUT/DELETE routes
- `~/.orcha/actions.json` - Auto-created on first use

**Verification**:
```bash
# Create action via curl
curl -X POST http://localhost:3847/api/actions \
  -H 'Content-Type: application/json' \
  -d '{"name":"Test","icon":"🚀","script":"echo hello"}'

# List actions
curl http://localhost:3847/api/actions

# Delete action
curl -X DELETE http://localhost:3847/api/actions/<id>
```

**Unknowns**:
- What's the UX for script execution in WSL vs native? → Probe: Test spawn behavior on Windows
- Should action sessions be added to current instance or standalone? → Probe: Check how `orcha add` attaches to existing instance

---

### Milestone 2: Action Bar UI (Display Only)

**Intent**: Render action buttons in navbar without interaction, fetch from API.

**Files touched/created**:
- `src/web/public/index.html` - Add `<div id="action-bar">` in sidebar
- `src/web/public/app.js` - Add `renderActionBar()`, fetch actions on load
- `src/web/public/style.css` - Style action buttons, hover states
- `dist/web/public/*` - Copy changes

**Verification**:
```bash
# Manually add action to actions.json
echo '[{"id":"1","name":"Build","icon":"🔨","script":"npm run build"}]' > ~/.orcha/actions.json

# Open web dashboard, verify button appears above stats
orcha web
```

**Visual check**: Action button shows icon + name, positioned correctly

---

### Milestone 3: Action Editor Dialog

**Intent**: Build create/edit modal with form fields for name, icon, script.

**Files touched/created**:
- `src/web/public/app.js` - Add `ActionEditorDialog` class/functions
- `src/web/public/style.css` - Dialog styles (overlay, form, buttons)
- `src/web/public/index.html` - Dialog template (can be JS-generated)
- `dist/web/public/*` - Copy changes

**Verification**:
```bash
# In browser dev console
showActionEditorDialog() // Should open modal
```

**Interaction tests**:
1. Click "Add Action" placeholder → dialog opens
2. Fill form → click Save → POST request sent → dialog closes
3. Ctrl+click existing button → dialog opens prefilled → edit → PUT request sent

---

### Milestone 4: Action Execution

**Intent**: Wire up action buttons to create new sessions and run scripts.

**Files touched/created**:
- `src/core/actions-manager.ts` - Add `executeAction()` method
- `src/web/server.ts` - Add POST `/api/actions/:id/execute` endpoint
- `src/web/public/app.js` - Add click handler for action buttons
- `dist/` - Rebuild TypeScript

**Verification**:
```bash
# Create action via UI
# Click action button
# Verify: new tmux session created with script running
tmux ls | grep orcha-action-

# Check session appears in dashboard
# Verify: script output visible in terminal
```

**Edge cases**:
- Script with syntax errors → session should show error
- Long-running script → session stays active
- Script that exits immediately → session should close or stay idle

---

### Milestone 5: Delete & Polish

**Intent**: Add delete functionality, keyboard shortcuts, visual feedback.

**Files touched/created**:
- `src/web/public/app.js` - Add delete button in dialog, Ctrl+click gesture detection
- `src/web/public/style.css` - Delete button styles, toast notifications
- `dist/web/public/*` - Copy changes

**Verification**:
```bash
# UI tests:
# 1. Ctrl+click action → edit dialog opens
# 2. Click delete → confirmation → action removed from UI and file
# 3. Click action button → toast appears "Running [action name]..."
# 4. Reload page → actions persist
```

**UX checks**:
- Ctrl+click doesn't trigger action execution
- Delete requires confirmation
- Toast auto-dismisses after 3s
- Action bar scrolls if many actions

## Risks & Unknowns

### Risk 1: Script execution environment
**Question**: Should scripts run in WSL specifically, or respect the current environment?
**Probe**: Check how `orcha start` spawns sessions, replicate that pattern
**Mitigation**: Use same spawn logic as session creation, expose `--wsl` flag if needed

### Risk 2: Action session isolation
**Question**: Should action-spawned sessions be part of the current orcha instance or standalone?
**Probe**: Review how `orcha add` works for adding sessions to running instances
**Decision**: Standalone tmux sessions (simpler, no repo dependency), can integrate with instance in future

### Risk 3: Script security
**Question**: Do we need sandboxing or warnings for destructive scripts?
**Probe**: Check if Claude Code has script execution warnings
**Mitigation**: Show script content in preview before execution, add "Are you sure?" for first run

### Risk 4: Icon picker UX
**Question**: Simple text input vs full emoji picker?
**Probe**: Check if users prefer typing emoji or selecting from picker
**Decision**: Start with text input (user pastes emoji), iterate based on feedback

### Risk 5: Action name length
**Question**: What's the max length before UI breaks?
**Probe**: Test with long names in narrow sidebar
**Mitigation**: Truncate at 20 chars with ellipsis, show full name on hover

### Risk 6: Script multiline editing
**Question**: Is textarea sufficient or do we need code editor?
**Probe**: Test textarea with realistic scripts (10-20 lines)
**Decision**: Use `<textarea>` with monospace font, add syntax highlighting in future iteration

---

## Next Steps

Next: `/probe 'Milestone 1: Foundation & Storage'`

**Probe checklist**:
1. Examine `src/core/session-manager.ts` to understand session creation pattern
2. Check `src/core/instance-registry.ts` for global vs per-instance data storage
3. Review existing API patterns in `src/web/server.ts` for consistency
4. Verify `~/.orcha/` directory structure and permissions
