# Blueprint: Pipeline Dashboard Improvements

## Goal

Fix the dev stage "silent hang" problem, add real-time log streaming to the pipeline detail view, enrich the activity timeline with intra-stage events, and make the blueprint display readable instead of showing truncated raw JSON.

## Non-Goals

- Changing the pipeline state machine or transition logic
- Adding new pipeline stages
- Modifying the Claude CLI subprocess spawning mechanism
- Reworking the competing agents system
- Adding pipeline-level timeouts or watchdog processes (separate concern)

## Acceptance Criteria

- [ ] When a stage is running, the pipeline detail page shows a live-updating log panel with real-time output (tool calls, text, init/done events)
- [ ] The activity timeline shows intra-stage events: tool calls (Read, Edit, Write, Bash, Grep, Glob), agent thinking text, and init/done summary — not just "stage started" and "stage ended"
- [ ] The blueprint is rendered as formatted, human-readable HTML (approach, steps, files, risks, test strategy) instead of truncated raw JSON
- [ ] The full blueprint is displayed (currently truncated to 1000 chars in stageHistory)
- [ ] Dev stage failures are visible in the UI — errors surface in the timeline and the state transitions to `error` correctly
- [ ] If the Claude subprocess exits non-zero or produces no output, the error detail is shown in the timeline

## Architecture

### Data Flow (current)

```
Claude subprocess (stream-json stdout)
  → formatStreamEvent() parses lines → emitLog() → WebSocket → frontend buffers in state.pipelineLogs
  → appendProgress() writes stage-start/stage-complete → WebSocket → timeline entries
```

### Problems Found

1. **Blueprint truncated**: `architect.ts:172` does `JSON.stringify(blueprint).slice(0, 1000)` — the stageHistory only stores 1000 chars of raw JSON
2. **Blueprint shown as raw JSON**: `renderCollapsibleBlueprint()` wraps it in `<pre>` with `escapeHtml()` — no formatting
3. **Live log panel missing**: WebSocket handler looks for `#pipeline-live-log` element but it's never rendered in the pipeline detail HTML
4. **Timeline is sparse**: Only `stage-start` and `stage-complete` entries exist — no visibility into what's happening during a stage
5. **Dev stage errors**: Error paths do call `transitionToError()` which sets state, but the timeline `stage-error` entry only comes from `stage-runner.ts` after subprocess exit — if the error is in `dev.ts` (e.g., git commands), there may be no timeline entry

### Data Flow (proposed)

```
Claude subprocess (stream-json stdout)
  → formatStreamEvent() parses lines → emitLog() → WebSocket → frontend live log panel
  → NEW: emit fine-grained progress events for tool calls → WebSocket → timeline sub-entries
  → appendProgress() writes stage-start/stage-complete → WebSocket → timeline entries

Blueprint display:
  → Fetch full blueprint.json from /api/pipelines/:id/blueprint
  → Render as structured HTML cards (approach, steps, files, risks)
```

### Components Changed

| Component | File | Change |
|-----------|------|--------|
| Frontend - Pipeline Detail | `src/web/public/app.js` | Add live log panel, render `#pipeline-live-log`, render blueprint as HTML |
| Frontend - Styles | `src/web/public/style.css` | Styles for live log panel, blueprint cards, timeline sub-events |
| Stage Runner | `src/pipeline/stage-runner.ts` | Emit fine-grained progress entries for tool calls during stage execution |
| Architect Stage | `src/pipeline/stages/architect.ts` | Stop truncating blueprint in stageHistory output |
| Progress Types | `src/pipeline/progress.ts` | Add `stage-activity` progress type for intra-stage events |

## Milestones

### Milestone 1: Fix Blueprint Display

**Intent:** Make the blueprint human-readable instead of truncated JSON.

**Key files:**
- `src/pipeline/stages/architect.ts:172` — change stageHistory output from `JSON.stringify(blueprint).slice(0, 1000)` to a meaningful summary string (approach + step count)
- `src/web/public/app.js` — `renderCollapsibleBlueprint()` (~line 4582): instead of reading from `stageHistory[].output`, fetch full `blueprint.json` from `/api/pipelines/:id/blueprint` and render structured HTML sections: approach, numbered steps with details, file list, risks, test strategy
- `src/web/public/style.css` — blueprint card styles (sections, step numbers, file chips, risk items)

