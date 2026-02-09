# Cloudflare Tunnel + Zero Trust Access for Secure Mobile Dashboard

## Summary
Replace the SSH tunnel access model with Cloudflare Tunnel (`cloudflared`) to securely expose the Orcha dashboard over the internet without opening any ports on the Azure VM. Pair this with Cloudflare Access (part of Zero Trust) to enforce authentication via email OTP or OAuth before any request reaches the Express server. The Orcha server continues to bind to localhost -- `cloudflared` establishes an outbound-only encrypted connection to Cloudflare's edge, which reverse-proxies authenticated traffic back. This gives the dashboard a stable HTTPS URL (e.g., `orcha.yourdomain.com`) accessible from any device, including mobile, while layering enterprise-grade identity checks in front of an application that currently has zero authentication. A dedicated `/m` mobile route with a single-session-at-a-time view would complement this by making the dashboard usable on small screens.

## When to use
- You need to check on long-running AI sessions from a phone without being near the laptop.
- You want to eliminate the SSH tunnel setup entirely (or make it optional for power users).
- You want authentication without writing and maintaining your own auth layer.
- You want HTTPS for free without managing TLS certificates.
- You are already using (or willing to use) Cloudflare for DNS on at least one domain.

## How it works

### Infrastructure layer (Cloudflare Tunnel + Access)

1. **Install `cloudflared` on the Azure VM.** It is a single static binary (~30 MB). It runs as a systemd service.

2. **Create a Cloudflare Tunnel.** This is done via `cloudflared tunnel create orcha`. It generates a tunnel ID and credentials JSON file stored at `~/.cloudflared/<tunnel-id>.json`. The tunnel establishes a persistent outbound QUIC/HTTP2 connection from the VM to Cloudflare's nearest edge PoPs -- no inbound ports need to be open.

3. **Configure the tunnel** to route traffic from a hostname (e.g., `orcha.yourdomain.com`) to `http://localhost:3847`. The config file (`~/.cloudflared/config.yml`) looks like:
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json

   ingress:
     - hostname: orcha.yourdomain.com
       service: http://localhost:3847
       originRequest:
         noTLSVerify: false
     - service: http_status:404
   ```

4. **Create a DNS CNAME record** that points `orcha.yourdomain.com` to `<tunnel-id>.cfargotunnel.com`. This can be done automatically via `cloudflared tunnel route dns orcha orcha.yourdomain.com`.

5. **Configure Cloudflare Access** (in the Zero Trust dashboard) to protect `orcha.yourdomain.com`:
   - Create an Access Application for the hostname.
   - Add an Access Policy with allowed identity methods: email OTP (sends a code to your email -- no IdP needed), or optionally Google/GitHub/Microsoft OAuth.
   - Configure session duration (e.g., 24 hours) so you do not need to re-auth on every request.
   - Cloudflare Access injects a signed JWT (`Cf-Access-Jwt-Assertion` header) into every request that passes through. The Orcha server can optionally validate this JWT for defense-in-depth.

6. **WebSocket support** works out of the box. Cloudflare Tunnel supports WebSocket proxying natively. The xterm.js terminal connections will work without modification, as long as the WebSocket upgrade is happening on the same hostname.

7. **Run `cloudflared` as a systemd service** for persistence across reboots:
   ```bash
   cloudflared service install
   ```

### Application layer (Mobile view)

8. **Add a `/m` route** that serves a mobile-optimized single-page view. This route serves the same `index.html` but with a query parameter (`?mobile=1`) that triggers a different UI mode in `app.js`:
   - Sidebar becomes a full-screen session selector (list of sessions with status indicators and instance grouping).
   - Tapping a session opens a full-screen xterm.js terminal for that single session.
   - A floating action button provides: back to session list, create new session, and session status summary.
   - No terminal grid -- always one session at a time.

9. **Auto-detect mobile** via `window.matchMedia('(max-width: 768px)')` or user-agent sniffing, and redirect to mobile mode automatically. Allow manual override via URL parameter.

10. **Optimize xterm.js for touch**:
    - Enable touch scrolling on the terminal viewport.
    - Add a soft keyboard toggle button (mobile keyboards obscure the terminal otherwise).
    - Increase tap targets for session switching.
    - Consider a read-only mode by default on mobile (prevent accidental input) with an explicit "interact" toggle.

### Server-side validation (optional defense-in-depth)

11. **Validate the `Cf-Access-Jwt-Assertion` header** on every request as Express middleware. This ensures that even if someone bypasses Cloudflare (e.g., discovers the VM's IP), the server rejects unauthenticated requests. Cloudflare publishes the public keys at `https://<team-name>.cloudflareaccess.com/cdn-cgi/access/certs`, and the JWT can be verified with a lightweight library like `jose`.

