# Tailscale Mesh VPN for Zero-Config Mobile Access

## Summary
Use Tailscale (built on WireGuard) to create a private overlay network between the Azure VM and your mobile device. Instead of modifying the Orcha application itself, Tailscale assigns each device a stable private IP (100.x.y.z) and handles encrypted, peer-to-peer tunneling automatically. The server continues to listen on localhost:3847, but Tailscale's `serve` or `funnel` feature (or simply binding to the Tailscale interface) proxies traffic from your phone to the dashboard. The existing CSS responsive breakpoints (800px, 600px) provide a baseline mobile layout with the sidebar hidden at 600px, and a lightweight `/mobile` route or viewport-aware JS toggle can provide the single-session-at-a-time view the issue requests. Authentication comes from Tailscale's identity layer, meaning no passwords, tokens, or certificates to manage in the Orcha app.

## When to use
- You already have an Azure VM and SSH-tunnel workflow and want the least disruptive path to mobile access.
- You need always-on access from a phone without exposing any ports to the public internet.
- You want to avoid building and maintaining your own authentication system.
- Your team is small (1-3 people) -- Tailscale's free tier supports up to 100 devices.
- You want a solution deployable in hours, not days or weeks.

## How it works

### Phase 1: Network layer (Tailscale)
1. **Install Tailscale on the Azure VM**: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`. The VM gets a stable Tailscale IP (e.g., `100.64.0.1`).
2. **Install Tailscale on your phone**: Download the Tailscale iOS/Android app, sign in with the same account. Your phone gets its own Tailscale IP (e.g., `100.64.0.2`).
3. **Bind Orcha to the Tailscale interface**: Change the server listen from `this.server.listen(this.port)` to `this.server.listen(this.port, '0.0.0.0')`, but configure the Azure VM's firewall (NSG) to block port 3847 from the public internet. Tailscale traffic uses its own encrypted tunnel on UDP 41641 and does not need inbound port rules for 3847. Alternatively, keep localhost binding and use `tailscale serve --bg 3847` to proxy Tailscale-authenticated HTTPS traffic to localhost:3847.
4. **Access from phone**: Open `http://100.64.0.1:3847` (direct) or `https://your-vm.tail1234.ts.net:443` (via `tailscale serve`) in the mobile browser.

### Phase 2: Mobile-optimized view (minimal app changes)
5. **Add a mobile route/toggle**: Detect `?view=mobile` query param or viewport width < 768px. When in mobile mode, the JS app renders a simplified view: session list as a full-screen selector, tapping a session shows it full-screen (one terminal at a time), with a floating "back" button to return to the list. This leverages the existing fullscreen panel CSS (`.terminal-panel.fullscreen`) and session list UI.
6. **Touch-friendly adjustments**: Increase tap targets in the sidebar session list (min 44px height per item), add swipe gesture for switching sessions (optional), and ensure xterm.js touch scrolling works (it does by default with `xterm-addon-fit`).

### Phase 3: Optional hardening
7. **Tailscale ACLs**: Define access rules so only your specific devices can reach the VM on port 3847. This is configured in the Tailscale admin console, not on the VM.
8. **HTTPS via Tailscale**: `tailscale serve` automatically provisions a Let's Encrypt certificate for `your-vm.tail1234.ts.net`, giving you HTTPS with no cert management.
9. **MagicDNS**: Use the human-readable hostname `orcha-vm.tail1234.ts.net` instead of raw IPs.

## Key decisions / tradeoffs

| Decision | Choice | Rationale |
|---|---|---|
| VPN provider | Tailscale (not raw WireGuard) | Tailscale handles key exchange, NAT traversal, and device auth. Raw WireGuard requires manual key management and config files on each device. |
| Server binding | `tailscale serve` proxy (preferred) over `0.0.0.0` binding | Keeps localhost-only security model intact. `tailscale serve` acts as an authenticating reverse proxy. If `tailscale serve` adds latency for WebSocket, fall back to `0.0.0.0` + NSG firewall. |
| Mobile view approach | Query param + viewport detection in existing JS | Avoids a separate frontend codebase. The mobile view is a layout mode, not a different application. |
| Authentication | Tailscale device identity only (no app-level auth) | For a single-user or small-team tool, Tailscale's device-level auth (login required to join the tailnet) is sufficient. No need to add login pages, sessions, or tokens to Orcha. |
| WebSocket over Tailscale | Direct WS over Tailscale IP or WSS via `tailscale serve` | WebSocket works over Tailscale's WireGuard tunnel natively. `tailscale serve` can proxy WebSocket as well, providing WSS. |

## Pros
- No public internet exposure at all -- the dashboard never leaves the private Tailscale network.
- Zero application-level authentication to build or maintain. Tailscale handles identity.
- Minimal code changes to Orcha -- the mobile view is additive CSS/JS, not a rewrite.
- Works from any network (cellular, coffee shop WiFi, etc.) because Tailscale handles NAT traversal.
- Free tier supports the use case (single user, a few devices).
- Encrypted end-to-end with WireGuard (faster than OpenVPN, built into the Linux kernel).
- `tailscale serve` provides automatic HTTPS certificates, which enables clipboard API, service workers, and other features that require secure contexts on mobile.
- SSH tunnel workflow on laptop remains unchanged -- you can keep using it alongside Tailscale.
- Peer-to-peer when possible (no relay server), so latency is typically very low.

