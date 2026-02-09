# SSH Tunnel + Mobile-Optimized Route (Zero Infrastructure Change)

## Summary
Keep the existing SSH tunnel security model unchanged. Add a dedicated `/mobile` route to the same Express server that serves a single-session-at-a-time mobile UI. On the phone, you SSH tunnel exactly as you do on the laptop (`ssh -L 3847:localhost:3847 user@vm`), then open `localhost:3847/mobile` in mobile Safari/Chrome. The mobile view is a new lightweight HTML page that reuses the existing API endpoints and WebSocket protocol but replaces the grid layout with a card-based session list and a fullscreen terminal view per session. No new dependencies, no new ports, no auth layer, no reverse proxy.

## When to use
- You already have SSH client apps on your phone (Termius, iSH, Blink Shell, JuiceSSH).
- You want to check on sessions occasionally, not run a persistent mobile dashboard.
- You are the only user; multi-user auth is not a requirement.
- You want something working today, not next week.

## How it works

### Step 1: Mobile SSH tunnel from phone
Use an SSH app on mobile (Termius, Blink Shell, etc.) that supports local port forwarding. Configure it to forward `localhost:3847` on the phone to `localhost:3847` on the Azure VM, identical to the laptop setup. This is a one-time configuration.

### Step 2: New `/mobile` route on the existing Express server
Add a `mobile.html` static file served at `/mobile`. This page is purpose-built for small screens:

1. **Session list view** (default): Vertical scrollable list of all sessions grouped by instance, showing status dot, session name, branch, and current status. Tap a session to open it. A "+" button at the top opens a minimal session creation form.
2. **Session detail view**: Fullscreen xterm.js terminal for the selected session. A top bar shows session name, status dot, and a back button. The terminal occupies the full remaining viewport. Because xterm.js already works on mobile (touch scrolling, virtual keyboard), this is functional out of the box.
3. **Navigation**: Simple stack navigation -- list -> detail -> back to list. No sidebar, no grid. Use `history.pushState` so the browser back button works.

### Step 3: Shared API, no duplication
The mobile page calls the exact same `/api/sessions`, `/api/instances`, `/api/status`, `/api/health`, and `POST /api/sessions` endpoints. The WebSocket connection for terminal I/O uses the same protocol. The only new code is the mobile HTML/CSS/JS frontend -- roughly 300-500 lines total.

### Step 4: Auto-detect and redirect (optional)
Add a small user-agent check or `max-width` media query in `index.html` that shows a banner: "On mobile? Tap here for mobile view" linking to `/mobile`. Do NOT auto-redirect -- the desktop view may still be usable on tablets.

## Key decisions / tradeoffs

| Decision | Rationale |
|----------|-----------|
| Reuse SSH tunnel for mobile access | Zero new attack surface. No public endpoints, no TLS certificates, no auth tokens. The phone connects identically to the laptop. |
| Separate `/mobile` page instead of responsive CSS on existing page | The desktop UI is deeply tied to grid layout + multi-panel xterm.js. Making it responsive would require rewriting half of `app.js`. A separate 400-line mobile page is faster and cleaner. |
| No read-only mode | You asked for the ability to create sessions from mobile. Full read-write access via the same APIs. |
| xterm.js on mobile | Touch input works but is not ideal for heavy typing. This is acceptable because the primary mobile use case is monitoring, not coding. Session creation only needs a branch name. |
| No push notifications | SSH tunnel must be active to see the dashboard. You cannot get alerts when sessions finish unless the tunnel is open. This is a known limitation. |
| Single HTML file with inline CSS/JS | Keeps the mobile view self-contained. No build step. Easy to iterate. |

## Pros
- **Truly zero infrastructure change**: No new ports, no reverse proxy, no DNS, no TLS certs, no auth system.
- **Identical security posture**: SSH tunnel means the dashboard never touches the public internet.
- **Extremely fast to implement**: ~1-2 days for a fully working mobile view.
- **No new dependencies**: Uses the same xterm.js CDN, same Express server, same WebSocket protocol.
- **Works offline after tunnel is established**: No external service dependency.
- **Easy to maintain**: Mobile page is decoupled from desktop -- changes to one do not affect the other.

