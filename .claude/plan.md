# Blueprint: Pipeline Cost Display & CLI Feature Parity in Web Dashboard

## Goal

Surface pipeline cost/usage data prominently in the web dashboard (currently buried in side panel only visible on pipeline detail), and close the most impactful CLI-vs-web feature gaps — specifically presets, cleanup, and pipeline resume.

## Non-Goals

- Real-time streaming cost updates via WebSocket (cost only updates between stages)
- Per-model token cost breakdowns
- MCP server management from web (niche CLI-only use case)
- Demo mode in web
- Direct tmux attach from web (web has integrated terminals)

## Acceptance Criteria

- [ ] Pipeline list sidebar items show estimated cost badge when `usageSnapshot.totalCostUsd > 0`
- [ ] Pipeline detail header area shows cost prominently (not just in side panel)
- [ ] Per-stage cost breakdown visible in pipeline detail (from `usage.json` data)
- [ ] New `/api/pipelines/:id/usage` endpoint returns detailed `usage.json` data
- [ ] Preset management UI: list, load, delete presets from web dashboard
- [ ] New preset API endpoints: `GET /api/presets`, `POST /api/presets/:name/load`, `DELETE /api/presets/:name`
- [ ] Cleanup utility accessible from web: button to run cleanup with dry-run preview
- [ ] New cleanup API endpoints: `POST /api/cleanup` with `dryRun` option
- [ ] Pipeline resume button in web UI for paused/errored pipelines
- [ ] New `POST /api/pipelines/:id/resume` endpoint
- [ ] Both `src/web/public/` and `dist/web/public/` files are synced after changes

## Architecture

### Data Flow — Pipeline Cost

```
usage.json (per pipeline)
  → GET /api/pipelines/:id/usage (new endpoint)
  → Frontend fetches on pipeline detail load
  → Renders per-stage breakdown table + cost in header

usageSnapshot (already in pipeline list response)
  → Frontend reads totalCostUsd from each pipeline
  → Shows cost badge in sidebar list items
```

### Data Flow — Presets

```
~/.orcha/presets/*.json (existing CLI preset files)
  → GET /api/presets (reads preset dir, returns list)
  → POST /api/presets/:name/load (starts sessions from preset config)
  → DELETE /api/presets/:name (removes preset file)
  → Frontend shows preset list in session creation dialog
```

### Data Flow — Cleanup

```
POST /api/cleanup { dryRun: true }
  → Calls existing cleanupDeadSessions() + worktrees.cleanup()
  → Returns preview of what would be cleaned
POST /api/cleanup { dryRun: false }
  → Actually performs cleanup
  → Returns results
```

## Key Files

| File | Change |
|------|--------|
| `src/web/server.ts` | Add `/api/pipelines/:id/usage`, `/api/presets/*`, `/api/cleanup`, `/api/pipelines/:id/resume` endpoints |
| `src/web/public/app.js` | Cost badge in sidebar, cost in detail header, per-stage breakdown, preset UI, cleanup UI, resume button |
| `src/web/public/style.css` | Styles for cost badge, per-stage table, preset list, cleanup dialog |

## Milestones

### M1: Pipeline cost in sidebar list + detail header

**Intent:** Make pipeline cost visible at a glance — in the sidebar list items and prominently in the detail view header area — not just buried in the side panel.

**Key files:** `src/web/public/app.js`, `src/web/public/style.css`

**Changes:**
- In `updatePipelineSidebar()`: add cost badge to each pipeline-item when `usageSnapshot.totalCostUsd > 0`
- In `renderPipelineDetail()`: add cost display near the stage progress bar (top of detail view)
- CSS for `.pipeline-cost-badge` and `.pipeline-header-cost`

**Verification:**
- `cp src/web/public/app.js dist/web/public/ && cp src/web/public/style.css dist/web/public/`
- Visual check: pipeline sidebar shows "$X.XX" next to pipeline name
- Visual check: pipeline detail header shows cost prominently

### M2: Per-stage cost breakdown

**Intent:** Add a `/api/pipelines/:id/usage` endpoint and render a per-stage cost/token table in the pipeline detail side panel.

**Key files:** `src/web/server.ts`, `src/web/public/app.js`, `src/web/public/style.css`

**Changes:**
- Server: new `GET /api/pipelines/:id/usage` reads `~/.orcha/pipelines/{id}/usage.json`
- Frontend: fetch usage data on pipeline detail load, render per-stage table (stage, cost, input tokens, output tokens, duration)
- Replace current simple "Usage" section in side panel with richer breakdown

**Verification:**
- `curl http://localhost:3847/api/pipelines/<id>/usage` returns per-stage data
- Visual check: side panel shows per-stage cost table
- `npm run build` passes

### M3: Preset management UI

**Intent:** Surface CLI preset save/load/delete in the web dashboard so users can manage session templates without the CLI.

**Key files:** `src/web/server.ts`, `src/web/public/app.js`, `src/web/public/style.css`

**Changes:**
- Server: `GET /api/presets` (list), `POST /api/presets/:name/load` (start sessions from preset), `DELETE /api/presets/:name` (remove)
- Frontend: preset list in session creation area or as a dropdown/section, with load and delete actions
- Reuse existing preset loading logic from `src/core/presets.ts` (or wherever presets are implemented)

**Verification:**
- `curl http://localhost:3847/api/presets` returns saved presets
- Visual check: can see presets in web UI, load one to start sessions, delete one
- `npm run build` passes

### M4: Cleanup utility in web

**Intent:** Let users run cleanup (orphaned worktrees, dead sessions) from the web dashboard with a dry-run preview.

**Key files:** `src/web/server.ts`, `src/web/public/app.js`, `src/web/public/style.css`

**Changes:**
- Server: `POST /api/cleanup` with `{ dryRun: boolean }` body, calls existing `cleanupDeadSessions()` and `worktrees.cleanup()`
- Frontend: cleanup button (in settings or header area), shows modal with dry-run preview, confirm button to execute
- Reuse existing cleanup logic from `src/core/cleanup.ts`

**Verification:**
- `curl -X POST http://localhost:3847/api/cleanup -H 'Content-Type: application/json' -d '{"dryRun":true}'` returns preview
- Visual check: cleanup dialog shows what would be removed, confirm executes it
- `npm run build` passes

### M5: Pipeline resume button

**Intent:** Add a resume button for paused/errored pipelines in the web UI, matching `orcha pipeline resume` CLI behavior.

**Key files:** `src/web/server.ts`, `src/web/public/app.js`

**Changes:**
- Server: `POST /api/pipelines/:id/resume` with optional `{ continue: true }` — reuses pipeline engine resume logic
- Frontend: "Resume" button visible when pipeline is in error/paused/checkpoint state (next to existing approve/reject buttons)

**Verification:**
- Pause a pipeline, click resume in web UI, pipeline continues
- `npm run build` passes

## Risks & Unknowns

| Risk | Probe |
|------|-------|
| Preset file format/location may differ from what CLI writes | `grep -r 'presets' src/core/` to find preset storage logic |
| `usage.json` may not exist for older pipelines | Handle gracefully — return empty/null if file missing |
| Cleanup functions may expect CLI-specific context | Check `cleanupDeadSessions()` signature for required params |
| Cost data may be $0.00 for pipelines that didn't track usage | Show "N/A" or hide cost badge when cost is 0 |
