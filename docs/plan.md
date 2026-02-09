# Blueprint: Ship-Review Dashboard Integration

## Goal

When a pipeline reaches `checkpoint:ship`, show the **code diff**, **gate results detail**, and a **ship-review summary** directly in the dashboard — so the user can make an informed approve/reject decision without catting files from disk.

## Non-Goals

- Syntax highlighting / language-aware diff rendering (plain +/- coloring is sufficient)
- Editing code from the dashboard
- Auto-approve logic
- Changes to the ship stage itself (PR creation, push)
- Changes to gate check logic or verdicts

## Acceptance Criteria

- [ ] At `checkpoint:ship`, the dashboard shows a "Ship Review" panel with:
  - A collapsible **code diff** section showing all changes (unified diff format with +/- coloring)
  - A **gate results** section showing all 6 checks with verdict, summary, and expandable details
  - A **ship-review summary** card: blueprint approach, fix-loop count, cost, AC status
- [ ] Diff is fetched via a new API endpoint (`GET /api/pipelines/:id/diff`)
- [ ] Gate results detail uses the existing `/api/pipelines/:id/gate-results` endpoint
- [ ] The review panel only appears at `checkpoint:ship` state (not at other stages)
- [ ] Approve/Reject buttons remain visible and accessible within the review panel
- [ ] Large diffs are truncated with a "Show all" toggle (limit ~500 lines initially)
- [ ] Works for both fresh gate passes and escalated-then-passed pipelines

## Architecture

### Data Flow

```
checkpoint:ship reached
  → Frontend detects state === 'checkpoint:ship'
  → Fetches: GET /api/pipelines/:id/diff       (NEW)
  → Fetches: GET /api/pipelines/:id/gate-results (EXISTS)
  → Fetches: GET /api/pipelines/:id/blueprint    (EXISTS)
  → Renders ship-review panel with all data + pipeline object in memory
```

### New Backend Endpoint

**`GET /api/pipelines/:id/diff`**
- Loads pipeline run → gets `worktreePath` and `sourceBranch`
- Finds merge-base: `git merge-base origin/<sourceBranch> HEAD`
- Runs `git diff <mergeBase>...HEAD` for full unified diff
- Runs `git diff --stat <mergeBase>...HEAD` for summary stats
- Returns `{ diff: string, stat: string, filesChanged: number, insertions: number, deletions: number }`

### Frontend: Ship-Review Panel

When `state === 'checkpoint:ship'`, `renderCheckpointControls()` renders the full ship-review panel instead of just the basic approve/reject buttons. The panel contains:

1. **Summary Card** — Blueprint approach, fix-loop count, total cost, AC count, diff stat summary
2. **Gate Results Grid** — Enhanced version of existing `renderGateFailureDetails` showing ALL results (pass + fail + skip) with expandable detail text per check
3. **Code Diff Viewer** — `<pre>` with per-line CSS classes: `.diff-add` (green), `.diff-remove` (red), `.diff-hunk` (blue/@@), `.diff-context` (default)
4. **Sticky Action Bar** — Approve / Reject buttons fixed at bottom of the review panel

## File Layout

```
src/web/server.ts          — Add GET /api/pipelines/:id/diff endpoint (~30 lines)
src/web/public/app.js      — Add renderShipReviewPanel(), renderDiffViewer(), enhance renderCheckpointControls()
src/web/public/style.css   — Add .ship-review-*, .diff-viewer-*, .gate-detail-expanded styles
```

## Milestones

### Milestone 1: Backend Diff Endpoint

**Intent:** Serve the code diff from the pipeline's worktree via API.

**Files:**
- `src/web/server.ts` — Add `GET /api/pipelines/:id/diff` route near the existing gate-results endpoint (~line 2353)

