# Telegram Bot as Mobile Interface for Orcha

## Summary
Instead of exposing the Orcha web dashboard to the internet or building a mobile-responsive version, build a Telegram bot that runs on the Azure VM alongside Orcha and communicates with the existing API over localhost. The bot uses only outbound HTTPS connections to Telegram's API (long polling), so no ports need to be opened on the VM and no authentication layer is required. Users interact through familiar chat commands (`/status`, `/sessions`, `/create`, `/logs`) and receive push notifications when session states change (e.g., a session moves from `working` to `done` or `error`). This turns Telegram into a lightweight, secure, always-available mobile control plane for Orcha.

## When to use
- When the primary mobile use case is monitoring (checking if sessions are still running, seeing errors) rather than interactive terminal use.
- When security is paramount and you do not want to expose any ports or build an auth system.
- When quick setup time matters -- a Telegram bot can be wired up in a day, whereas a full mobile web UI with auth, TLS, and responsive design takes much longer.
- When you want push notifications on your phone without building a native app or setting up a push notification service.
- When the user already uses Telegram (or is willing to install it).

## How it works

### Architecture overview

1. **Telegram Bot Process**: A new Node.js module (`src/telegram/bot.ts`) that runs as a long-lived process on the VM. It can be started alongside the web dashboard or independently via `orcha telegram`.

2. **Local API consumption**: The bot connects to the existing Orcha Express API at `http://localhost:3847` using standard HTTP requests. No API changes are needed for basic functionality.

3. **Telegram Bot API (long polling)**: The bot uses Telegram's Bot API with `getUpdates` long polling. This means the bot only makes *outbound* HTTPS calls to `api.telegram.org` -- no inbound connections, no webhooks, no open ports. The VM firewall can remain fully locked down.

4. **State change polling + notifications**: A background loop polls `/api/status` every 10-15 seconds, compares against a cached state map, and sends Telegram messages when sessions transition states (e.g., `working` -> `done`, `working` -> `error`, `idle` -> `waiting`).

5. **Command handlers**: The bot registers handlers for chat commands that map directly to Orcha API endpoints.

### Command mapping

| Telegram Command | Orcha API | Description |
|---|---|---|
| `/status` | `GET /api/status` | Summary: 3 working, 1 waiting, 2 done |
| `/sessions` | `GET /api/sessions` | List all sessions with state icons |
| `/session <id>` | `GET /api/sessions` + filter | Detail view: branch, state, message, worktree |
| `/create <branch>` | `POST /api/sessions` | Create a new session with optional branch name |
| `/close <id>` | `DELETE /api/sessions/:id/:sid` | Close/delete a session |
| `/health` | `GET /api/health` | VM CPU, memory, uptime |
| `/logs <id>` | WebSocket capture | Last N lines of terminal output (via tmux capture-pane) |
| `/mute` / `/unmute` | Bot-internal | Toggle push notifications |
| `/help` | Bot-internal | Show available commands |

### Authentication model

- The bot is configured with a `TELEGRAM_BOT_TOKEN` (from @BotFather) and an `ALLOWED_CHAT_IDS` list (one or more Telegram user/chat IDs).
- Every incoming update is checked: if `message.chat.id` is not in the allowed list, the bot silently ignores it.
- This provides strong user-level auth without passwords, OAuth, or TLS certificates. Only the specific Telegram user(s) can interact with the bot.

### Notification format

State change messages are compact and scannable on mobile:

```
Session #3 [fix/issue-42]
  idle -> done
  "All tests passing, PR ready"
```

Error notifications are highlighted:

```
!! Session #5 [refactor/auth]
  working -> error
  "Build failed: TypeError in auth.ts:42"
```

### Terminal output access

For the `/logs` command, the bot shells out to `tmux capture-pane -t <session-tmux>:0.0 -p -S -50` to grab the last 50 lines of terminal output. This is sent as a code-formatted Telegram message. This covers the "check what Claude is doing" use case without needing a full terminal renderer.

### Configuration

Stored in `~/.orcha/telegram.json`:

```json
{
  "botToken": "123456:ABC-DEF...",
  "allowedChatIds": [12345678],
  "pollIntervalMs": 10000,
  "notifyOnStates": ["done", "error", "waiting"],
  "orchaApiUrl": "http://localhost:3847"
}
```

### Session creation flow (mobile)

Creating a session from Telegram:

1. User sends `/create` (no args)
2. Bot replies with an inline keyboard showing registered instances
3. User taps an instance
4. Bot asks for branch name (or offers "auto-generate")
5. Bot calls `POST /api/sessions` and reports back the result

Alternatively, power users can do: `/create orcha fix/my-branch` for a one-shot command.

## Key decisions / tradeoffs

1. **Long polling over webhooks**: Webhooks would require an open port and TLS certificate. Long polling is simpler and keeps the VM locked down. Tradeoff: ~1-2 second latency on command responses, which is negligible for this use case.

2. **Polling for state changes instead of event-driven**: The Orcha status monitor uses file-watching internally, but there is no server-sent events or WebSocket push for status changes. The bot polls `/api/status` periodically. Tradeoff: notifications arrive within the poll interval (10-15s) rather than instantly. This is acceptable for "is my session still running?" checks.

3. **No terminal rendering in Telegram**: xterm.js rendering in a chat message is not feasible. We provide raw text output via `tmux capture-pane`. Tradeoff: ANSI colors are stripped, and the output is a static snapshot. Interactive terminal use still requires the web dashboard via SSH tunnel on a laptop.

4. **Telegram dependency**: This approach is coupled to Telegram as a platform. If the user does not use Telegram, this provides zero value. However, Telegram bots are free, the API is stable, and the client app is available on every mobile platform.

5. **Separate process**: The bot runs as its own process rather than being embedded in the Express server. This keeps concerns separate and allows the bot to be restarted independently. It also means the web dashboard is unaffected if the bot crashes.

## Pros
- Zero ports exposed on the VM. No firewall changes, no TLS certificates, no reverse proxy configuration.
- No authentication system to build. Telegram handles identity via chat IDs.
- Push notifications for free. Session state changes appear as phone notifications without building a push notification service.
- Fast to implement. The core bot (status + sessions + notifications) can be built in ~1 day using the `node-telegram-bot-api` package.
- Natural mobile interface. Chat commands are faster to type on a phone keyboard than navigating a web UI. No pinch-zooming, no responsive CSS battles.
- Works on any network. Telegram works over cellular, Wi-Fi, behind corporate firewalls -- anywhere the user can reach Telegram's servers.
- Existing API is sufficient. The bot consumes the same REST endpoints the web dashboard uses. No backend changes needed for v1.
- Graceful degradation. If the bot process dies, the web dashboard is completely unaffected.

## Cons
- No interactive terminal access. Users cannot type into Claude sessions from Telegram. They can only view output snapshots. For interactive use, the SSH tunnel + web dashboard is still required.
- Platform lock-in to Telegram. Users who prefer Signal, WhatsApp, or Slack would need a different bot implementation (though the architecture would be similar).
- Polling introduces latency. State change notifications are delayed by the poll interval (up to 15 seconds). This is usually fine for the monitoring use case.
- New dependency: `node-telegram-bot-api` or similar library. Adds ~200KB to the project.
- Requires BotFather setup. The user must create a Telegram bot and configure the token. This is a one-time setup but adds onboarding friction.
- Long terminal output is awkward in chat. Telegram messages have a 4096 character limit. Very long outputs need to be truncated or sent as files.
- No visual terminal rendering. ANSI escape sequences are stripped, losing color coding and formatting that makes Claude's output readable.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Telegram API rate limits | Low | Medium | Batch state change notifications into a single message. Use conservative poll intervals (10-15s). Telegram allows ~30 messages/second per bot, which is far more than needed. |
| Bot token leaked | Low | High | Store token in `~/.orcha/telegram.json` with 600 permissions. Add to `.gitignore`. Document that the token should never be committed. If leaked, revoke via @BotFather instantly. |
| Telegram service outage | Very Low | Medium | The bot gracefully retries on connection errors. Orcha itself continues working; only mobile visibility is lost temporarily. |
| tmux capture-pane output too large | Medium | Low | Truncate to last 30-50 lines. Offer `/logs <id> full` that sends output as a `.txt` file attachment instead of inline message. |
| User creates sessions too fast from Telegram | Low | Low | Rate-limit the `/create` command to 1 session per 10 seconds. Show confirmation before creation. |
| Bot process crashes | Medium | Low | Run under a process manager (pm2, systemd, or a tmux session with auto-restart). The web dashboard is not affected. |
| Multiple users sending conflicting commands | Low | Medium | Log all commands with chat ID. Optionally support role-based access (admin vs. read-only) in future versions. |

