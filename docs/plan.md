# Blueprint: Ship Review Feedback & Post-Ship Review Points

## Goal

Add two capabilities to the pipeline:
1. **Ship checkpoint feedback** — instead of binary approve/reject at `checkpoint:ship`, allow the reviewer to send feedback that cycles the pipeline back through `dev → gate → fix-loop → checkpoint:ship` with the reviewer's notes.
2. **Post-ship review points** — after a PR is created (`completed` state), allow the reviewer to paste PR review comments back into the pipeline, which re-enters `dev → gate → checkpoint:ship` to address them.

## Non-Goals

- **No GitHub/Azure DevOps API integration yet** — review points are manually copy/pasted (future milestone: a "Fetch from PR" button).
- **No new AI summarization** of review points — the reviewer's text is passed verbatim as context to the dev agent.
- **No changes to the architect checkpoint** — that flow already has approve/reject/feedback.
- **No PR update logic** — after addressing review points, the pipeline pushes to the same branch (the existing PR updates automatically via force-push or new commits).

## Acceptance Criteria

- [ ] Ship review panel shows a "Request Changes" button alongside Approve & Reject
- [ ] Clicking "Request Changes" reveals a textarea for feedback
- [ ] Submitting feedback transitions `checkpoint:ship → dev` and re-runs `dev → gate → checkpoint:ship`
- [ ] The feedback text is injected into the dev agent's prompt as reviewer context
- [ ] Completed pipelines show a "Address Review Points" section with a textarea
- [ ] Pasting review comments and submitting transitions `completed → dev` and re-runs the dev→gate→ship cycle
- [ ] Pipeline progress log shows entries for "Ship feedback" and "Review points received"
- [ ] State machine allows `checkpoint:ship → dev` and `completed → dev` transitions
- [ ] `fixLoopCount` resets to 0 when re-entering dev from either path

## Architecture

### State Machine Changes

```
Current:
  checkpoint:ship → ship | cancelled
  completed       → (terminal, no transitions)

New:
  checkpoint:ship → ship | cancelled | dev         (feedback sends back to dev)
  completed       → dev                             (review points re-open pipeline)
```

`completed` moves from `TERMINAL_STATES` to `SOFT_TERMINAL_STATES` (like `escalated`) — the pipeline is done but can be reopened.

### Data Flow

#### Ship Feedback (checkpoint:ship → dev)
```
UI: "Request Changes" button → reveals textarea
  → POST /api/pipelines/:id/ship-feedback { feedback: string }
  → feedbackShipCheckpoint(run, feedback)
    → appendProgress("Ship review feedback — re-running dev")
    → reset fixLoopCount to 0
    → transition: checkpoint:ship → dev
    → server's continueRun loop: dev → gate → fix-loop → checkpoint:ship
```

#### Post-Ship Review Points (completed → dev)
```
UI: "Address Review Points" textarea on completed pipeline detail
  → POST /api/pipelines/:id/review-points { reviewPoints: string }
  → submitReviewPoints(run, reviewPoints)
    → appendProgress("PR review points received — re-running dev")
    → reset fixLoopCount to 0
    → transition: completed → dev
    → server's continueRun loop: dev → gate → checkpoint:ship
```

### Components Modified

| Layer | File | Change |
|-------|------|--------|
| Types | `src/pipeline/types.ts` | Move `completed` to SOFT_TERMINAL_STATES; add `reviewRounds?: number` to PipelineRun |
| Engine | `src/pipeline/pipeline-engine.ts` | Add `dev` to checkpoint:ship transition set; add `completed → dev` entry; update recovery map |
| Checkpoint | `src/pipeline/checkpoint.ts` | Add `feedbackShipCheckpoint()` and `submitReviewPoints()` |
| Server | `src/web/server.ts` | Add `/ship-feedback` and `/review-points` API endpoints with continueRun |
| Frontend | `src/web/public/app.js` | "Request Changes" in ship review; "Address Review Points" for completed pipelines |
| Styles | `src/web/public/style.css` | Style new buttons and review points section |

## Milestones

### Milestone 1: State Machine & Backend Logic

**Intent:** Enable the two new transitions and add checkpoint handler functions.

**Files:**
- `src/pipeline/types.ts` — Move `completed` from TERMINAL_STATES to SOFT_TERMINAL_STATES
- `src/pipeline/pipeline-engine.ts` — Add `dev` to checkpoint:ship's transition set (line 58); add new entry `['completed', new Set(['dev'])]` (after line 59); update recovery map entry for dev
- `src/pipeline/checkpoint.ts` — Add `feedbackShipCheckpoint(run, feedback)` (mirrors `feedbackArchitectCheckpoint` pattern: append progress, reset fixLoopCount, transition to dev, augment description with feedback); Add `submitReviewPoints(run, reviewPoints)` (transition completed → dev with review context)

**Verification:**
```bash
npx tsc --noEmit
```

### Milestone 2: API Endpoints

**Intent:** Wire backend functions to HTTP endpoints the dashboard can call.

**Files:**
- `src/web/server.ts` — Add `POST /api/pipelines/:id/ship-feedback` (accepts `{ feedback: string }`, calls `feedbackShipCheckpoint`, responds 202, kicks off `continueRun`); Add `POST /api/pipelines/:id/review-points` (accepts `{ reviewPoints: string }`, calls `submitReviewPoints`, responds 202, kicks off `continueRun`)

**Verification:**
```bash
npx tsc --noEmit
```

### Milestone 3: Ship Review "Request Changes" UI

**Intent:** Add the feedback button and textarea to the ship review panel.

**Files:**
- `src/web/public/app.js` — Add "Request Changes" button to `renderShipReviewPanel()` (both top and bottom action bars); add `pipelineShipFeedback(pipelineId)` handler (mirrors `pipelineFeedback` pattern: toggle textarea, POST to `/ship-feedback`)
- `src/web/public/style.css` — Reuse existing `.checkpoint-btn.feedback` style

**Verification:**
```bash
cp src/web/public/app.js dist/web/public/ && cp src/web/public/style.css dist/web/public/
# Manual: start server, navigate to checkpoint:ship pipeline, verify button + textarea
```

### Milestone 4: Post-Ship Review Points UI

**Intent:** Show a review points section on completed pipelines.

**Files:**
- `src/web/public/app.js` — In `renderPipelineDetail()` (or wherever completed pipelines render), add a "Address Review Points" section with textarea + submit button; add `pipelineReviewPoints(pipelineId)` handler
- `src/web/public/style.css` — Style the review points card

**Verification:**
```bash
cp src/web/public/app.js dist/web/public/ && cp src/web/public/style.css dist/web/public/
# Manual: find completed pipeline, verify review points section appears
```

## Risks & Unknowns

| Risk | Impact | Quick Probe |
|------|--------|-------------|
| Moving `completed` out of TERMINAL_STATES may break rendering logic | Medium | `grep -rn 'TERMINAL_STATES\|terminalState' src/` to find all consumers |
| Sidebar pipeline status badges may not handle completed-but-reopened | Low | Check how sidebar renders state — likely just reads `pipeline.state` |
| Multiple review rounds could bloat `description` | Low | Inject feedback as one-shot augmentation (like architect feedback does), don't persist it into description |
| Recovery map may need updating for completed → dev path | Medium | The `getRecoveryTarget()` uses stageHistory — verify it handles completed pipelines |
| Tests may assert completed is terminal | Medium | `grep -rn 'TERMINAL.*completed\|completed.*terminal' test/` |

---

Next: /probe 'Milestone 1 — state machine and backend logic'
