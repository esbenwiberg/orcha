# Dedicated Mobile PWA Route with Purpose-Built Session Monitor

## Summary
Build a separate `/mobile` route serving a lightweight Progressive Web App designed specifically for phone-sized screens. The mobile view presents one session at a time in a vertical card layout with swipe-to-switch navigation, replaces xterm.js terminal rendering with a read-only scrolling log view (capturing tmux pane content via a new API endpoint), and adds a service worker for offline caching plus Web Push notifications when session states change (e.g., "Session #3 moved from working to waiting"). The existing desktop dashboard remains completely untouched -- the mobile PWA is a parallel, independent frontend consuming the same REST + WebSocket API.

## When to use
- When the primary mobile use case is monitoring and lightweight interaction -- checking which sessions are working/waiting/done, reading recent terminal output, creating new sessions, and receiving alerts -- rather than full terminal interaction.
- When the user accesses the dashboard over a mobile browser via SSH tunnel (using an app like Termius or JuiceSSH that supports port forwarding) or eventually through a reverse proxy with auth.
- When you want to ship something useful in 2-3 days without touching the existing desktop frontend at all.

## How it works

### Architecture overview

1. **New static files**: `mobile.html`, `mobile.css`, `mobile.js` in `src/web/public/`, plus `manifest.json` and `sw.js` for PWA capabilities. The server already serves the `public/` directory statically, so `/mobile` maps to `mobile.html` with no server changes needed (use a simple redirect or just access `mobile.html` directly).

2. **Session card view**: Instead of a terminal grid, the mobile view shows a single "session card" filling the viewport. The card displays:
   - Session name/branch at the top
   - Large status indicator (colored dot + label: "working", "waiting", etc.)
   - Instance/repo name
   - Last status message
   - Recent terminal output (last ~50 lines) in a monospace scrollable area
   - Action buttons at the bottom (type input to send text to tmux pane via WebSocket)

3. **Navigation**: Horizontal swipe gestures switch between sessions. A bottom tab bar shows dots for each session (color-coded by state), with the current session highlighted. A "burger" menu slides in a session list from the left for direct selection. Pull-down gesture refreshes data.

4. **New API endpoint -- `/api/sessions/:instanceId/:sessionId/capture`**: Returns the last N lines of tmux pane content via `tmux capture-pane -p -S -50`. This is a lightweight alternative to establishing a full WebSocket PTY connection, suitable for the read-only monitoring use case. The mobile client polls this every 5 seconds (configurable), which is much cheaper than maintaining an xterm.js terminal.

5. **Optional terminal WebSocket**: For users who do want to type into a session from mobile, the existing WebSocket PTY mechanism works. The mobile view can open a "full terminal" mode that uses a simplified xterm.js instance with larger font and touch-friendly scrolling. This is an opt-in escalation from the default read-only view.

6. **Service worker + Web Push notifications**:
   - `sw.js` caches the mobile shell (HTML/CSS/JS) for offline-capable loading.
   - The mobile client polls `/api/status` every 10 seconds and compares session states to the previous poll. When a state changes, it fires a local `Notification` (no push server needed -- just the Notifications API).
   - This works over localhost via SSH tunnel without HTTPS because `localhost` is treated as a secure context by browsers.
   - Future enhancement: add a server-side Web Push endpoint for true push notifications when the browser tab is closed (requires HTTPS + VAPID keys, which would come with the auth/proxy layer).

7. **PWA manifest**: `manifest.json` enables "Add to Home Screen" on mobile browsers. The app launches in standalone mode (no browser chrome), making it feel like a native app. The manifest defines the app name, icons, theme color, and start URL (`/mobile`).

8. **Session creation**: A floating "+" button opens a bottom sheet form for creating new sessions. The form uses the existing `/api/sessions` POST endpoint and shows a simplified version of the desktop's session creation dialog (instance selector, branch name, mode toggle).

### Data flow

- Mobile client loads `mobile.html` which pulls in `mobile.css` and `mobile.js`.
- On init, `mobile.js` fetches `/api/status` and `/api/instances` to populate the session list and instance data.
- The active session card polls `/api/sessions/:instanceId/:sessionId/capture` for terminal output.
- State change detection happens client-side by diffing consecutive `/api/status` responses.
- Notifications are triggered via the browser Notifications API (local, no server-side push infrastructure).
- Session creation, git actions, etc. use the same REST endpoints as the desktop dashboard.

## Key decisions / tradeoffs

1. **Separate route vs. responsive redesign of existing UI**: Chose separate route. The desktop dashboard's terminal grid, keyboard shortcuts, and xterm.js rendering are fundamentally desktop experiences. Trying to make them responsive would compromise both desktop and mobile UX. A separate `/mobile` route lets each interface be optimal for its platform.

2. **Read-only capture vs. full WebSocket PTY**: Default to polling `tmux capture-pane` output rather than establishing WebSocket PTY connections. This is dramatically simpler, uses less bandwidth, and is what you actually need 90% of the time on mobile (just checking status and reading output). Full terminal is available as an opt-in.