## Quick start (first 1-2 days)

### Day 1: Core bot with status and notifications

1. **Create Telegram bot** (15 min)
   - Talk to @BotFather, create bot, get token
   - Get your Telegram chat ID (send a message, check via `getUpdates`)
   - Create `~/.orcha/telegram.json` config

2. **Scaffold bot module** (2 hr)
   - `npm install node-telegram-bot-api`
   - Create `src/telegram/bot.ts` with long-polling setup
   - Implement chat ID whitelist check
   - Wire up `/status` -> `GET /api/status` (format as chat message)
   - Wire up `/sessions` -> `GET /api/sessions` (list with state icons)
   - Wire up `/health` -> `GET /api/health`

3. **State change notifications** (2 hr)
   - Background poll loop: fetch `/api/status` every 10s
   - Compare against cached state map
   - Send notification messages on state transitions
   - Implement `/mute` and `/unmute` commands

4. **CLI entry point** (30 min)
   - Add `orcha telegram` subcommand to start the bot
   - Add to `bin/orcha.js` command definitions

### Day 2: Session management and logs

5. **Session creation flow** (2 hr)
   - Implement `/create` with inline keyboard for instance selection
   - Handle branch name input (conversation flow or one-shot syntax)
   - Call `POST /api/sessions`

6. **Terminal output** (1.5 hr)
   - Implement `/logs <id>` using `tmux capture-pane`
   - Strip ANSI codes, truncate to 4000 chars
   - Format as Telegram code block (monospace)
   - Handle "session not found" gracefully

7. **Session close** (30 min)
   - Implement `/close <id>` with confirmation prompt
   - Call `DELETE /api/sessions/:instanceId/:sessionId`

8. **Documentation and testing** (1 hr)
   - Add setup instructions to README
   - Manual testing on actual phone
   - Verify notifications work with real session state changes

**Deliverable**: A working Telegram bot that provides full read access to Orcha sessions, can create and close sessions, and sends push notifications on state changes. Total effort: ~10 hours across 2 days.

## Open questions

1. **Should the bot be opt-in or bundled?** Should `node-telegram-bot-api` be an optional/peer dependency to avoid bloating the package for users who do not want Telegram integration?

2. **Multi-user support?** The current design supports multiple allowed chat IDs, but should there be permission levels (e.g., read-only users who can `/status` but not `/create`)?

3. **Should notifications be configurable per-session?** E.g., "notify me when session #3 finishes" vs. global notifications for all state changes.

4. **What about Discord/Slack?** The same architectural pattern (bot on VM, polls local API, uses outbound-only messaging API) works for Discord and Slack. Should the bot be designed with a provider abstraction from the start, or should Telegram be built first and others added later?

5. **Should `/logs` include ANSI-to-HTML conversion?** Telegram supports basic HTML formatting. It might be possible to convert some ANSI colors to Telegram's supported HTML tags (bold, italic, code) for slightly richer output.

6. **Process management**: Should the bot run in the same process as the web server (simpler) or as a separate process (more resilient)? The suggestion above uses a separate process, but embedding it in the Express server would simplify deployment.

7. **What about sending images from Telegram to a session?** Telegram makes it easy to send photos. Could we support pasting a photo in the chat and having it forwarded as context to a Claude session (via the existing `/api/upload-image` endpoint)?

---

## Self-score
- Clarity: 5/5
- Feasibility: 5/5
- Impact: 3/5
- Flexibility: 3/5
- Risk (inverse): 4/5
**Total: 20/25**
