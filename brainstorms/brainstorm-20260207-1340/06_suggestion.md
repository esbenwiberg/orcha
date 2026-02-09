# Entra ID OIDC + Caddy Reverse Proxy + Mobile PWA View

## Summary
Expose the Orcha Express server to the internet through a Caddy reverse proxy (automatic TLS via Let's Encrypt) on port 443, protected by Microsoft Entra ID (Azure AD) OIDC authentication added directly to the Express middleware layer. The Entra ID App Registration is configured with "Assignment required? = Yes" so that only the explicitly assigned user can authenticate, blocking all other tenant members. On top of this secure foundation, build a purpose-built `/mobile` PWA route with session card view, tmux capture-pane API, swipe navigation, and browser notifications -- giving the user a native-feeling mobile dashboard accessible from any phone browser by simply navigating to `https://orcha.yourdomain.com/mobile`.

## When to use
- When the VM is already in Azure and you want to leverage the platform's identity services rather than adding third-party infrastructure (Tailscale, Cloudflare).
- When the user is the sole operator of the dashboard and wants to restrict access to their Microsoft account only, not the entire Azure AD tenant.
- When the primary mobile use case is monitoring (checking session states, reading recent output, creating sessions, receiving alerts) rather than full terminal interaction.
- When you want automatic HTTPS with zero certificate management and no DNS-provider API tokens.
- When the SSH tunnel workflow is acceptable for desktop (it continues to work unchanged) but too cumbersome for mobile.

## How it works

### Phase 1: Caddy Reverse Proxy with Automatic TLS

**What Caddy does**: Caddy is a production-grade reverse proxy that obtains and renews TLS certificates from Let's Encrypt automatically. No certbot cron jobs, no manual renewal. It listens on port 443 and proxies to the Express server on localhost:3847.

**Prerequisites**:
- A domain name (e.g., `orcha.yourdomain.com`) with a DNS A record pointing to the Azure VM's public IP.
- Azure NSG (Network Security Group) rule allowing inbound TCP port 443 from the internet. Port 80 should also be opened for Let's Encrypt HTTP-01 challenge validation.
- The Express server continues to bind to localhost:3847 (no binding changes needed).

**Installation** (Ubuntu/Debian on Azure VM):
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install caddy
```

**Caddyfile** (`/etc/caddy/Caddyfile`):
```caddyfile
orcha.yourdomain.com {
    reverse_proxy localhost:3847

    # WebSocket support is automatic in Caddy - no special config needed.
    # Caddy detects the Upgrade header and handles WebSocket proxying natively.

    # Optional: increase timeouts for long-lived WebSocket connections
    reverse_proxy localhost:3847 {
        transport http {
            read_timeout 0
        }
    }
}
```

> Note: Caddy's WebSocket support is automatic. When the client sends `Connection: Upgrade` and `Upgrade: websocket` headers, Caddy proxies the connection without any additional directives. The `read_timeout 0` disables read timeout for long-lived terminal WebSocket connections.

**Start Caddy**:
```bash
sudo systemctl enable caddy
sudo systemctl start caddy
# Verify: sudo systemctl status caddy
# Logs: sudo journalctl -u caddy -f
```

Caddy will automatically obtain a TLS certificate for `orcha.yourdomain.com` from Let's Encrypt and renew it before expiration.

### Phase 2: Microsoft Entra ID OIDC Authentication

**2a. Azure Portal: App Registration**

1. Go to [Azure Portal](https://portal.azure.com) > **Microsoft Entra ID** > **App registrations** > **New registration**.
2. Name: `Orcha Dashboard` (or any name).
3. Supported account types: **Accounts in this organizational directory only** (Single tenant).
4. Redirect URI: **Web** platform, value: `https://orcha.yourdomain.com/auth/callback`.
5. Click **Register**.
6. Note the **Application (client) ID** and **Directory (tenant) ID** from the Overview page.
7. Go to **Certificates & secrets** > **New client secret**. Description: `orcha-web`. Expiry: 24 months. Copy the **Value** immediately (it won't be shown again).
8. Go to **Authentication**:
   - Verify the redirect URI is correct.
   - Under "Implicit grant and hybrid flows", leave both checkboxes **unchecked** (we use authorization code flow, not implicit).
   - Front-channel logout URL: `https://orcha.yourdomain.com/auth/logout`.
9. Go to **API permissions**: The default `User.Read` (Microsoft Graph) permission is sufficient. No additional permissions needed.

**2b. Azure Portal: Enterprise Application - Restrict to Single User**

1. Go to **Microsoft Entra ID** > **Enterprise applications**.
2. Find the `Orcha Dashboard` app (search by name or client ID).
3. Go to **Properties**.
4. Set **"Assignment required?"** to **Yes**. Click **Save**.
5. Go to **Users and groups** > **Add user/group**.
6. Search for your own user account, select it, and assign it.

This is the critical security step. With "Assignment required?" set to Yes, *only* users explicitly assigned in step 5 can authenticate. All other users in the Azure AD tenant will receive an `AADSTS50105` error ("The signed in user is not assigned to a role for the application") when they try to log in.

**2c. Express Server: OIDC Middleware**

**Package**: Use `express-openid-connect` (maintained by Auth0/Okta, works with any OIDC provider including Entra ID). This is simpler than `passport-azure-ad` and handles session management, token refresh, and middleware in a single package.

```bash
npm install express-openid-connect
```

**Implementation in `server.ts`**:

```typescript
import { auth, requiresAuth } from 'express-openid-connect'

// In the WebDashboardServer constructor or setupRoutes():

// OIDC Configuration - read from environment variables
const oidcConfig = {
  authRequired: false,  // Don't require auth globally (allows health checks, etc.)
  auth0Logout: false,   // We're using Entra ID, not Auth0
  issuerBaseURL: `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/v2.0`,
  baseURL: process.env.ORCHA_BASE_URL || 'https://orcha.yourdomain.com',
  clientID: process.env.AZURE_CLIENT_ID,
  clientSecret: process.env.AZURE_CLIENT_SECRET,
  secret: process.env.SESSION_SECRET || require('crypto').randomBytes(32).toString('hex'),
  routes: {
    login: '/auth/login',
    logout: '/auth/logout',
    callback: '/auth/callback',
  },
  session: {
    rollingDuration: 86400,   // 24 hours rolling session
    absoluteDuration: 604800, // 7 day absolute max
  },
  authorizationParams: {
    response_type: 'code',
    scope: 'openid profile email',
  },
}

// Apply OIDC middleware BEFORE routes
this.app.use(auth(oidcConfig))

// Protect all API and page routes (but not the auth callback itself)
this.app.use('/api/*', requiresAuth())
this.app.use('/mobile*', requiresAuth())

// The root page (index.html) also needs protection
this.app.get('/', requiresAuth(), (req, res, next) => next())

// Health check endpoint remains public (for Azure monitoring / uptime checks)
// Note: /api/health is already defined above but we move it BEFORE the auth middleware,
// or we add a specific exclusion.
```

**Environment variables** (set in the systemd service file or `.env`):
```bash
AZURE_TENANT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
AZURE_CLIENT_SECRET=your-client-secret-value
SESSION_SECRET=a-random-64-char-hex-string
ORCHA_BASE_URL=https://orcha.yourdomain.com
```

**Session storage**: `express-openid-connect` uses an encrypted cookie by default (no server-side session store needed). The `secret` env var is used as the encryption key. This is ideal for a single-server deployment -- no Redis or database dependency.

**2d. WebSocket Authentication**

The `ws` library receives the initial HTTP upgrade request, which includes cookies. Since `express-openid-connect` uses cookies for session state, we can validate the session on WebSocket upgrade.

```typescript
// In setupWebSocket(), modify the connection handler:
private setupWebSocket(): void {
  this.wss.on('connection', async (ws, req) => {
    // Validate session cookie on WebSocket upgrade
    // The auth middleware has already parsed cookies on the HTTP upgrade request.
    // We need to check if the request is authenticated.
    if (!(req as any).oidc?.isAuthenticated()) {
      // For WebSocket, we can't redirect. Instead, parse the session cookie manually.
      // Alternative: use the verifySession approach
      ws.close(1008, 'Unauthorized')
      return
    }
    // ... rest of existing WebSocket handler
  })
}
```

**Better approach for WS auth**: Since `express-openid-connect` middleware runs on Express routes (not raw WebSocket upgrades), the most reliable pattern is to intercept the HTTP upgrade event *before* handing off to `ws`:

```typescript
// In the constructor, replace the simple WSS setup:
this.wss = new WebSocketServer({ noServer: true })

this.server.on('upgrade', (request, socket, head) => {
  // Run Express middleware chain to validate session
  // Parse cookies from the upgrade request
  const sessionCookie = parseCookie(request.headers.cookie || '')['appSession']
  if (!sessionCookie) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
    return
  }

  // Decrypt and validate the session cookie
  // express-openid-connect stores an encrypted JWT in the appSession cookie
  // We verify it using the SESSION_SECRET
  try {
    // The simplest approach: use a shared session validation function
    // that decrypts the cookie using the same secret
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.wss.emit('connection', ws, request)
    })
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
    socket.destroy()
  }
})
```

**Pragmatic WS auth alternative**: Since the Express server only listens on localhost:3847 and Caddy proxies both HTTP and WebSocket traffic through the same authenticated session, the browser's WebSocket connection to `wss://orcha.yourdomain.com/ws?session=...` is automatically sent with the same cookies. The `express-openid-connect` middleware validates the cookie on the initial HTTP upgrade request because Caddy forwards it as-is. This means the authentication check happens at the Caddy+Express layer before the WebSocket handshake completes.

The most practical implementation: use `noServer` mode and validate the cookie in the `upgrade` handler by running the request through Express's middleware stack:

```typescript
this.server.on('upgrade', (req, socket, head) => {
  // Create a minimal Express response to run middleware
  const res = new http.ServerResponse(req)
  this.app.handle(req, res, () => {
    // If we reach here, middleware (including auth) passed
    if (!(req as any).oidc?.isAuthenticated()) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req)
    })
  })
})
```

### Phase 3: Mobile PWA View

Builds on suggestion 03's design, now with HTTPS (required for full PWA features) and no SSH tunnel friction.

**3a. New Files in `src/web/public/`**:

| File | Purpose |
|------|---------|
| `mobile.html` | Mobile PWA shell (viewport meta, dark theme, manifest link) |
| `mobile.css` | Mobile-specific styles (card layout, swipe, bottom nav) |
| `mobile.js` | Mobile app logic (session cards, capture polling, notifications) |
| `manifest.json` | PWA manifest (name, icons, start_url: /mobile, display: standalone) |
| `sw.js` | Service worker for offline caching of app shell |

**3b. New API Endpoint: `/api/sessions/:instanceId/:sessionId/capture`**

Added to `server.ts`:

```typescript
// API: Capture terminal pane content (lightweight alternative to WebSocket PTY)
this.app.get('/api/sessions/:instanceId/:sessionId/capture', requiresAuth(), async (req, res) => {
  try {
    const { instanceId, sessionId } = req.params
    const lines = parseInt(req.query.lines as string) || 50

    // Look up session metadata to find tmux session name
    const metadata = await loadSessionStore(instanceId)
    const session = metadata.find(m => m.id === sessionId)

    if (!session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }

    const tmuxTarget = session.tmuxSession || `orcha-ui-${sessionId}`
    const paneTarget = `${tmuxTarget}:0.${session.paneIndex || 0}`

    // Capture pane content (non-blocking, ~5ms execution time)
    const { spawnSync } = await import('child_process')
    const result = spawnSync('tmux', [
      'capture-pane', '-t', paneTarget, '-p', '-S', `-${lines}`
    ], {
      encoding: 'utf-8',
      timeout: 5000,
    })

    if (result.status !== 0) {
      res.status(500).json({ error: 'Failed to capture pane content' })
      return
    }

    res.json({
      content: result.stdout,
      lines,
      timestamp: Date.now(),
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})
```

**3c. Mobile UI Architecture**:

**Session Card View**: The mobile viewport shows one session at a time. Each card contains:
- Top bar: session name/branch, colored status badge (working/waiting/idle/done/error)
- Main area: monospace scrollable output from the capture API (last 50 lines)
- Bottom bar: quick action buttons (create session, refresh, notifications toggle)

**Navigation**:
- Horizontal swipe (using `touchstart`/`touchmove`/`touchend` events with velocity detection) switches between sessions.
- Bottom dot indicators show all sessions, color-coded by state, with the current session highlighted.
- A hamburger menu slides in a full session list from the left for direct selection.
- Pull-down gesture triggers a manual refresh.

**Touch event handling** (simplified):
```javascript
let touchStartX = 0, touchStartTime = 0

card.addEventListener('touchstart', (e) => {
  touchStartX = e.touches[0].clientX
  touchStartTime = Date.now()
})

card.addEventListener('touchend', (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX
  const dt = Date.now() - touchStartTime
  const velocity = Math.abs(dx) / dt

  if (Math.abs(dx) > 50 && velocity > 0.3) {
    if (dx > 0) navigateToPreviousSession()
    else navigateToNextSession()
  }
})
```

**CSS approach**: Use `touch-action: pan-y` on the card container to prevent browser back/forward swipe gestures while allowing vertical scrolling.

**3d. Browser Notifications**:

With HTTPS (via Caddy), the Notifications API is fully available. The mobile client polls `/api/status` every 10 seconds, diffs session states against the previous response, and fires notifications for meaningful transitions:

```javascript
// Only notify on these transitions (avoid noise)
const notifyTransitions = {
  'working->waiting': 'Session #{id} needs input',
  'working->done': 'Session #{id} completed',
  'working->error': 'Session #{id} hit an error',
  '*->error': 'Session #{id} errored',
}
```

The Notifications API works even when the PWA is in the background (standalone mode), but not when fully closed. True Web Push could be added later with a VAPID key server-side endpoint, but the polling approach is sufficient for a single-user tool.

**3e. PWA Manifest** (`manifest.json`):
```json
{
  "name": "Orcha Mobile",
  "short_name": "Orcha",
  "start_url": "/mobile",
  "display": "standalone",
  "background_color": "#0d0d0d",
  "theme_color": "#9b59b6",
  "icons": [
    { "src": "/favicon.png", "sizes": "192x192", "type": "image/png" },
    { "src": "/logo.png", "sizes": "512x512", "type": "image/png" }
  ]
}
```

**3f. Service Worker** (`sw.js`):
Caches the mobile app shell (HTML, CSS, JS, icons) for instant loading. Uses a network-first strategy for API calls and a cache-first strategy for static assets.

```javascript
const CACHE_NAME = 'orcha-mobile-v1'
const SHELL_URLS = ['/mobile.html', '/mobile.css', '/mobile.js', '/logo.png', '/favicon.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then(c => c.addAll(SHELL_URLS)))
})

self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/')) {
    // Network-first for API calls
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)))
  } else {
    // Cache-first for static assets
    event.respondWith(caches.match(event.request).then(r => r || fetch(event.request)))
  }
})
```

**3g. Auto-detection Banner**:

The existing `index.html` (desktop dashboard) gets a small addition. On page load, `app.js` checks the viewport width and if `< 768px`, displays a non-intrusive banner at the top: "On mobile? [Switch to mobile view](/mobile)". This is a link, not an auto-redirect, so laptop users who happen to have a narrow window are not forced away.

**3h. Session Creation on Mobile**:

A floating "+" FAB (floating action button) opens a bottom sheet form. The form uses the existing `POST /api/sessions` endpoint with a simplified UI:
- Instance selector (dropdown, pre-populated from `/api/instances`)
- Branch name (text input with auto-suggest from existing branches)
- Mode toggle (claude / gemini / shell)
- "Create" button

**3i. Optional Full Terminal Mode**:

Each session card has a "Terminal" button that opens a full-screen xterm.js terminal. This loads xterm.js on demand (not bundled by default) and connects via the existing WebSocket PTY mechanism. The terminal uses a larger font (16px) and the xterm.js `touchScroll` option for mobile-friendly scrolling. This is the escape hatch for users who need to type into a session from their phone.

### Phase 4: Deployment

**Systemd service** for the Orcha web server (`/etc/systemd/system/orcha-web.service`):
```ini
[Unit]
Description=Orcha Web Dashboard
After=network.target

[Service]
Type=simple
User=ewi
WorkingDirectory=/home/ewi/repos/orcha-clones/orcha
ExecStart=/usr/bin/node dist/web/start-server.js
Environment=AZURE_TENANT_ID=xxx
Environment=AZURE_CLIENT_ID=xxx
Environment=AZURE_CLIENT_SECRET=xxx
Environment=SESSION_SECRET=xxx
Environment=ORCHA_BASE_URL=https://orcha.yourdomain.com
Environment=NO_OPEN=1
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Azure NSG changes**:
- Allow inbound TCP 443 from Any (for HTTPS + WebSocket over TLS)
- Allow inbound TCP 80 from Any (for Let's Encrypt HTTP-01 challenge only; Caddy redirects to HTTPS)
- Keep existing SSH (22) rule unchanged
- Port 3847 remains localhost-only, no NSG rule needed

## Key decisions / tradeoffs

1. **Caddy vs. nginx vs. Azure Application Gateway**: Chose Caddy for automatic TLS with zero configuration. nginx requires certbot setup and cron-based renewal. Azure Application Gateway is overkill (and expensive) for a single-user tool. Caddy's Caddyfile is 4 lines.

2. **`express-openid-connect` vs. `passport-azure-ad`**: Chose `express-openid-connect` because it is a single package that handles session management, token refresh, CSRF protection, and middleware in one. `passport-azure-ad` requires additional packages (passport, express-session, connect-flash) and more boilerplate. The express-openid-connect library's `auth()` middleware is literally a one-liner.

3. **"Assignment required" vs. Azure AD role-based access**: Chose user assignment on the Enterprise Application. This is simpler than defining custom app roles and checking role claims in code. The assignment check happens server-side in Azure AD before the token is even issued, making it foolproof.

4. **Encrypted cookie sessions vs. server-side session store**: Chose encrypted cookies (default in `express-openid-connect`). For a single-server, single-user tool, there is no need for Redis or a database. The session data (OIDC tokens) fits in a cookie. Server restarts don't invalidate sessions.

5. **Separate `/mobile` route vs. responsive redesign**: Chose separate route, same reasoning as suggestion 03. The desktop terminal grid with xterm.js and keyboard shortcuts is fundamentally a desktop experience. A responsive redesign would compromise both.

6. **Polling capture API vs. WebSocket for mobile**: Default to polling `tmux capture-pane` every 5 seconds. This is dramatically simpler, uses less bandwidth/battery, and serves the monitoring use case. Full WebSocket terminal is available as an opt-in for the rare case where you need to type from your phone.

7. **Domain requirement**: This solution requires a domain name with a DNS A record. This is the one new prerequisite compared to the SSH tunnel approach. If the user already has a domain (even a cheap `.dev` or `.xyz`), this is trivial. If not, Azure provides free `*.azurewebsites.net` subdomains but those require Azure App Service, not a raw VM. A `nip.io` or `sslip.io` wildcard DNS could work as a stopgap (`1.2.3.4.sslip.io` resolves to `1.2.3.4`), though Let's Encrypt rate-limits these shared domains.

8. **Express server continues to bind to localhost**: No changes to the `server.listen()` call. Caddy proxies to it. This means the SSH tunnel workflow for desktop still works exactly as before (SSH tunnel to localhost:3847, no auth needed). Auth is only enforced when accessing via Caddy on port 443.

## Pros
- **Uses existing Azure infrastructure**: No new services, no third-party dependencies (Tailscale, Cloudflare). Just Caddy (a single binary) and an Azure AD App Registration.
- **Enterprise-grade authentication**: Entra ID OIDC is the same auth used by Microsoft 365, Azure Portal, and thousands of enterprise apps. MFA, conditional access policies, and audit logs come for free.
- **Single-user lockdown**: "Assignment required? = Yes" is an ironclad guarantee that only the assigned user can authenticate, regardless of how many people are in the Azure AD tenant.
- **Zero certificate management**: Caddy handles TLS automatically. No certbot, no cron jobs, no renewal alerts.
- **Desktop workflow unchanged**: SSH tunnel to localhost:3847 continues to work. Auth is only on the Caddy path (port 443). No disruption.
- **Full PWA capabilities**: HTTPS unlocks service workers, Web Push, Add to Home Screen, and the Notifications API -- none of which work reliably over an HTTP SSH tunnel.
- **Simple mobile access**: Open phone browser, navigate to `https://orcha.yourdomain.com/mobile`, authenticate once (cookie persists 7 days), done. No SSH app, no VPN, no special client.
- **WebSocket works through Caddy**: Caddy natively proxies WebSocket connections, so the optional full terminal mode works on mobile.

## Cons
- **Requires a domain name**: You need a domain with an A record pointing to the VM's public IP. This is a one-time setup cost (a `.dev` domain is ~$12/year).
- **VM public IP exposure**: Port 443 is open to the internet. The attack surface is Caddy's TLS termination + Entra ID OIDC. Both are hardened production-grade components, but it's a different posture than localhost-only.
- **Client secret management**: The Azure AD client secret must be stored securely on the VM (environment variable in a systemd service file with 600 permissions). The secret expires (max 24 months) and must be rotated.
- **More moving parts than SSH tunnel**: Caddy process, OIDC middleware, Azure AD app registration, DNS record. Each is simple individually, but the total surface area is larger.
- **Dependency on Azure AD availability**: If `login.microsoftonline.com` is down (rare but not impossible), authentication fails. Existing cookie sessions continue to work during an outage, but new logins are blocked.
- **Two frontends to maintain**: Desktop (`index.html`/`app.js`) and mobile (`mobile.html`/`mobile.js`) are separate codebases. The mobile frontend is simple and read-mostly, so divergence risk is low, but it is still two things.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Let's Encrypt rate limiting** | Low | High (no TLS) | Caddy handles this automatically. Rate limits are generous (50 certs/week per domain). Only a concern if you're recreating the VM frequently. Use Caddy's staging mode for testing. |
| **Azure AD client secret expires** | Certain (24mo max) | High (auth breaks) | Set a calendar reminder for 23 months. The Azure portal shows expiry dates on the Certificates & Secrets page. Consider using a certificate instead of a secret for longer validity (up to 3 years). |
| **WebSocket connections drop on phone sleep** | High | Low | The mobile view uses polling by default, not WebSocket. If the user opens the optional full terminal, the xterm.js reconnection logic can re-establish the WebSocket on wake. The capture API is resilient to disconnections by design. |
| **OIDC redirect loop if misconfigured** | Medium | Medium | Test the redirect URI carefully. Common mistakes: wrong redirect URI in app registration, missing trailing slash, HTTP vs HTTPS mismatch. The `express-openid-connect` library has detailed error logging. |
| **DNS propagation delay** | Low | Low (temporary) | DNS A records typically propagate in minutes with low TTL. Use `dig orcha.yourdomain.com` to verify before starting Caddy. |
| **Caddy fails to obtain certificate** | Low | High | Usually caused by port 80 being blocked (needed for HTTP-01 challenge) or DNS not resolving. Check: `sudo lsof -i :80` and `dig +short orcha.yourdomain.com`. Caddy logs the exact error. |
| **Azure NSG misconfiguration** | Low | High | Use Azure CLI to verify: `az network nsg rule list --nsg-name <name> -g <rg> -o table`. Ensure both 80 and 443 are allowed inbound from Any source. |
| **Cookie size exceeds browser limits** | Very Low | Medium | `express-openid-connect` uses encrypted cookies that can grow with OIDC tokens. If the cookie exceeds 4KB, the library automatically chunks it into multiple cookies. No action needed. |
| **`tmux capture-pane` fails for dead sessions** | Medium | Low | The capture endpoint already returns a 500 error. The mobile UI shows "Session unavailable" with a retry button. Dead tmux sessions should be cleaned up via the existing session deletion flow. |

## Quick start (first 1-2 days)

### Day 1: Infrastructure (Caddy + Entra ID + Auth middleware)

**Morning (2-3 hours):**
1. **DNS setup**: Add an A record for `orcha.yourdomain.com` pointing to the Azure VM's public IP. Verify with `dig`.
2. **Azure NSG**: Add inbound rules for ports 80 and 443 from Any source.
3. **Install Caddy**: Run the apt-based installation commands above. Write the Caddyfile. Start Caddy. Verify TLS is working: `curl -I https://orcha.yourdomain.com` should return the Express index.html (unauthenticated at this point).
4. **Verify WebSocket through Caddy**: Open `https://orcha.yourdomain.com` in a browser and confirm terminal connections work through Caddy's reverse proxy.

**Afternoon (3-4 hours):**
5. **Azure AD App Registration**: Follow the step-by-step in section 2a above. Note the three IDs (tenant, client, secret).
6. **Enterprise Application**: Set "Assignment required?" = Yes, assign yourself (section 2b).
7. **Install `express-openid-connect`**: `npm install express-openid-connect`.
8. **Add OIDC middleware to `server.ts`**: Follow section 2c. Key points:
   - `auth()` middleware before all routes.
   - `requiresAuth()` on `/api/*` and `/mobile*` routes.
   - Leave `/api/health` unprotected if needed for monitoring.
9. **Configure environment variables**: Set `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `SESSION_SECRET`, `ORCHA_BASE_URL` in the systemd service file or a `.env` file.
10. **Build and deploy**: `npm run build`, restart the Orcha web server.
11. **Test the OIDC flow**: Navigate to `https://orcha.yourdomain.com`. You should be redirected to Microsoft login. After authenticating, you should see the dashboard. Test with another Azure AD account to confirm it gets the `AADSTS50105` error.
12. **WebSocket auth**: Implement the `noServer` upgrade handler (section 2d). Verify WebSocket connections work when authenticated and are rejected when not.

**Deliverables**: Orcha dashboard accessible at `https://orcha.yourdomain.com` with Entra ID OIDC authentication, restricted to a single user. Desktop SSH tunnel workflow unchanged.

### Day 2: Mobile PWA View

**Morning (3-4 hours):**
1. **Create `mobile.html`, `mobile.css`, `mobile.js`** in `src/web/public/`.
2. **Implement session card view**: Fetch `/api/status`, render one session at a time with state badge, branch name, instance info, and status message.
3. **Add the `/api/sessions/:instanceId/:sessionId/capture` endpoint** to `server.ts`.
4. **Wire up capture polling**: Active session card fetches capture endpoint every 5 seconds, renders monospace output in a scrollable container.
5. **Implement swipe navigation**: Touch event handlers for horizontal swipe between session cards. Bottom dot indicators.

**Afternoon (3-4 hours):**
6. **Session creation**: FAB button + bottom sheet form using `POST /api/sessions`.
7. **Notifications**: State change detection via `/api/status` polling diff. Fire `Notification` API alerts for meaningful transitions.
8. **PWA manifest + service worker**: Create `manifest.json` and `sw.js`. Test "Add to Home Screen" on phone.
9. **Mobile detection banner**: Add viewport check to `app.js` that shows a banner link to `/mobile` on narrow screens.
10. **Copy all new files to `dist/web/public/`** per project build rules.
11. **Test end-to-end on phone**: Navigate to `https://orcha.yourdomain.com/mobile`, authenticate, verify session cards, capture output, swipe navigation, notifications, session creation.

**Deliverables**: Full mobile PWA at `/mobile` with session cards, capture-based terminal output, swipe navigation, notifications, session creation, and "Add to Home Screen" capability.

## Open questions

1. **Domain availability**: Does the user already have a domain? If not, what is their preferred registrar? A `.dev` domain ($12/year) or `.xyz` ($1/year first year) would work. Alternatively, `sslip.io` can be used immediately for testing (e.g., `40-76-25-142.sslip.io`), though it's not ideal for permanent use.

2. **Azure AD tenant**: Does the user have admin access to the Azure AD tenant (needed to create App Registrations and configure Enterprise Applications)? In some organizations, this requires IT approval.

3. **VM public IP stability**: Is the Azure VM's public IP static or dynamic? If dynamic, the DNS A record will break when the VM restarts. A static public IP costs ~$3.65/month on Azure. Alternatively, use Azure DNS with a dynamic update script.

4. **Client secret rotation strategy**: The Azure AD client secret expires after 24 months maximum. Should we set up a reminder, or automate rotation using Azure Key Vault + a managed identity?

5. **Session deletion from mobile**: Should the mobile view support closing/deleting sessions? This is a destructive action that might be risky from a phone (accidental tap). Could require a confirmation dialog or long-press gesture.

6. **Notification granularity**: Which state transitions should trigger notifications? Proposed: `working->waiting`, `*->done`, `*->error`. Should `idle->working` also notify (session started doing something)?

7. **Multiple users in the future**: The current design is single-user. If the user ever wants to share the dashboard with a colleague, the Enterprise Application assignment model scales trivially (just add another user). But should the UI show who is currently authenticated? (Low priority.)

8. **Offline capture caching**: Should the service worker cache the last-known capture output for each session, so the mobile PWA can show stale data when offline? This would make the PWA useful even without network access (e.g., reviewing the last known state of sessions while on a plane).

---

## Self-score
- Clarity: 5/5
- Feasibility: 4/5
- Impact: 5/5
- Flexibility: 4/5
- Risk (inverse): 3/5
**Total: 21/25**

**Score rationale**:
- **Clarity (5/5)**: Every step is documented with exact commands, exact Azure portal navigation paths, exact code snippets, and exact config file contents. A developer could follow this without additional research.
- **Feasibility (4/5)**: Not 5 because the OIDC integration touches the core server startup path and WebSocket upgrade handler, which requires careful testing. The Azure AD setup has several manual portal steps that could go wrong. Two-day timeline is achievable but tight.
- **Impact (5/5)**: This fully solves the GitHub issue. The user gets secure mobile access to the Orcha dashboard from any phone browser with a purpose-built mobile UI, no SSH tunnel needed, and no third-party infrastructure beyond what Azure already provides.
- **Flexibility (4/5)**: Not 5 because it's tightly coupled to Azure AD (wouldn't work for users without an Azure tenant). However, `express-openid-connect` is OIDC-standard, so switching to Google, Okta, or any other OIDC provider would require only changing the `issuerBaseURL` and app registration.
- **Risk (inverse, 3/5)**: Honest assessment: exposing the server to the internet is a meaningful security posture change. The OIDC client secret is a credential that must be managed. Caddy + TLS adds infrastructure that can fail. WebSocket auth through OIDC cookies requires careful implementation. Each risk is well-mitigated, but the aggregate surface area is non-trivial.