**Approach:**
- Load pipeline run via `loadPipelineRun(id)`
- Validate it exists and has a worktree path
- Run `git merge-base origin/${run.sourceBranch} HEAD` in worktree to find divergence point
- Run `git diff <mergeBase>...HEAD` for full diff text
- Run `git diff --stat <mergeBase>...HEAD` for stat summary
- Parse stat summary last line for files/insertions/deletions
- Return JSON: `{ diff, stat, filesChanged, insertions, deletions }`
- Fallback: if merge-base fails, try `git diff HEAD~1` (single commit diff)

**Verify:**
```bash
curl http://localhost:3000/api/pipelines/<ID>/diff | jq '.stat'
curl http://localhost:3000/api/pipelines/<ID>/diff | jq '.filesChanged'
```

### Milestone 2: Ship-Review Panel (Frontend)

**Intent:** Render the ship-review panel at `checkpoint:ship` with summary card, gate results, diff viewer, and action buttons.

**Files:**
- `src/web/public/app.js` — New functions + modify `renderCheckpointControls()`
- `src/web/public/style.css` — Ship review styles

**Approach:**

In `renderCheckpointControls()` (line 4580): when `state === 'checkpoint:ship'`, instead of the current simple approve/reject buttons, return a placeholder `<div id="ship-review-panel">Loading review...</div>` and trigger an async `loadShipReview(pipelineId)`.

`loadShipReview(pipelineId)` fetches all three endpoints in parallel:
- `/api/pipelines/:id/diff`
- `/api/pipelines/:id/gate-results`
- `/api/pipelines/:id/blueprint`

Then calls `renderShipReviewPanel(pipeline, diff, gateResults, blueprint)` which builds:

1. **Summary card**: Approach (from blueprint), files changed / insertions / deletions (from diff stat), fix-loop count, total cost, AC count — displayed as a compact info grid
2. **Gate results grid**: Loop over all gate results (not just failures). Each check is a card with icon + name + verdict. Clicking a card toggles showing the full `summary` text. Color-coded by verdict.
3. **Diff viewer**: `renderDiffViewer(diffText)` — split on `\n`, for each line apply CSS class based on first char (`+` → add, `-` → remove, `@@` → hunk, else context). Wrap in scrollable `<pre>`. If > 500 lines, show first 500 + "Show all N lines" button.
4. **Action bar**: Approve and Reject buttons, same `onclick` handlers as current.

**Verify:**
- Navigate to pipeline at `checkpoint:ship` in dashboard
- Confirm summary card shows blueprint approach, diff stats, cost
- Confirm all 6 gate checks shown with verdicts
- Confirm diff is visible with colored +/- lines
- Confirm approve/reject buttons work
- Test with a large diff to verify truncation

### Milestone 3: Copy to Dist + End-to-End Test

**Intent:** Sync static files to dist and verify the full flow.

**Files:**
- Copy `src/web/public/app.js` → `dist/web/public/app.js`
- Copy `src/web/public/style.css` → `dist/web/public/style.css`

**Verify:**
```bash
cp src/web/public/app.js dist/web/public/app.js
cp src/web/public/style.css dist/web/public/style.css
# Restart server, open dashboard
# Navigate to a pipeline at checkpoint:ship
# Verify: summary card, gate results, diff viewer, approve/reject all work
```

## Risks / Unknowns

| Risk | Mitigation |
|------|-----------|
| Large diffs may be slow to render in DOM | Truncate at 500 lines with "Show all" toggle; stat summary always visible above diff |
| Worktree may not have `origin/<sourceBranch>` ref | Fallback chain: `git merge-base origin/<branch> HEAD` → `git merge-base <branch> HEAD` → `git diff HEAD~1` |
| Gate results may lack `details` field | Show summary only when details missing; graceful degradation |
| Gate results `summary` can be very long (AI-generated) | Truncate at 500 chars in collapsed state, show full on expand |
| Blueprint may not have `approach` field | Show first available: `approach` → `content` → "No blueprint summary" |

---

Next: /probe 'Milestone 1 — backend diff endpoint'