## Key decisions / tradeoffs

| Decision | Alternative considered | Why this choice |
|----------|----------------------|-----------------|
| Cloudflare Tunnel over Tailscale/WireGuard | Tailscale creates a private mesh VPN | CF Tunnel gives a public URL with no client-side app install, critical for mobile browser access. Tailscale would require installing the Tailscale app on the phone. |
| Cloudflare Access over custom auth middleware | Rolling our own JWT/session auth | Zero code to maintain, enterprise-grade security, supports MFA and multiple IdPs. Custom auth is a liability for a personal tool. |
| Email OTP as primary auth method | OAuth with Google/GitHub | Email OTP has zero setup cost (no OAuth app registration). Can add OAuth later. |
| Keep server binding to localhost | Bind to 0.0.0.0 + add auth middleware | Binding to localhost means the only ingress is through `cloudflared`, providing network-level isolation even if the auth layer has bugs. |
| Mobile view as a JS-driven mode, not a separate SPA | Separate React/mobile app | Keeps the codebase as a single vanilla JS file. No build system. No duplication of API logic. Just conditional rendering. |
| Session duration of 24 hours | Shorter (1 hour) or longer (7 days) | Balances security with convenience for frequent mobile checks. Configurable later. |

## Pros
- **Zero inbound ports**: The Azure VM firewall needs no changes. `cloudflared` makes only outbound connections.
- **Free HTTPS**: Cloudflare provides TLS termination at the edge. No Let's Encrypt, no certificate management.
- **No client-side app on mobile**: Access via any mobile browser with a standard HTTPS URL.
- **Authentication without code changes**: Cloudflare Access sits in front as a reverse proxy. The Orcha server code does not need to implement auth (though JWT validation is recommended for defense-in-depth).
- **WebSocket support**: Terminal I/O over WebSocket works through Cloudflare Tunnel without modification.
- **Free tier sufficient**: Cloudflare's free plan includes Tunnels and up to 50 Access seats (users). This is a personal/small-team tool.
- **Eliminates SSH tunnel ceremony**: No more `ssh -L 3847:localhost:3847 user@vm` every time you want to use the dashboard from the laptop either.
- **Stable URL**: `orcha.yourdomain.com` works from any device, any network, permanently.
- **Defense-in-depth**: Cloudflare's DDoS protection, bot management, and WAF sit in front for free.

## Cons
- **Cloudflare dependency**: You are now reliant on Cloudflare's infrastructure being available. If Cloudflare has an outage, the dashboard is inaccessible remotely (local SSH tunnel still works as fallback).
- **Requires a domain**: You need a domain with DNS managed by Cloudflare (or at least a CNAME). Cost: ~$10/year for a cheap domain if you do not already have one.
- **Latency overhead**: Requests traverse Cloudflare's edge network, adding 10-50ms of latency compared to direct SSH tunnel. For a monitoring dashboard, this is negligible. For interactive terminal typing, it may be slightly noticeable.
- **WebSocket connection longevity**: Cloudflare has a 100-second idle timeout on WebSocket connections. The xterm.js client will need to implement reconnection logic (ping/pong heartbeats or auto-reconnect on close). This is a real issue for terminals left open while the phone screen is off.
- **Cloudflare Access session cookies**: Mobile browsers can be aggressive about clearing cookies. If the session cookie is lost, the user must re-authenticate (email OTP). This is mildly annoying but acceptable.
- **Mobile terminal UX is inherently limited**: Even with a dedicated mobile view, typing commands on a phone keyboard into a terminal is awkward. The primary mobile use case should be read-only monitoring, not interactive terminal use.
- **`cloudflared` is another daemon to maintain**: It needs to be kept updated and monitored for crashes. Systemd handles restarts, but it is one more thing to manage.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Cloudflare outage blocks access | Low | Medium | Keep SSH tunnel as documented fallback. The server still binds to localhost. |
| WebSocket idle timeout drops terminal connections | High | Medium | Implement WebSocket heartbeat ping every 30 seconds in `app.js`. Add auto-reconnect logic with exponential backoff. |
| `cloudflared` process crashes | Low | Medium | Run as systemd service with `Restart=always`. Add a health check endpoint (`/api/health` already exists) and optional uptime monitoring. |
| Credentials file (`<tunnel-id>.json`) exposed | Low | High | Restrict file permissions to `600`. Store in user home directory, not in the repo. Add `.cloudflared/` to `.gitignore`. |
| Someone discovers VM's public IP and bypasses Cloudflare | Low | High | Validate `Cf-Access-Jwt-Assertion` JWT in Express middleware. Optionally, use Azure NSG to block all inbound traffic on port 3847 (it should already be blocked since the server binds to localhost). |
| Mobile phone stolen while session is active | Low | Medium | 24-hour session expiry limits exposure. Can revoke sessions from Cloudflare Zero Trust dashboard. |
| Touch input sends unintended commands to terminal | Medium | Medium | Default mobile view to read-only mode. Require explicit toggle to enable terminal input. |

