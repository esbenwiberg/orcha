# Blueprint: Plan Viewer Button in Session Header

## Goal

Add a "View Plan" button to session panel headers that opens a dialog showing the markdown plan file associated with that session. Plans live in the **worktree** (not session metadata), so they survive context clears.

## Non-Goals (Out of Scope)

- Live editing of plans from the dialog (read-only view)
- Plan generation or modification from the UI
- Plan history/versioning
- Dashboard settings UI (config via file only)
- Complex auto-detection heuristics

## Acceptance Criteria

1. **Convention**: Plans are stored at `.claude/plan.md` in the worktree (gitignored)
2. **Config Override**: Optional `.orcha/config.json` can specify custom `planPath`
3. **API Endpoint**: `GET /api/sessions/:instanceId/:sessionId/plan` returns plan content (or 404 if no plan)
4. **Header Button**: Each session panel header shows a "📋" button (only when plan file exists)
5. **Dialog Display**: Clicking the button opens a modal showing the plan markdown, rendered with basic styling
6. **Context Survival**: Plan persists across session clears because it's in the worktree, not session metadata

## Architecture

### Key Insight: Plans Live in Worktrees

Plans survive context clears because they're stored in the **worktree filesystem**, not in session metadata. Each worktree = one feature branch = one plan.

```
Session cleared? No problem!
    ↓
Worktree still exists: ~/.orcha/worktrees/orcha/session-1-xyz/
    ↓
Plan still there: .claude/plan.md
    ↓
Dashboard reads it on demand
```

### Data Flow

```
┌──────────────────────────────────────────────────────────────────────┐
│                         Web Dashboard                                 │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌─────────────┐    click    ┌────────────────┐   fetch    ┌───────┐ │
│  │ Plan Button │ ──────────► │ showPlanDialog │ ─────────► │ API   │ │
│  │ (in header) │             │    (app.js)    │            │       │ │
│  └─────────────┘             └────────────────┘            └───┬───┘ │
│                                     ▲                          │     │
│                                     │ { content, path }        │     │
│                                     └──────────────────────────┘     │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Backend (server.ts)                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  GET /api/sessions/:instanceId/:sessionId/plan                        │
│    1. Get worktreePath from SessionMetadata                           │
│    2. Check for .orcha/config.json → custom planPath                  │
│    3. Default: read {worktreePath}/.claude/plan.md                    │
│    4. Return { content, path } or 404                                 │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌──────────────────────────────────────────────────────────────────────┐
│                         Worktree Filesystem                          │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ~/.orcha/worktrees/orcha/session-1-xyz/                              │
│  ├── .claude/                                                         │
│  │   └── plan.md          ← DEFAULT: plan lives here (gitignored)    │
│  ├── .orcha/                                                          │
│  │   └── config.json      ← OPTIONAL: { "planPath": "docs/plan.md" } │
│  ├── src/                                                             │
│  └── ...                                                              │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Components Modified

| Component | Changes |
|-----------|---------|
| `src/web/server.ts` | Add GET `/api/sessions/:id/:sid/plan` endpoint |
| `src/web/public/app.js` | Add plan button to header, dialog to show plan |
| `src/web/public/style.css` | Styles for plan button and plan dialog |

**Note**: No changes to `session-store.ts` needed - plans live in worktree filesystem.

### Plan Resolution Logic

```typescript
function resolvePlanPath(worktreePath: string): string | null {
  // 1. Check for custom config
  const configPath = join(worktreePath, '.orcha', 'config.json')
  if (existsSync(configPath)) {
    const config = JSON.parse(readFileSync(configPath, 'utf-8'))
    if (config.planPath) {
      const customPath = join(worktreePath, config.planPath)
      if (existsSync(customPath)) return customPath
    }
  }

  // 2. Default location
  const defaultPath = join(worktreePath, '.claude', 'plan.md')
  if (existsSync(defaultPath)) return defaultPath

  return null
}
```

## File Layout (Key Changes)

```
src/
├── web/
│   ├── server.ts              # Add plan API endpoint
│   └── public/
│       ├── app.js             # Add plan button + dialog
│       └── style.css          # Add plan dialog styles

# In each worktree (not committed):
.claude/
└── plan.md                    # The plan (gitignored)

# Optional config (can be committed):
.orcha/
└── config.json                # { "planPath": "docs/my-plan.md" }
```

## Milestones

### Milestone 1: Add Plan API Endpoint

**Intent**: Backend endpoint to read plan content from worktree.

**Key Files**:
- `src/web/server.ts` - Add GET `/api/sessions/:instanceId/:sessionId/plan`

**Verification**:
```bash
# Build and test endpoint
npm run build

# Create test plan
mkdir -p /tmp/test-worktree/.claude
echo "# Test Plan" > /tmp/test-worktree/.claude/plan.md

# Test with curl (replace with real session)
curl http://localhost:3847/api/sessions/orcha-orcha/session-id/plan
```

---

### Milestone 2: Add Plan Button to Panel Header

**Intent**: Show a plan button in each session's header bar. Button visibility based on plan existence.

**Key Files**:
- `src/web/public/app.js` - Add button in `createTerminalPanel()`
- `src/web/public/style.css` - Style the button

**Verification**:
- Visual inspection in browser
- Button appears (can be always visible, grayed out if no plan)

---

### Milestone 3: Implement Plan Dialog

**Intent**: Modal dialog that fetches and displays plan markdown with basic rendering.

**Key Files**:
- `src/web/public/app.js` - `showPlanDialog()` function
- `src/web/public/style.css` - Dialog styling (reuse existing dialog patterns)

**Verification**:
- Click plan button opens dialog
- Plan content displays with headers, lists, code blocks styled
- Escape key or click outside closes dialog

---

### Milestone 4: Update /blueprint Skill

**Intent**: Make /blueprint write plans to `.claude/plan.md` by convention.

**Key Files**:
- `.claude/commands/blueprint.md` - Update output path

**Verification**:
```bash
# Run /blueprint and verify plan is written to .claude/plan.md
ls -la .claude/plan.md
```

## Risks & Unknowns

| Risk | Impact | Mitigation |
|------|--------|------------|
| Plan file doesn't exist | Low | Show "No plan found" message, button still works |
| Large plan files | Low | Add loading spinner, lazy load content |
| Markdown rendering | Low | Simple CSS styling for pre-formatted text |
| Sessions without worktrees | Medium | Fall back to instance repoPath |

### Quick Probes

1. **Markdown rendering**: Use simple CSS styling (white-space: pre-wrap) or basic regex?
   - **Recommendation**: Start with `<pre>` styling, enhance if needed

2. **Plan existence check**: Check on every render or cache?
   - **Recommendation**: Check in `getAllSessions()`, return `hasPlan: boolean`

## Implementation Notes

### Button Position in Header
The panel header currently has: `[dot] [title] [repo] [status] [⋮] [📁] [⛶] [×]`
Add plan button after status: `[dot] [title] [repo] [status] [📋] [⋮] [📁] [⛶] [×]`

### Session Info Enhancement
The `getAllSessions()` method should return `hasPlan: boolean` flag so the frontend knows whether to show the button without extra API calls.

### Gitignore Convention
Plans should be gitignored since they're ephemeral working documents:
```gitignore
# In .gitignore
.claude/plan.md
```

### CSS Class Names
- `.panel-plan-btn` - Plan button in header
- `.plan-dialog` - Dialog container
- `.plan-content` - Markdown content area (styled `<pre>`)

---

**Next: /probe 'Milestone 1 - Add Plan API Endpoint'**