## Cons
- Adds a dependency on Tailscale, a third-party service. If Tailscale's coordination server is down, new connections cannot be established (existing ones continue).
- Tailscale must be running on the phone at all times for access -- drains a small amount of battery.
- The mobile view still needs to be built (CSS + JS changes to app.js), though it is modest work.
- xterm.js on mobile is inherently limited -- no physical keyboard means terminal interaction is awkward. For read-only monitoring this is fine, but typing commands is clunky.
- If you later need to share access with someone outside your Tailscale account, you must either add them to your tailnet (shared nodes) or use Tailscale Funnel (which does expose to the public internet, albeit with Tailscale auth).
- `tailscale serve` adds a small layer of latency for each request vs. direct binding.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Tailscale coordination server outage | Low | Medium (no new connections) | Existing connections are peer-to-peer and survive. Keep SSH tunnel as backup access method. |
| WebSocket latency over Tailscale | Low | Medium (terminal feels sluggish) | Test with direct Tailscale IP first. WireGuard adds ~1-2ms overhead typically. If issues, bypass `tailscale serve` and bind directly. |
| Azure NSG misconfiguration exposes port 3847 | Medium | High (unauthenticated dashboard on internet) | Do NOT change the NSG rules. Keep port 3847 blocked from public internet. Tailscale traffic uses UDP 41641 which Azure allows by default for outbound. Add an `allowedHosts` middleware as defense-in-depth. |
| Phone stolen with Tailscale connected | Low | High (attacker has VPN access) | Enable Tailscale's device approval / key expiry in admin console. Use phone lock screen. Revoke device immediately from Tailscale admin. |
| Mobile view has poor UX | Medium | Low (still functional, just not ideal) | Start with the simplest possible mobile layout (list view + single fullscreen terminal). Iterate based on actual usage. |
| Tailscale free tier limits change | Low | Medium | The free tier has been stable for years. If it changes, self-hosted Headscale is a drop-in replacement for the coordination server. |

## Quick start (first 1-2 days)

### Day 1: Tailscale setup + verification (2-3 hours)
- **Owner**: Infrastructure / the developer
- **Steps**:
  1. Install Tailscale on the Azure VM: `curl -fsSL https://tailscale.com/install.sh | sh && sudo tailscale up`
  2. Install Tailscale on your phone (iOS App Store or Google Play)
  3. Verify connectivity: from phone, ping the VM's Tailscale IP (`100.x.y.z`)
  4. Run `tailscale serve --bg 3847` on the VM to proxy HTTPS to Orcha's localhost:3847
  5. Open `https://your-vm.tail1234.ts.net` on the phone's browser -- confirm the existing dashboard loads
  6. Test WebSocket terminal connectivity (open a session, verify terminal output streams)
- **Deliverable**: Dashboard accessible from phone over Tailscale with working terminal output

### Day 2: Mobile view (3-4 hours)
- **Owner**: Frontend developer
- **Steps**:
  1. Add viewport detection in `app.js`: if width < 768px or `?view=mobile` param, set `state.mobileMode = true`
  2. In mobile mode: render session list as full-screen cards instead of sidebar items; on tap, open that session fullscreen (reuse existing fullscreen logic)
  3. Add a "back to sessions" floating button when viewing a single session
  4. Add a "new session" button accessible from the mobile session list
  5. Increase sidebar item tap targets to 44px minimum for mobile
  6. Test on actual phone over Tailscale
- **Deliverable**: Functional mobile view with session list, single-session terminal view, and session creation

## Open questions
1. **`tailscale serve` vs. direct binding**: Does `tailscale serve` handle WebSocket upgrades reliably for xterm.js? Need to test. If not, binding to `0.0.0.0` with NSG protection is the fallback.
2. **xterm.js mobile keyboard**: Should we integrate a virtual keyboard optimized for terminal use (e.g., common keys like Ctrl+C, Tab, arrow keys as floating buttons), or is the native phone keyboard sufficient for the monitoring use case?
3. **Multiple users**: Will other team members need mobile access? If so, should we use Tailscale's shared nodes feature or set up a proper auth layer?
4. **Headscale fallback**: Should we preemptively plan for self-hosted Headscale in case Tailscale's terms change, or is that premature optimization?
5. **Battery impact**: How much battery does Tailscale consume on mobile when left running in the background? Worth measuring during the Day 1 testing.
6. **Notification support**: The issue mentions checking on long-running tasks. Should we consider push notifications (via a Tailscale-accessible webhook) when sessions change state, rather than requiring the user to manually check the dashboard?

---

## Self-score
- Clarity: 5/5
- Feasibility: 5/5
- Impact: 4/5
- Flexibility: 4/5
- Risk (inverse): 4/5
**Total: 22/25**