## Quick start (first 1-2 days)

### Day 1: Infrastructure setup (2-3 hours)

**Owner**: DevOps / the person with Azure VM access

1. **Install `cloudflared` on the Azure VM**:
   ```bash
   curl -L --output cloudflared.deb https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
   sudo dpkg -i cloudflared.deb
   ```

2. **Authenticate and create tunnel**:
   ```bash
   cloudflared tunnel login  # Opens browser to authorize
   cloudflared tunnel create orcha
   cloudflared tunnel route dns orcha orcha.yourdomain.com
   ```

3. **Write config** (`~/.cloudflared/config.yml`):
   ```yaml
   tunnel: <tunnel-id>
   credentials-file: /home/<user>/.cloudflared/<tunnel-id>.json
   ingress:
     - hostname: orcha.yourdomain.com
       service: http://localhost:3847
     - service: http_status:404
   ```

4. **Install as systemd service and start**:
   ```bash
   sudo cloudflared service install
   sudo systemctl start cloudflared
   sudo systemctl enable cloudflared
   ```

5. **Configure Cloudflare Access** (in the Zero Trust dashboard at `https://one.dash.cloudflare.com`):
   - Create Application > Self-hosted > hostname: `orcha.yourdomain.com`
   - Add Policy: "Allow" > Include > Emails: `your@email.com`
   - Authentication: Enable "One-time PIN"
   - Session duration: 24 hours

6. **Test**: Open `https://orcha.yourdomain.com` on phone. You should see the email OTP gate, then after authentication, the Orcha dashboard.

**Deliverable**: Dashboard accessible at `https://orcha.yourdomain.com` with email OTP authentication.

### Day 2: Mobile view + WebSocket resilience (4-6 hours)

**Owner**: Frontend developer

1. **Add WebSocket heartbeat** in `app.js`:
   - Send a ping message every 30 seconds on each WebSocket connection.
   - Implement auto-reconnect with exponential backoff when the connection drops.

2. **Add mobile detection and conditional rendering** in `app.js`:
   - Detect `?mobile=1` query parameter or `(max-width: 768px)` media query.
   - When in mobile mode: hide the terminal grid, show a full-screen session list, and render a single terminal on tap.

3. **Update CSS** with mobile-specific styles:
   - Full-screen session list with large touch targets.
   - Full-screen terminal view with a floating "back" button.
   - Touch-friendly action buttons.

4. **Test on actual phone** via the Cloudflare Tunnel URL.

**Deliverable**: Mobile-friendly single-session view accessible from phone.

## Open questions

1. **Domain choice**: Which domain will be used? Does the team already have one on Cloudflare, or does a new one need to be purchased/transferred?

2. **Who should have access?** Just one person (email OTP for a single address), or a small team? This affects the Access policy configuration.

3. **WebSocket idle behavior on mobile**: When the phone screen turns off, the WebSocket will eventually drop. Should the mobile view show a "reconnecting..." overlay, or should it fall back to a polling-based status view (no terminal, just session states)?

4. **Read-only vs. interactive on mobile**: Should the mobile terminal allow input by default, or should it be read-only with an explicit "interact" toggle? Accidental terminal input from phone keyboards could be disruptive.

5. **Cloudflare plan level**: The free plan supports everything needed. However, if the team wants audit logs for Access events, that requires the Teams Standard plan ($7/user/month). Is audit logging needed?

6. **Fallback when Cloudflare is down**: Should the SSH tunnel approach remain documented as a fallback, or should it be fully deprecated? Keeping both means two access methods to maintain.

7. **Terminal output bandwidth**: Cloudflare Tunnel has no explicit bandwidth limit, but rapid terminal output (e.g., a build log scrolling at high speed) over a mobile connection could be laggy. Should the mobile view cap the terminal scroll rate or buffer output?

8. **Multiple hostnames**: Should there be a separate hostname for an API-only endpoint (e.g., `orcha-api.yourdomain.com`) that mobile push notifications or a future mobile app could use, or is a single hostname sufficient?

---

## Self-score
- Clarity: 5/5
- Feasibility: 4/5
- Impact: 5/5
- Flexibility: 4/5
- Risk (inverse): 4/5
**Total: 22/25**
