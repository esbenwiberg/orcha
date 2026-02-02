# Blueprint: Conditional Skip-Permissions & Batch Dialog Enhancements

## Goal

Restrict `--dangerously-skip-permissions` flag to only sessions spawned from the batch issues dialog (not regular "New Session"), and add user-configurable options to the batch dialog for:
1. A checkbox to enable/disable skip-permissions (default: on, remembered)
2. A command input for the startup command (default: `/flow-auto`, remembered)

## Non-Goals

- Changing the permission model for CLI-spawned sessions
- Adding skip-permissions to the "New Session" dialog
- Server-side persistence of user preferences (will use localStorage)
- Refactoring the entire session creation flow

## Acceptance Criteria

- [ ] Regular "New Session" dialog creates sessions **without** `--dangerously-skip-permissions`
- [ ] Batch issues dialog creates sessions **with** `--dangerously-skip-permissions` only when checkbox is checked
- [ ] Batch dialog has a checkbox "Skip permission prompts" (default: checked)
- [ ] Checkbox state persists in localStorage across page reloads
- [ ] Batch dialog has an input "Startup command" (default: `/flow-auto`)
- [ ] Startup command persists in localStorage across page reloads
- [ ] The actual command sent uses the user-specified startup command
- [ ] Existing `/flow-auto` hardcoded behavior is replaced with the user's chosen command

## Architecture

### Components Affected

1. **Frontend (app.js)** - Add new UI controls to batch dialog, localStorage persistence
2. **Backend (server.ts)** - Accept new parameters from batch API, conditionally apply flags
3. **API Contract** - Extend `/api/batch-issues` request body

### Data Flow

```
[Batch Dialog]
    → User selects options (skipPermissions, startupCommand)
    → localStorage saves preferences
    → POST /api/batch-issues { ..., skipPermissions: boolean, startupCommand: string }
        → Server conditionally adds --dangerously-skip-permissions
        → Server uses custom startupCommand instead of hardcoded /flow-auto
```

### Key Changes

| File | Change |
|------|--------|
| `src/web/public/app.js` | Add checkbox + input to batch dialog, localStorage read/write |
| `src/web/server.ts` | Remove `--dangerously-skip-permissions` from line 275 (regular sessions) |
| `src/web/server.ts` | Accept `skipPermissions` param at line ~1152, conditionally add flag |
| `src/web/server.ts` | Accept `startupCommand` param, use instead of hardcoded `/flow-auto` (line ~1170) |

## File Layout (Key Changes)

```
src/web/
├── public/
│   └── app.js          # Batch dialog UI changes (lines ~1089-1110)
└── server.ts           # API handler changes (lines ~275, ~1114, ~1132)

dist/web/
└── public/
    └── app.js          # Must sync after editing src/
```

## Milestones

### Milestone 1: Remove skip-permissions from regular sessions

**Intent:** Ensure regular "New Session" creates sessions without the dangerous flag.

**Files touched:**
- `src/web/server.ts` (line ~275)

**Changes:**
- Remove `--dangerously-skip-permissions` from the regular session creation path
- Keep the Down+Enter acceptance logic removal since it won't be needed

**Verification:**
```bash
# Search for remaining skip-permissions in regular session path
grep -n "dangerously-skip-permissions" src/web/server.ts
# Should only show batch-issues handler (~line 1114)
```

### Milestone 2: Add UI controls to batch dialog

**Intent:** Add checkbox and input field to the batch issues dialog.

**Files touched:**
- `src/web/public/app.js` (lines ~1089-1110)
- `dist/web/public/app.js` (sync copy)

**Changes:**
- Add "Skip permission prompts" checkbox (default: checked)
- Add "Startup command" input (default: `/flow-auto`)
- Read defaults from localStorage on dialog open
- Save to localStorage on change

**localStorage keys:**
- `orcha.batchSkipPermissions` (boolean, default: true)
- `orcha.batchStartupCommand` (string, default: `/flow-auto`)

**Verification:**
```bash
# Manual testing:
# 1. Open batch dialog, see checkbox checked and /flow-auto in input
# 2. Uncheck checkbox, change command, close/reopen dialog
# 3. Should remember selections
```

### Milestone 3: Pass options through API

**Intent:** Send user preferences to server and apply them conditionally.

**Files touched:**
- `src/web/public/app.js` (fetch call ~line 1288)
- `src/web/server.ts` (batch-issues handler ~line 1050+)
- `dist/web/public/app.js` (sync copy)

**Changes:**
- Frontend: Include `skipPermissions` and `startupCommand` in POST body
- Backend: Extract params from request
- Backend: Conditionally add `--dangerously-skip-permissions` based on `skipPermissions`
- Backend: Replace hardcoded `/flow-auto` with `startupCommand` (line ~1132)

**Verification:**
```bash
# Build and test
npm run build

# Manual testing:
# 1. Create batch session with checkbox unchecked
# 2. Verify Claude starts WITHOUT permission prompt acceptance
# 3. Create batch session with custom command like "/blueprint"
# 4. Verify that command is sent instead of /flow-auto
```

### Milestone 4: Clean up permission acceptance logic

**Intent:** Only run the Down+Enter acceptance script when skip-permissions is enabled.

**Files touched:**
- `src/web/server.ts` (lines ~1117-1146)

**Changes:**
- Wrap the permission acceptance script in conditional based on `skipPermissions`
- If `skipPermissions` is false, skip the Down+Enter sequence entirely

**Verification:**
```bash
# Manual testing:
# With skip-permissions OFF: Claude should start normally, no auto-acceptance
# With skip-permissions ON: Should auto-accept and run startup command
```

## Risks & Unknowns

| Risk | Mitigation |
|------|------------|
| localStorage not available in some browsers | Use try/catch, fall back to defaults |
| Startup command injection | Sanitize/validate command on server side (must start with `/`) |
| Timing issues with permission acceptance | Existing logic already handles this with retries |
| Sync between src/ and dist/ forgotten | Add reminder comment, or automate in build |

## Quick Probes

1. **Confirm regular session doesn't need permission acceptance:** After removing the flag from line 275, verify sessions still work
2. **Test localStorage persistence:** Simple browser console test to verify read/write works
3. **Verify command gets through to tmux:** Add console.log to confirm custom command is used

---

**Next: /probe 'Milestone 1 - Remove skip-permissions from regular sessions'**