3. **Local notifications vs. Web Push**: Start with local Notifications API (requires tab to be open/in background). Web Push needs HTTPS and a push server, which adds complexity that belongs in the future auth/proxy layer. Local notifications still work well for the SSH tunnel use case since the user has the mobile browser open.

4. **No xterm.js by default on mobile**: Terminal emulation on touch screens is a poor experience. The capture-based log view with monospace styling is more readable, uses less CPU/memory, and loads faster. xterm.js is only loaded if the user explicitly opens "full terminal" mode.

5. **Polling vs. Server-Sent Events (SSE)**: Chose polling for simplicity. SSE would be more efficient but adds server-side complexity. The polling intervals (5s for capture, 10s for status) are light enough that efficiency is not a concern for a single-user tool.

## Pros
- Zero impact on the desktop dashboard -- completely additive change
- No server code changes needed for the basic version (just new static files + one new API endpoint)
- Works over existing SSH tunnel setup with no auth infrastructure changes
- PWA "Add to Home Screen" makes it feel native without an app store
- Read-only capture view is extremely lightweight on mobile CPU/battery
- Local notifications provide session state alerts without push infrastructure
- Can be built incrementally: card view first, then notifications, then optional terminal mode
- Simple technology: vanilla JS, same patterns as existing `app.js`

## Cons
- Two separate frontends to maintain (though mobile is much simpler)
- Polling-based capture has 5-second latency for terminal output updates
- Local notifications require the mobile browser tab to stay alive (not true background push)
- No HTTPS means some PWA features are limited (no real push notifications, no background sync)
- Manual navigation to `/mobile` or `/mobile.html` -- no auto-detection of mobile devices
- The capture API returns plain text, losing terminal colors/formatting (acceptable for monitoring)

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| `tmux capture-pane` is slow or unreliable | Low | Medium | Already used elsewhere in the codebase (batch-issues script). Add timeout and fallback to empty output. Cache last capture server-side for 2 seconds to avoid repeated calls. |
| Mobile browser kills background tab, stopping notifications | Medium | Medium | Document that the mobile browser should be configured to not suspend the Orcha tab. PWA standalone mode helps here. Ultimately mitigated by Web Push in the auth/proxy phase. |
| SSH tunnel from mobile is cumbersome to set up | Medium | High | Document the recommended mobile SSH app setup (Termius with persistent tunnels). This is a pre-existing constraint, not introduced by this solution. The auth/proxy phase (future) will eliminate the tunnel requirement. |
| Swipe gestures conflict with browser gestures | Medium | Low | Use a horizontal swipe library (or simple touch event handling) with velocity thresholds that distinguish intentional swipes from incidental touches. Disable browser back-swipe via `touch-action: pan-y` CSS. |
| Two frontends diverge over time | Low | Medium | The mobile frontend is simple and read-only-focused, making divergence unlikely. Shared API means data model changes propagate naturally. |

## Quick start (first 1-2 days)

### Day 1: Core mobile view
- **Deliverable**: `mobile.html`, `mobile.css`, `mobile.js`, `manifest.json` serving a working session list and card view.
- Create `mobile.html` with viewport meta, dark theme, session card layout.
- Implement `mobile.js`: fetch `/api/status`, render session list, show single session card with state/message/branch.
- Add the `/api/sessions/:instanceId/:sessionId/capture` endpoint to `server.ts` (single `execSync` of `tmux capture-pane`).
- Implement swipe navigation between session cards using touch events.
- Copy new files to `dist/web/public/` per project build rules.

### Day 2: Notifications + session creation + polish
- Add state change detection (diff consecutive `/api/status` responses) and fire `Notification` API alerts.
- Implement the "create session" bottom sheet form using existing `/api/sessions` POST.
- Add `sw.js` for offline caching of the mobile shell.
- Add "Add to Home Screen" prompt via `manifest.json` and install banner.
- Polish: loading states, error handling, pull-to-refresh, session state color coding.

## Open questions
1. **Auto-redirect mobile users?** Should the server detect `User-Agent` and redirect mobile browsers to `/mobile`, or should it always be a manual choice? Auto-redirect could be annoying for laptop users who resize their window.
2. **Terminal input on mobile**: Is typing into sessions from a phone a real use case, or is monitoring + session creation sufficient? This determines whether to invest in the optional xterm.js full-terminal mode.
3. **SSH tunnel on mobile**: What mobile SSH app does the user currently use (or plan to use)? This affects documentation and any SSH-related UX considerations.
4. **Notification granularity**: Should notifications fire for every state change, or only for specific transitions (e.g., working->waiting, anything->error, anything->done)? Excessive notifications would be noisy.
5. **Session actions on mobile**: Beyond viewing and creating, should the mobile view support session deletion, git actions (commit/push/PR), or restart? Each adds UI complexity.

---

## Self-score
- Clarity: 5/5
- Feasibility: 5/5
- Impact: 4/5
- Flexibility: 4/5
- Risk (inverse): 4/5
**Total: 22/25**
