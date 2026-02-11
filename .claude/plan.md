# Pipeline Activity Timeline: Overview/Detailed Toggle

**Milestones: 3**

## Goal

Add a toggle to the pipeline activity timeline that switches between "overview" (major milestones only) and "detailed" (all events) modes. Default to overview mode. When in overview mode, briefly highlight new major events as they arrive.

## Non-Goals

- Persisting toggle state across page reloads (always default to overview)
- Collapsing activity entries into counts (they're simply hidden)
- Complex filtering UI (just a simple toggle switch)
- Changing existing timeline rendering logic for individual entries

## Acceptance Criteria

- [ ] Toggle switch appears next to "Activity Timeline" section title
- [ ] Toggle switches between "Overview" and "Detailed" modes
- [ ] Overview mode is the default when opening a pipeline
- [ ] Overview mode shows: stage-complete, checkpoint, stage-error, gate-result, competing-result, info
- [ ] Overview mode hides: stage-activity entries (gray dots)
- [ ] Detailed mode shows all entries (current behavior)
- [ ] New major events in overview mode briefly pulse/highlight for 2 seconds
- [ ] Toggle state resets to overview when navigating between pipelines
- [ ] Timeline scrolling works correctly in both modes

## Architecture

### Components

**Frontend (Web Dashboard):**
- `src/web/public/app.js` - Add toggle UI and filtering logic
- `src/web/public/style.css` - Add toggle switch styles and highlight animation

**No backend changes needed** - filtering is purely client-side in the rendering layer.

### Data Flow

1. User opens pipeline detail → Timeline renders in **overview mode** (default)
2. `renderTimelineEntries()` filters entries based on current mode
3. WebSocket receives `pipeline:progress` event with new entry
4. If in overview mode AND entry is a major event → add with `highlight` class
5. CSS animation runs for 2 seconds, then auto-removes
6. User clicks toggle → re-render timeline with new filter

### Key Implementation Points

- **Toggle State**: Store in `state.timelineMode` (per pipeline ID: `state.timelineModes[pipelineId]`)
- **Filter Logic**: Add `shouldShowInOverview(entry)` helper function
- **Animation**: CSS class `timeline-entry-highlight` with 2s fade-out animation
- **Reset on Navigation**: Clear toggle state when `selectPipeline()` is called

## File Layout

```
src/web/public/
├── app.js          # Toggle UI, filter logic, highlight on new entries
└── style.css       # Toggle switch styles, highlight animation
```

## Milestones

### M1: Add toggle UI and state management

**Intent**: Add the toggle switch next to the "Activity Timeline" header and wire up the state management.

**Key Files**:
- `src/web/public/app.js:5283-5288` (Activity Timeline section)
- `src/web/public/app.js:9` (state object)
- `src/web/public/style.css` (new styles)

**Changes**:
1. Add `timelineModes: {}` to the `state` object (maps pipelineId → 'overview' | 'detailed')
2. Modify the Activity Timeline HTML in `renderPipelineDetail()` to include toggle switch
3. Add `toggleTimelineMode(pipelineId)` function that:
   - Flips the mode for the given pipeline
   - Re-renders the timeline by calling `fetchAndRenderTimeline(pipelineId)`
4. Add CSS for the toggle switch component (styled similar to existing UI elements)

**Verification**:
```bash
npm run build
cp src/web/public/app.js dist/web/public/
cp src/web/public/style.css dist/web/public/
# Open web dashboard, verify toggle appears and switches between modes
```

### M2: Implement filtering logic for overview mode

**Intent**: Make the timeline actually filter entries based on the toggle state.

**Key Files**:
- `src/web/public/app.js:5835-5845` (`renderTimelineEntries()`)
- `src/web/public/app.js:5850-5896` (`renderTimelineEntry()`)

**Changes**:
1. Add `shouldShowInOverview(entry)` helper function that returns true for:
   - `entry.type === 'stage-complete'`
   - `entry.type === 'checkpoint'`
   - `entry.type === 'info'`
   - `entry.type === 'stage-error'`
   - `entry.type === 'gate-result'`
   - `entry.type === 'competing-result'`
   - Returns false for `entry.type === 'stage-activity'` and others
2. Modify `renderTimelineEntries(entries)` to:
   - Get current mode from `state.timelineModes[currentPipelineId]` (default 'overview')
   - Filter entries using `shouldShowInOverview()` if in overview mode
   - Pass filtered entries to rendering loop
3. Ensure toggle state defaults to 'overview' when pipeline is first selected

**Verification**:
```bash
npm run build
cp src/web/public/app.js dist/web/public/
# Open pipeline, verify overview shows only major events
# Toggle to detailed, verify all entries appear including gray dots
```

### M3: Add highlight animation for new entries in overview mode

**Intent**: When new major events arrive via WebSocket in overview mode, briefly highlight them with a 2-second pulse animation.

**Key Files**:
- `src/web/public/app.js:4562-4590` (WebSocket `pipeline:progress` handler)
- `src/web/public/app.js:5850-5896` (`renderTimelineEntry()`)
- `src/web/public/style.css` (animation styles)

**Changes**:
1. Add CSS for `.timeline-entry-highlight` class with:
   - Subtle background glow/pulse effect
   - 2-second fade-out animation
   - Auto-removes after animation completes
2. Modify WebSocket `pipeline:progress` handler to:
   - Check if current mode is 'overview' for this pipeline
   - Check if the new entry should show in overview (`shouldShowInOverview(entry)`)
   - If both true, add `highlight` class to the rendered entry
3. Modify `renderTimelineEntry()` to accept optional `shouldHighlight` parameter
4. Use `requestAnimationFrame()` to remove highlight class after 2 seconds

**Verification**:
```bash
npm run build
cp src/web/public/app.js dist/web/public/
cp src/web/public/style.css dist/web/public/
# Start a pipeline run via UI
# Keep timeline in overview mode
# Verify new major events (stage-complete, checkpoint) briefly pulse/glow
# Verify animation stops after 2 seconds
```

## Risks & Unknowns

1. **Risk**: WebSocket message timing could cause highlight to trigger before DOM is ready
   - **Probe**: Test with fast-completing pipelines to see if highlights render
   - **Mitigation**: Use `requestAnimationFrame()` and check element existence before adding class

2. **Risk**: Filtering might break the "newest first" ordering or visual timeline line continuity
   - **Probe**: Test with mixed event types to ensure timeline lines still connect properly
   - **Mitigation**: Keep timeline-gutter line rendering independent of entry visibility

3. **Unknown**: Should the highlight apply if the timeline container is scrolled down (not viewing top)?
   - **Decision**: Let it highlight anyway - user will see it when they scroll up
   - **Alternative**: Could add scroll-to-top on new major event, but that's disruptive

## Test Strategy

**Manual Testing**:
1. Open a running pipeline in the web dashboard
2. Verify toggle defaults to "Overview" mode
3. Toggle to "Detailed" - should see all stage-activity entries appear
4. Toggle back to "Overview" - stage-activity entries should disappear
5. Keep in overview mode, trigger a new stage completion
6. Verify the new entry briefly glows/pulses for 2 seconds
7. Navigate to a different pipeline and back - verify toggle resets to overview

**Edge Cases**:
- Timeline with zero entries (empty state should still show toggle)
- Very long timelines (filtering should improve performance)
- Rapid new events (multiple highlights at once should work)
- Switching pipelines during an active highlight animation

---

**Next**: `/probe 'Add toggle UI and state management'`