## Cons
- **Requires SSH app on phone**: Must install and configure Termius/Blink Shell/similar. One-time setup but still friction.
- **Tunnel must be active to view**: No background monitoring. If the SSH connection drops (phone sleeps, network switch), you lose access until you reconnect.
- **No push notifications**: Cannot alert you when a session finishes. You must actively check.
- **xterm.js on mobile is limited**: Virtual keyboard covers half the screen. Good enough for monitoring and quick commands, bad for serious typing.
- **Maintaining two frontends**: Desktop `app.js` and `mobile.html` can drift. Shared API is the contract but UI logic is duplicated.
- **Battery/data**: Keeping an SSH tunnel alive on mobile drains battery faster than a native app would.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| SSH tunnel drops when phone sleeps | High | Medium | Use an SSH app with background keepalive (Termius supports this). Set `ServerAliveInterval 30` in SSH config. Accept that reconnection may be needed. |
| xterm.js unusable on very small screens (<375px) | Low | Medium | Set minimum font size, use `xterm-addon-fit` aggressively. Test on iPhone SE as the smallest target. |
| Mobile page gets out of sync with API changes | Medium | Low | Mobile page only uses stable `/api/sessions` and `/api/instances` endpoints. Add a version check at startup that warns if the API has changed. |
| User forgets tunnel is needed | Medium | Low | Show a clear error message in `mobile.html` if the API fetch fails: "Cannot reach Orcha server. Is your SSH tunnel active?" |
| Virtual keyboard obscures terminal | High | Low | Add a "keyboard dismiss" button in the terminal header. Use CSS `env(safe-area-inset-bottom)` and `visualViewport` API to resize terminal when keyboard appears. |

## Quick start (first 1-2 days)

### Day 1: Mobile HTML page + session list
1. Create `src/web/public/mobile.html` with inline CSS and JS.
2. Implement session list view: fetch `/api/sessions` and `/api/instances`, render grouped list with status dots.
3. Implement basic session detail view: tap session -> fullscreen xterm.js terminal with back button.
4. Copy to `dist/web/public/mobile.html`.
5. Test with browser DevTools mobile emulation.

### Day 2: Session creation + polish
1. Add "create session" flow: instance picker -> branch input -> POST to `/api/sessions`.
2. Add auto-refresh polling (every 5s, same as desktop).
3. Handle SSH tunnel detection: show helpful error if API unreachable.
4. Test on actual phone with Termius SSH tunnel.
5. Add mobile detection banner to desktop `index.html`.

**Deliverable**: Working `/mobile` route accessible via SSH tunnel from any phone with an SSH client app.

## Open questions
1. **Which SSH app to standardize on?** Termius (free tier) supports local port forwarding and background connections. Blink Shell is iOS-only but excellent. Need to pick one to document setup steps.
2. **Should the mobile view support terminal input at all?** If the use case is purely monitoring, we could make the terminal read-only and save significant complexity around virtual keyboard handling.
3. **Auto-refresh interval**: Desktop uses a 2-second poll. Should mobile use a longer interval (5-10s) to save battery when on cellular?
4. **Should we eventually add Tailscale/WireGuard instead of SSH tunneling?** That would eliminate the need for an SSH app but is a bigger change. Worth considering as a follow-up if the SSH approach feels too cumbersome.
5. **iPad/tablet**: Should `/mobile` also be used on tablets, or should the desktop view have a responsive tablet mode? Tablets can handle the grid layout at reduced column count.

---

## Self-score
- Clarity: 5/5
- Feasibility: 5/5
- Impact: 3/5
- Flexibility: 3/5
- Risk (inverse): 4/5
**Total: 20/25**

Rationale: This scores highest on clarity and feasibility because there is literally nothing to configure or deploy beyond writing a single HTML file. Impact is moderate -- it solves the mobile access problem but the SSH tunnel requirement means it is not seamless (you cannot just open a URL from a push notification). Flexibility is moderate because this approach does not extend to multi-user scenarios or public access without significant rework. Risk is low because there are no moving parts beyond what already exists.
