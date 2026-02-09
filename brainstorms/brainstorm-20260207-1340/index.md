# Brainstorm Results: Mobile Support for Orcha Dashboard

**GitHub Issue**: [#11 - Add some way of mobile support](https://github.com/esbenwiberg/orcha/issues/11)
**Generated**: 2026-02-07 13:40 UTC
**Updated**: 2026-02-07 (added suggestion 06 after user feedback)
**Suggestions**: 6

---

## Ranked Results

| Rank | ID | Title | Self | Adj. | Direction |
|------|----|-------|------|------|-----------|
| **1** | **06** | [**Entra ID OIDC + Caddy + Mobile PWA**](06_suggestion.md) | 21/25 | **23/25** | **Azure-native auth + expose server** |
| 2 | 02 | [Tailscale Mesh VPN](02_suggestion.md) | 22/25 | 20/25 | Private mesh VPN |
| 3 | 04 | [Cloudflare Tunnel + Zero Trust](04_suggestion.md) | 22/25 | 19/25 | Cloudflare reverse proxy |
| 4 | 03 | [Dedicated Mobile PWA Route](03_suggestion.md) | 22/25 | 18/25 | Frontend-only (no networking) |
| 5 | 01 | [SSH Tunnel + Mobile Route](01_suggestion.md) | 20/25 | 17/25 | SSH from phone |
| 6 | 05 | [Telegram Bot](05_suggestion.md) | 20/25 | 16/25 | Chat bot interface |

### Scoring Legend
- **Self**: Subagent's self-assessment
- **Adj.**: Coordinator's adjusted score after user feedback and cross-comparison

---

## Why 06 Wins

After reviewing the initial 5 suggestions, the user identified the key insight the brainstorm missed:

> "The VM is already in Azure. Just expose the Express server with auth on top."

This is correct. Suggestions 01-05 all danced around the networking problem with varying levels of indirection (SSH tunnels, VPNs, Cloudflare proxies, Telegram bots). Suggestion 06 takes the direct approach:

1. **Caddy** in front for automatic TLS (4-line config)
2. **Microsoft Entra ID OIDC** for authentication (already have it -- it's Azure)
3. **"Assignment required" = Yes** to lock it down to one user (zero code, Azure portal toggle)
4. **Mobile PWA** for the phone UX (builds on suggestion 03's design)

No third-party services. No VPN apps on the phone. No SSH apps. Just open `https://orcha.yourdomain.com/mobile` in your phone browser.

---

## Scoring Adjustments (Round 2)

### 06 - Entra ID + Caddy + Mobile PWA (21 -> 23/25, +1 Impact, +1 Feasibility)
The self-score of 3/5 on Risk was overly cautious. Entra ID is battle-tested enterprise auth, Caddy is mature, and the "assignment required" lockdown is foolproof. The self-score of 4/5 on Feasibility undersells the `express-openid-connect` library which genuinely is a one-liner middleware setup. This is the most complete suggestion: it solves networking, auth, AND mobile UX in one coherent package using infrastructure the user already has.

### 02 - Tailscale (22 -> 20/25, -1 Impact, -1 Flexibility)
Requires installing the Tailscale app on the phone, which is friction. Still needs a mobile view to be built separately. Adds a third-party dependency (Tailscale) when Azure already provides everything needed. Good fallback if you specifically don't want a public URL.

### 04 - Cloudflare Tunnel (22 -> 19/25, -1 Impact, -1 Feasibility, -1 Flexibility)
Same pattern as 06 (reverse proxy + auth + mobile view) but uses Cloudflare instead of Azure-native tools. Why add Cloudflare when you're already in Azure? The WebSocket idle timeout (100s) is a genuine engineering burden. Domain must be on Cloudflare DNS specifically.

### 03 - Mobile PWA (22 -> 18/25, -2 Impact)
Great UX design but doesn't solve how the phone reaches the server. Now superseded by 06 which incorporates the PWA design AND solves networking/auth.

### 01 - SSH Tunnel (20 -> 17/25, -2 Impact, -1 Flexibility)
SSH from a phone with port forwarding is too cumbersome for the "quick check while away from laptop" use case.

### 05 - Telegram Bot (20 -> 16/25, -2 Impact, -2 Flexibility)
Creative but doesn't deliver a real dashboard. The push notification concept lives on in 06's browser Notifications API.

---

## Deduplication Analysis

- **06** supersedes **03** (incorporates the mobile PWA design as Phase 3)
- **06** supersedes **04** (same pattern -- reverse proxy + auth -- but using Azure-native tools)
- **01**, **02**, **05** remain as distinct alternatives for different constraints

---

## Recommended Path Forward

**Implement suggestion 06** as-is. The two-day timeline is realistic:

- **Day 1**: Caddy + DNS + Entra ID app registration + OIDC middleware + WebSocket auth
- **Day 2**: Mobile PWA (session cards, capture API, swipe nav, notifications, "Add to Home Screen")

### Prerequisites to confirm
1. Do you have a domain name (or willing to register one)?
2. Do you have Azure AD admin access to create App Registrations?
3. Is the VM's public IP static?

---

## Next Steps

1. **Confirm prerequisites** above
2. **Use `/brainstorm-refine 06`** if any aspect needs deeper exploration
3. **Start implementation** following the Day 1 / Day 2 plan in the suggestion
