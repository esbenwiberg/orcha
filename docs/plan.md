# Blueprint: Pipeline View — Visible UI with Start Form

## Goal

Add a permanent "Pipelines" tab/view to the web dashboard so users can see pipeline runs at a glance and start new ones from a dialog — without needing CLI access.

## Non-Goals

- Editing pipeline config (models, budgets) from the UI — use defaults for now
- Real-time stage streaming via WebSocket (existing polling is fine for v1)
- Competing agent configuration from the UI (CLI-only for now)

## Acceptance Criteria

- [ ] Sidebar shows a "Pipelines" section header that is always visible (even when no pipelines exist), with a "+" button to start a new pipeline
- [ ] Clicking "+" opens a "New Pipeline" dialog with fields: description (required), acceptance criteria (textarea, one per line), source branch (default: main), worktree path (optional, default: cwd on server)
- [ ] Submitting the dialog calls `POST /api/pipelines` and the new pipeline appears in the sidebar
- [ ] `POST /api/pipelines` backend endpoint creates a pipeline run and kicks off the architect stage asynchronously
- [ ] Pipeline list in the sidebar always renders (shows "No pipelines yet" placeholder when empty)
- [ ] Existing pipeline detail view, approve/reject/feedback controls continue to work
- [ ] `npm run build` succeeds with no type errors

## Architecture

```
Browser (app.js)                    Server (server.ts)              Pipeline Engine
     │                                    │                              │
     │ click "+" → showNewPipelineDialog  │                              │
     │ fill form → POST /api/pipelines    │                              │
     │ ─────────────────────────────────► │                              │
     │                                    │  createPipelineRun(opts)     │
     │                                    │ ────────────────────────────►│
     │                                    │  executeArchitectStage(run)  │
     │                                    │ ────────────────────────────►│ (async, non-blocking)
     │                                    │◄─── 202 { id, state }       │
     │ ◄───────────────────────────────── │                              │
     │ refresh loop picks up new pipeline │                              │
     │ sidebar shows pipeline item        │                              │
```

## Key Files

| File | Change |
|------|--------|
| `src/web/server.ts` | Add `POST /api/pipelines` endpoint |
| `src/web/public/app.js` | Add always-visible pipeline header + "New Pipeline" dialog |
| `src/web/public/style.css` | Minor: pipeline header always-visible styles |

3 files total. Small, well-scoped.

## Milestones

### Milestone 1: Backend — `POST /api/pipelines` endpoint

**Intent:** Add the API endpoint so the frontend has something to call.

**Key changes in `src/web/server.ts`:**
- Add `POST /api/pipelines` route after existing pipeline GET routes (~line 2013)
- Accept JSON body: `{ description, acceptanceCriteria?, sourceBranch?, worktreePath? }`
- Import `createPipelineRun`, `executeArchitectStage`, `defaultPipelineConfig` from pipeline module
- Create the run, respond with 202 + run data, then kick off architect stage async (same pattern as feedback endpoint at line 2088)
- Default `worktreePath` to the server's cwd, default `sourceBranch` to "main"

**Verification:**
```bash
npm run build
curl -X POST http://localhost:3000/api/pipelines \
  -H 'Content-Type: application/json' \
  -d '{"description":"test pipeline"}'
```

### Milestone 2: Frontend — Always-visible pipeline sidebar + start dialog

**Intent:** Make pipelines discoverable with a permanent sidebar section and a dialog to create new ones.

**Key changes in `src/web/public/app.js`:**
- Modify `updatePipelineSidebar()` (~line 4125) to always render a header with a "+" button, even when pipelines list is empty
- Add `showNewPipelineDialog()` function following the existing `showNewSessionDialog()` pattern (~line 1700):
  - Fields: description (input, required), acceptance criteria (textarea), source branch (input, default "main")
  - Submit button calls `POST /api/pipelines`, shows toast on success/error
  - Auto-refreshes pipeline list on success

**Key changes in `src/web/public/style.css`:**
- Ensure `.pipelines-header` is always visible with the "+" button styled like existing action buttons

**Key changes in `src/web/public/index.html`:**
- Bump cache buster on app.js and style.css

**Verification:**
- Open dashboard, see "Pipelines" section in sidebar even with no pipelines
- Click "+", fill description, submit → pipeline appears in sidebar
- Click pipeline → detail view shows stage progress

## Risks / Unknowns

| Risk | Mitigation |
|------|-----------|
| `worktreePath` — what should the default be when starting from web? | Use server's cwd (the orcha project root). The pipeline creates its own worktree within that. |
| Architect stage is long-running — will the 202 pattern work? | Yes, same pattern already used by the feedback endpoint (line 2088). Polling refresh picks up state changes. |
| Pipeline module import is dynamic (`await import(...)`) | Follow existing pattern in server.ts — all pipeline imports are already dynamic. |

## Next

Next: `/probe 'Milestone 1'`
