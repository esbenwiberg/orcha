# Blueprint: Mobile UI Redesign

## Goal

Maximize vertical space for terminal content by consolidating UI into the top area: integrate session selector into the tab bar, eliminate both the session info bar and bottom navigation, and ensure key toolbar is always accessible while typing. Total space saved: ~90-110px.

## Non-Goals

- Changing the desktop/web dashboard UI
- Modifying the terminal rendering or WebSocket connection logic
- Altering the pipeline functionality
- Changing the underlying data structures or API

## Acceptance Criteria

- [ ] Tabs are positioned at the top of the screen, below the header
- [ ] Session selector is integrated into the tab bar (shows session name + dropdown)
- [ ] Session selector shows state dot + session name + dropdown arrow
- [ ] Tapping session selector opens bottom sheet with all sessions
- [ ] Session info bar is completely removed (functionality moved to tab bar)
- [ ] Tab indicator (border/background) clearly shows the active tab/selector
- [ ] Create (+) button is in the tab bar on the right side
- [ ] Bottom navigation is completely removed (no more bottom bar)
- [ ] Session navigation no longer uses swipe gestures
- [ ] Key toolbar (Esc, Tab, Ctrl, arrows) is directly below tab bar
- [ ] Key toolbar remains visible while typing in terminal
- [ ] Key toolbar is sticky/fixed so it doesn't scroll away
- [ ] All existing functionality (session switching, terminal interaction, create button) continues to work
- [ ] UI remains responsive and mobile-friendly
- [ ] Safe area insets for notched phones are preserved
- [ ] Vertical space is maximized for terminal content (~90-110px saved total)

## Architecture

### High-Level Changes

**Before:**
```
┌─────────────────────────┐
│ Header (logo, buttons)  │
├─────────────────────────┤
│ Session Info Bar        │
├─────────────────────────┤
│ Key Toolbar             │
├─────────────────────────┤
│                         │
│   Terminal Content      │
│                         │
├─────────────────────────┤
│ Bottom Nav:             │
│ [Sessions] [Pipelines]  │
│ • • • •   [+]          │
└─────────────────────────┘
```

**After:**
```
┌─────────────────────────┐
│ Header (logo, buttons)  │
├─────────────────────────┤
│ [Session-1▼][Pipelines][+]│ ← Session picker in tab
├─────────────────────────┤
│ Esc Tab Ctrl ← ↓ ↑ →   │ ← Sticky key toolbar
├─────────────────────────┤
│                         │
│   Terminal Content      │
│   (MAXIMUM space!)      │
│                         │
│                         │
│                         │
└─────────────────────────┘
    ↑ No bottom nav OR session info bar!
```

### Component Breakdown

1. **Top Tabs Bar** (relocated + enhanced)
   - Horizontal tab bar below header
   - Session selector integrated as first "tab" (when on Sessions view)
   - Shows current session name with state dot + dropdown arrow
   - Pipelines tab (when on Pipelines view)
   - Create (+) button on the right side
   - Active tab indicated with accent color bottom border
   - Full-width, fixed position

2. **Session Selector Dropdown** (replaces swipe + dots + session info bar)
   - Integrated into tab bar as the first button
   - Shows: state dot + session name + "▼"
   - Tap to open bottom sheet with session list
   - Each list item shows: state dot, session name, branch, state badge
   - Tap session to switch
   - Only visible when on Sessions tab (Pipelines tab shows "Pipelines" instead)
   - Replaces entire session info bar - saves ~40-50px!

3. **Sticky Key Toolbar** (enhanced)
   - Fixed position directly below tab bar
   - Always visible, even when mobile keyboard is open
   - Stays accessible while typing in terminal
   - Same keys: Esc, Tab, Ctrl, arrow keys
   - Only visible on Sessions tab

4. **Session Info Bar Removed** (NEW)
   - Completely eliminated
   - Functionality moved into tab bar session selector
   - Saves ~40-50px of vertical space

5. **Bottom Nav Removed**
   - Completely eliminated
   - Saves ~50-60px of vertical space
   - More room for terminal content

**Total space saved: ~90-110px!**

### Data Flow

No changes to data flow. The state management remains the same:
- `state.activeTab` tracks current tab
- `state.activeIndex` tracks current session
- `switchTab()` and `switchToSession()` continue to work as before

### Session Switching Flow

**Old:**
User swipes left/right on session-info or bottom-nav → `onTouchEnd` → changes `state.activeIndex` → calls `switchToSession()`

**New:**
User taps session selector → opens bottom sheet → user selects session → calls `switchToSession()`

## Folder/File Layout

All changes are confined to the mobile UI files:

```
src/web/public/
├── mobile.html     # HTML structure changes
├── mobile.css      # Style relocations and new styles
└── mobile.js       # JS behavior updates

dist/web/public/    # Must be synced per CLAUDE.md
├── mobile.html
├── mobile.css
└── mobile.js
```

## Milestones

### Milestone 1: Move tabs to top
**Intent:** Relocate the tab navigation from bottom to top of the screen

**Files:**
- `src/web/public/mobile.html` - Move tab HTML from `#bottom-nav` to after header
- `src/web/public/mobile.css` - Update tab styles for top placement
- `src/web/public/mobile.js` - No changes needed (tab switching logic stays the same)

**Verification:**
```bash
# Open mobile.html in browser
# Verify tabs appear at top below header
# Click Sessions/Pipelines tabs to confirm switching works
# Check active tab indicator displays correctly
```

### Milestone 2: Create session selector UI in tab bar
**Intent:** Build the new session picker integrated into the tab bar, replacing both swipe navigation and session info bar

**Files:**
- `src/web/public/mobile.html` - Add session selector button in tab bar, remove `#session-info` element
- `src/web/public/mobile.css` - Style the selector button and bottom sheet
- `src/web/public/mobile.js` - Implement selector open/close, render session list, update session display

**Verification:**
```bash
# Check Sessions tab shows: [● Session-1 ▼] format
# Tap session selector in tab bar
# Verify bottom sheet opens with session list
# Check each session shows: dot, name, branch, state badge
# Verify tap outside closes sheet
# Confirm current session is highlighted
# Verify session info bar is completely gone
```

### Milestone 3: Wire up session switching
**Intent:** Connect the session selector to the existing session switching logic

**Files:**
- `src/web/public/mobile.js` - Add click handlers to switch sessions from selector

**Verification:**
```bash
# Open session selector
# Tap different session
# Verify terminal switches to selected session
# Check session info bar updates
# Confirm selector closes after selection
```

### Milestone 4: Remove swipe navigation
**Intent:** Clean up the old swipe gesture code and session dots

**Files:**
- `src/web/public/mobile.html` - Remove `#session-dots` element
- `src/web/public/mobile.css` - Remove swipe/dot related styles
- `src/web/public/mobile.js` - Remove `setupSwipe()`, `renderDots()` calls

**Verification:**
```bash
# Verify no session dots appear
# Attempt swipe gesture (should do nothing)
# Check that all session switching still works via selector
```

### Milestone 5: Move + button to top and remove bottom nav
**Intent:** Move create button to tab bar and eliminate bottom navigation entirely

**Files:**
- `src/web/public/mobile.html` - Move + button to tab bar, remove `#bottom-nav` element
- `src/web/public/mobile.css` - Style + button in tab bar, remove bottom nav styles
- `src/web/public/mobile.js` - Update FAB click handler reference if needed

**Verification:**
```bash
# Check + button appears on right side of tab bar
# Verify no bottom navigation bar exists
# Confirm + button creates sessions/pipelines based on active tab
# Verify increased vertical space for terminal
```

### Milestone 6: Make key toolbar sticky
**Intent:** Ensure key toolbar remains visible even when mobile keyboard is open

**Files:**
- `src/web/public/mobile.css` - Add sticky/fixed positioning to `#key-toolbar`
- `src/web/public/mobile.html` - Potentially adjust container structure if needed

**Verification:**
```bash
# Open mobile.html in browser with responsive mode
# Tap in terminal to bring up virtual keyboard
# Verify key toolbar stays visible above keyboard
# Test scrolling terminal - toolbar should stay in place
# Confirm keys still work (Esc, Tab, Ctrl, arrows)
```

### Milestone 7: Sync to dist/
**Intent:** Copy changes to the served directory

**Files:**
- `dist/web/public/mobile.html`
- `dist/web/public/mobile.css`
- `dist/web/public/mobile.js`

**Verification:**
```bash
cp src/web/public/mobile.html dist/web/public/
cp src/web/public/mobile.css dist/web/public/
cp src/web/public/mobile.js dist/web/public/

# Restart web server if needed
# Test on actual mobile device or responsive mode
# Verify all features work: tab switching, session switching, terminal interaction
# Test keyboard visibility: key toolbar should stay accessible while typing
```

## Risks & Unknowns

### Risk: Session selector UX on small screens
**Probe:** Review session list bottom sheet design for usability with 5+ sessions
- Will list scrolling work smoothly?
- Is each session item height sufficient for touch targets (min 44px)?

**Mitigation:** Use touch-friendly sizing (14px font, 48px min height per item)

