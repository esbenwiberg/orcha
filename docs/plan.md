# Blueprint: Scrollable Activity Timeline

## Goal

Contain the Activity Timeline in a scrollable div with a fixed max-height so that when the timeline grows long, the Live Output panel remains visible without having to scroll the entire page.

## Non-Goals

- Changing the timeline entry rendering logic or styling.
- Adding pagination or lazy-loading of timeline entries.
- Modifying the side panel or responsive layout.

## Acceptance Criteria

- [ ] Activity Timeline section has `max-height` and `overflow-y: auto`, capped so the Live Output below is always reachable without scrolling the whole page.
- [ ] New entries (prepended at top) remain visible — the scroll position stays at the top when new entries arrive.
- [ ] The Live Output section is always visible on screen when a pipeline is active, without needing to scroll past the timeline.
- [ ] No visual regressions — timeline entries, dots, lines, and gate cards render correctly inside the constrained container.
- [ ] Both `src/web/public/` and `dist/web/public/` files are synced.

## Architecture

Pure CSS change on `.activity-timeline` plus a minor JS tweak to ensure scroll position stays at top on live-append.

### Changes

**CSS** (`style.css`):
- Add `max-height: 50vh` and `overflow-y: auto` to `.activity-timeline`.
- Add subtle styling (border/border-radius) so the scrollable area is visually distinct.

**JS** (`app.js`):
- After prepending a new timeline entry via live-append, set `container.scrollTop = 0` to keep the newest entry visible.

## Key Files

| File | Change |
|------|--------|
| `src/web/public/style.css` | Add max-height + overflow to `.activity-timeline` |
| `src/web/public/app.js` | Add `scrollTop = 0` after prepend in live-append handler |

## Milestones

### M1: CSS — constrain activity timeline height

**Intent:** Make the `.activity-timeline` container scrollable with a sensible max-height.

**Files:** `src/web/public/style.css`

**Changes:**
- `.activity-timeline` — add `max-height: 50vh; overflow-y: auto;`
- Optional: add a subtle left-border or background to signal scrollability.

**Verify:** Open dashboard with a pipeline that has many timeline entries; confirm the timeline is scrollable and Live Output is visible below.

### M2: JS — keep scroll at top on live-append

**Intent:** When a new timeline entry is prepended, ensure the container scrolls to the top so the newest entry is always visible.

**Files:** `src/web/public/app.js`

**Changes:**
- After `container.insertBefore(newNode, container.firstChild)` in the `pipeline:progress` handler (~line 3903), add `container.scrollTop = 0;`

**Verify:** While a pipeline is running, observe that new activity entries appear at top without the scroll jumping away.

### M3: Sync dist and bump cache version

**Intent:** Copy changed files to `dist/web/public/` and bump the `?v=` query strings in `index.html`.

**Files:** `src/web/public/index.html`, `dist/web/public/*`

**Verify:** `diff src/web/public/style.css dist/web/public/style.css` shows no diff. Dashboard loads with new styles.

## Risks / Unknowns

| Risk | Mitigation |
|------|-----------|
| `50vh` may be too tall/short on some screen sizes | Can adjust; 50vh is a reasonable starting point; could also use `calc()` to account for header height |
| Timeline connecting lines might clip at scroll boundary | Test visually; the gutter lines are CSS pseudo-elements that should clip naturally |

---

Next: /probe 'M1: CSS — constrain activity timeline height'