**Verification:**
- Start a pipeline, let architect complete
- Open pipeline detail → expand Blueprint section
- Confirm it shows formatted approach, steps, files, risks — not raw JSON
- Confirm full content is shown (not truncated)

### Milestone 2: Add Live Log Panel to Pipeline Detail

**Intent:** Show real-time Claude subprocess output while a stage runs so it doesn't look like a silent hang.

**Key files:**
- `src/web/public/app.js` — in `renderPipelineDetail()` (~line 4440), add a "Live Output" section below the activity timeline with `<pre id="pipeline-live-log" data-pipeline-id="...">`. Show only when pipeline is in an active stage (dev, gate, fix-loop, architect, ship). The existing WebSocket handler at line 3835 already writes to `#pipeline-live-log` — it just needs the element to exist.
- `src/web/public/style.css` — log panel styling (dark bg, monospace, auto-scroll, max-height with overflow)

**Verification:**
- Start a pipeline, approve the architect checkpoint
- Watch dev stage run — log panel should show tool calls and text in real time
- After stage completes, log panel should show final summary

### Milestone 3: Enrich Activity Timeline with Stage Activity

**Intent:** Add intra-stage events to the timeline so users see what's happening inside each stage.

**Key files:**
- `src/pipeline/progress.ts` — add `'stage-activity'` to the `ProgressType` union
- `src/pipeline/stage-runner.ts` — in the `onData` callback (~line 123), after `formatStreamEvent()` returns a message, also emit `appendProgress()` with type `stage-activity` for: init events, tool_use events, and result events. Rate-limit to avoid flooding (e.g., max 1 event per 5 seconds, or batch consecutive tool calls).
- `src/web/public/app.js` — `renderTimelineEntry()` (~line 4678): handle `stage-activity` type with compact sub-entry styling (smaller dot, indented, lighter text)
- `src/web/public/style.css` — sub-entry styles

**Verification:**
- Run a pipeline through dev and gate stages
- Timeline should show entries like:
  - "Stage dev started"
  - "[tool] Read src/web/server.ts" (stage-activity, compact)
  - "[tool] Edit src/web/server.ts" (stage-activity, compact)
  - "[tool] Bash: npm test" (stage-activity, compact)
  - "Stage dev completed (42 turns, $0.85, 3m 12s)"

### Milestone 4: Surface Dev Stage Errors Properly

**Intent:** Make sure dev stage failures are clearly visible — not silent.

**Key files:**
- `src/pipeline/stages/dev.ts` — in the catch blocks (~lines 170-177), add `appendProgress()` call with `stage-error` type and the error message before calling `transitionToError()`
- `src/web/public/app.js` — ensure `renderTimelineEntry()` renders `stage-error` entries prominently (red dot, error message visible, expanded by default)

**Verification:**
- Intentionally trigger a dev stage error (e.g., make blueprint.json unreadable)
- Confirm error appears in timeline with red indicator and error message
- Confirm pipeline state shows `error` in the stage progress bar
- Confirm the "Error" detail appears in the side panel

## Risks / Unknowns

| Risk | Mitigation |
|------|-----------|
| **Progress event volume** — Tool calls during dev could generate 50+ events, cluttering the timeline | Rate-limit `stage-activity` emissions (max 1 per 5s, or group consecutive tool calls into a single "N tool calls" entry). Keep them visually compact. |
| **Blueprint fetch timing** — Switching from stageHistory to API fetch means an extra network call | Show loading skeleton briefly. The `/api/pipelines/:id/blueprint` endpoint already exists. Low risk. |
| **Live log memory** — Long stages accumulate text in `state.pipelineLogs[id]` | Cap buffer at ~100KB; trim from the front when exceeded. |
| **Existing `showPipelineLogs` dialog** — Already a logs dialog that fetches historical logs | Keep it as "full historical log" view. The new inline live panel serves a different purpose (real-time). |
| **Static file sync** — CLAUDE.md requires copying `src/web/public/*` to `dist/web/public/*` | Each milestone's verification includes the copy step. |

---

Next: /probe 'Milestone 1 — fix blueprint display'