### Risk: Loss of quick session switching
**Probe:** Compare swipe gesture speed vs. selector tap-tap interaction
- Swipe: ~1 second
- Selector: tap → select → ~2 seconds

**Mitigation:** Make selector very obvious and easy to tap, minimize steps

### Risk: Compatibility with existing session state logic
**Probe:** Verify `state.activeIndex` updates correctly when using selector
- Check if `renderDots()` calls are still triggered anywhere
- Ensure terminal connection doesn't break on rapid switching

**Mitigation:** Thorough testing of state transitions in milestone 3

### Unknown: Visual hierarchy with tabs at top
**Question:** Should tabs be inside header or separate row?
- Option A: Separate row below header (recommended)
- Option B: Inside header (cramped on small screens)

**Resolution:** Use separate row for clarity and touch target size

### Unknown: Session selector placement
**Question:** Should selector be:
- Option A: Integrated into session-info bar (recommended)
- Option B: Separate bar between tabs and session-info
- Option C: Dropdown in header

**Resolution:** Option A - keeps related info together, no extra row

### Risk: Sticky toolbar covering content
**Probe:** Test if sticky key toolbar blocks terminal output
- Does it overlap important terminal content?
- Should it be position: sticky (scrolls with content until top) vs. position: fixed (always visible)?

**Mitigation:** Use `position: sticky; top: 0;` so it sticks to top of terminal container but doesn't overlay content unnecessarily

### Risk: + button placement in tab bar
**Probe:** Will + button fit comfortably on small screens (320px width)?
- Session selector + Pipelines tab + [+] button all in one row
- Minimum touch target is 44px

**Mitigation:** Make tabs flexible width (flex: 1), + button fixed 44px width on right

### Risk: Session name truncation in tab bar
**Probe:** Will long session names fit in the session selector tab?
- "feature/very-long-branch-name-session-3" might overflow
- Need to balance readability vs. space

**Mitigation:**
- Truncate session name with ellipsis if too long
- Show full name in bottom sheet
- Max width for session name: ~150-180px on small screens
- Use `text-overflow: ellipsis; white-space: nowrap; overflow: hidden;`

## Design Notes

### Tab Bar with Session Selector and Create Button
```html
<div id="top-tabs">
  <div id="nav-tabs">
    <!-- When on Sessions tab: show session selector -->
    <button class="nav-tab session-selector active" data-tab="sessions">
      <span class="status-dot working"></span>
      <span class="session-name">Session-1</span>
      <span class="selector-arrow">▼</span>
    </button>

    <!-- When on Pipelines tab: regular tab -->
    <button class="nav-tab" data-tab="pipelines">Pipelines</button>
  </div>
  <button id="create-btn" class="create-btn" title="Create">+</button>
</div>
```

**CSS Layout:**
- Container: `display: flex; justify-content: space-between;`
- Tabs: `flex: 1; display: flex;`
- Session selector tab: `flex: 1; display: flex; align-items: center; gap: 6px;`
- Create button: `width: 44px; height: 44px;` (fixed size)

**Behavior:**
- On Sessions tab: First button shows session info + acts as dropdown
- On Pipelines tab: First button shows "Sessions" text (or is hidden)
- Session selector updates dynamically when session changes

### Sticky Key Toolbar
```css
#key-toolbar {
  position: sticky;
  top: 0;
  z-index: 10;
  /* Rest of existing styles */
}
```

This ensures the toolbar sticks to the top of its container when scrolling, and stays above the mobile keyboard when typing.

### Session Selector Bottom Sheet Structure
```html
<div id="session-selector-sheet" class="bottom-sheet">
  <div class="sheet-backdrop"></div>
  <div class="sheet-content">
    <h3>Switch Session</h3>
    <div class="session-list">
      <button class="session-list-item active" data-index="0">
        <div class="status-dot working"></div>
        <div class="session-item-info">
          <div class="session-item-name">Session 1</div>
          <div class="session-item-meta">feature/auth • working</div>
        </div>
        <div class="session-item-check">✓</div>
      </button>
      <!-- More sessions... -->
    </div>
  </div>
</div>
```

### CSS Class Naming Conventions
- Follow existing pattern: `.pl-*` for pipeline, `.nav-*` for navigation
- Use `.session-selector-*` for new session picker components
- Maintain existing state classes: `.working`, `.waiting`, `.idle`, etc.

### Color & Spacing Consistency
- Use existing CSS variables: `--accent-purple`, `--bg-secondary`, etc.
- Maintain 8px base spacing unit
- Touch targets minimum 44px (iOS Human Interface Guidelines)

---

**Next:** `/probe 'milestone 1 - move tabs to top'`
