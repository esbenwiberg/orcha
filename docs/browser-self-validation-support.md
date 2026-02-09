# Blueprint: Browser-Powered Agent Self-Validation

## Goal

Give Orcha pipeline agents (and interactive sessions) the ability to launch a headless browser, navigate the running app, click around, fill forms, take screenshots, and visually validate their implementation — all autonomously on a headless Linux VM.

## Non-Goals

- GUI browser or display server (no X11/Wayland)
- Full E2E test framework integration (Cypress, Playwright Test runner)
- Browser testing for non-web projects
- Recording/replaying test scripts
- Replacing existing gate agents — this is additive

## Acceptance Criteria

- [ ] Playwright MCP server is auto-configured for pipeline agent sessions so they get browser tools
- [ ] Interactive Orcha sessions (tmux) also get browser tools when MCP is installed
- [ ] Agents can: navigate to a URL, click elements, type into inputs, take screenshots
- [ ] Screenshots are saved to a known path and viewable by the agent (multimodal Read)
- [ ] A new `visual-validator` gate agent uses the browser to validate web UI changes
- [ ] The gate agent starts the app (if needed), navigates key routes, screenshots, and produces pass/fail
- [ ] Works fully headless on Linux (no display required)
- [ ] Opt-in: only enabled when the project has a `startCommand` or web UI config
- [ ] Chromium is installed once, not re-downloaded per session

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Pipeline / Interactive Session                      │
│                                                      │
│  Claude CLI                                          │
│    ├── Standard tools (Read, Write, Bash, etc.)     │
│    └── MCP: @playwright/mcp (headless chromium)     │
│           ├── browser_navigate(url)                  │
│           ├── browser_click(selector/text)           │
│           ├── browser_type(selector, text)           │
│           ├── browser_screenshot()                   │
│           ├── browser_snapshot() ← accessibility     │
│           └── browser_evaluate(js)                   │
│                                                      │
│  Gate Stage                                          │
│    ├── test-runner      (existing)                   │
│    ├── lint-runner       (existing)                  │
│    ├── ac-validator      (existing)                  │
│    ├── adversary         (existing)                  │
│    ├── security          (existing)                  │
│    ├── code-review       (existing)                  │
│    └── visual-validator  (NEW - uses Playwright MCP) │
└─────────────────────────────────────────────────────┘
```

### Data Flow

1. **Stage runner** spawns `claude` CLI with `--mcp-config` pointing to a generated config that includes `@playwright/mcp`
2. Agent gets browser tools alongside standard tools
3. Agent navigates to `http://localhost:{port}`, interacts, screenshots
4. Screenshots saved to `~/.orcha/pipelines/{id}/screenshots/`
5. Visual-validator gate agent: starts app → browses → screenshots → produces verdict JSON

### Key Interface: MCP Config Injection

The stage runner (`spawnClaude`) needs to pass an MCP config file so the spawned Claude session gets Playwright tools. This is done via `--mcp-config /path/to/mcp.json`.

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": [
        "@playwright/mcp@latest",
        "--headless",
        "--viewport-size", "1280x720"
      ]
    }
  }
}
```

## File Layout

```
src/pipeline/
  browser-config.ts          # Generate MCP config for Playwright, manage chromium
  gate-agents/
    visual-validator.ts      # New gate agent: browser-based visual validation
  stage-runner.ts            # Modified: accept mcpConfigPath option
  stages/gate.ts             # Modified: add visual-validator to parallel checks

scripts/
  install-playwright.sh      # One-time Chromium install helper

src/core/
  hook-installer.ts          # Modified: optionally add playwright MCP to global settings
```

## Milestones

### M1: Install Playwright & Generate MCP Config

**Intent:** Get Playwright Chromium installed and create a reusable MCP config generator.

**Key files:**
- `scripts/install-playwright.sh` (new)
- `src/pipeline/browser-config.ts` (new)

**Details:**
- `install-playwright.sh`: runs `npx playwright install chromium` + system deps
- `browser-config.ts`: exports `generatePlaywrightMcpConfig(outputDir)` → writes `mcp.json` to a temp location, returns the path
- Config includes `--headless`, `--viewport-size 1280x720`, `--timeout-action 5000`

**Verification:**
```bash
bash scripts/install-playwright.sh
npx @playwright/mcp --headless --help  # confirms it works
npx tsc --noEmit  # type-checks
```

### M2: Wire MCP Config into Stage Runner

**Intent:** Allow pipeline stages to spawn Claude sessions that have Playwright browser tools.

**Key files:**
- `src/pipeline/stage-runner.ts` (modify)
- `src/pipeline/browser-config.ts` (use)

**Details:**
- Add optional `mcpConfigPath?: string` to `StageRunnerOptions`
- In `buildCliArgs`, if `mcpConfigPath` is set, add `--mcp-config {path}` to args
- No stages use it yet — this just makes it available

**Verification:**
```bash
npx tsc --noEmit
# Manual: run a pipeline stage with mcpConfigPath set, verify claude sees browser tools in init event
```

### M3: Visual Validator Gate Agent

**Intent:** Create a new gate agent that uses the browser to visually validate web UI changes.

**Key files:**
- `src/pipeline/gate-agents/visual-validator.ts` (new)
- `src/pipeline/stages/gate.ts` (modify)
- `src/pipeline/types.ts` (modify — add `startCommand` to PipelineConfig)

**Details:**
- `visual-validator.ts` follows the pattern of `ac-validator.ts`:
  - Checks if `run.config.startCommand` is set (e.g. `npm run dev`); if not → skip
  - Starts the app in background (via Bash), waits for port
  - Generates Playwright MCP config, passes `mcpConfigPath` to `runStage`
  - System prompt instructs Claude to: navigate to the app, take screenshots, click through key flows, compare against acceptance criteria, produce structured verdict
  - Kills the app process on completion
  - `allowedTools`: all tools (needs Bash to start app + browser MCP tools)
- `gate.ts`: add `visual-validator` to the parallel Promise.all
- `types.ts`: add optional `startCommand?: string` and `appPort?: number` to PipelineConfig
- Agent produces same `GateResult` shape (pass/fail/skip)

**Verification:**
```bash
npx tsc --noEmit
# Manual: run a pipeline with startCommand set, verify visual-validator runs and produces verdict
```

### M4: Interactive Session Browser Support

**Intent:** Let interactive Orcha sessions (tmux-based) also use browser tools.

**Key files:**
- `src/core/hook-installer.ts` (modify)
- `src/core/session-manager.ts` (modify, if needed)

**Details:**
- In `hook-installer.ts`, add Playwright MCP server to `~/.claude/settings.json` under `mcpServers` (similar to how hooks are injected)
- Only install if Playwright/Chromium is available on the system (check `npx @playwright/mcp --version`)
- This gives every Claude Code session browser tools automatically

**Verification:**
```bash
# Start an interactive orcha session, check that browser_ tools appear
orcha start --sessions 1
# In the session: ask Claude to navigate to a URL and screenshot
```

## Risks & Probes

| Risk | Impact | Quick Probe | Status |
|------|--------|-------------|--------|
| Chromium won't install on this VM | Blocks everything | `npx playwright install --with-deps chromium` | **PASSED** |
| `--mcp-config` flag missing from Claude CLI | Blocks M2 | `claude --help \| grep mcp` | **PASSED** |
| Playwright MCP + `--dangerously-skip-permissions` | Blocks pipeline use | Spawn test session, verify tools | **PASSED** |
| App startup time may exceed agent timeout | Visual validator times out | Make startup wait configurable, default 30s | Open |
| Screenshots too large for Claude context | Agent can't see them | Playwright MCP returns accessibility snapshots by default | Open |
| Concurrent browser sessions in competing mode | Resource contention | Each agent gets own Chromium instance | Open |

### Critical Probe Results (2026-02-09)

All three blockers resolved — **full green light to build**.

#### Probe 1: Chromium Install — PASSED

```
Chrome for Testing 145.0.7632.6 (playwright chromium v1208)
  → ~/.cache/ms-playwright/chromium-1208
Chrome Headless Shell 145.0.7632.6
  → ~/.cache/ms-playwright/chromium_headless_shell-1208
FFmpeg (playwright ffmpeg v1011)
  → ~/.cache/ms-playwright/ffmpeg-1011
```

System deps auto-installed via `--with-deps`. Total download ~280 MiB.
Installed once at `~/.cache/ms-playwright/` — shared across all sessions.

#### Probe 2: Claude CLI `--mcp-config` — PASSED

```
--mcp-config <configs...>    Load MCP servers from JSON files or strings (space-separated)
--strict-mcp-config          Only use MCP servers from --mcp-config, ignoring all other MCP configurations
--mcp-debug                  [DEPRECATED. Use --debug instead]
```

Accepts file paths or inline JSON strings. `--strict-mcp-config` is useful for pipeline agents
to ensure they only get the Playwright MCP (no interference from user's global MCP config).

#### Probe 3: Playwright MCP Headless + Full E2E — PASSED

Spawned `claude -p` with `--mcp-config /tmp/playwright-mcp.json --dangerously-skip-permissions`.

**22 browser tools detected:**
```
mcp__playwright__browser_navigate       mcp__playwright__browser_click
mcp__playwright__browser_type           mcp__playwright__browser_fill_form
mcp__playwright__browser_take_screenshot mcp__playwright__browser_snapshot
mcp__playwright__browser_evaluate       mcp__playwright__browser_run_code
mcp__playwright__browser_press_key      mcp__playwright__browser_hover
mcp__playwright__browser_drag           mcp__playwright__browser_select_option
mcp__playwright__browser_file_upload    mcp__playwright__browser_wait_for
mcp__playwright__browser_tabs           mcp__playwright__browser_resize
mcp__playwright__browser_close          mcp__playwright__browser_navigate_back
mcp__playwright__browser_console_messages mcp__playwright__browser_network_requests
mcp__playwright__browser_handle_dialog  mcp__playwright__browser_install
```

**End-to-end test:** Agent navigated to `https://example.com`, took a 1280x720 PNG screenshot (18 KiB),
saved to disk. Screenshot confirmed valid via `file` command and multimodal Read.

**MCP config used for the test:**
```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest", "--headless", "--viewport-size", "1280x720"]
    }
  }
}
```

### Design Notes from Probes

1. **`--strict-mcp-config`** — Use this for pipeline agents to prevent global MCP servers from leaking in
2. **Tool name prefix** — All tools are `mcp__playwright__browser_*`, so `--allowedTools` in stage-runner
   needs to include these (or omit the restriction for visual-validator)
3. **Chromium shared cache** — `~/.cache/ms-playwright/` is shared across all users/sessions on the VM,
   so `install-playwright.sh` only needs to run once per machine
4. **No X11 needed** — `--headless` flag confirmed working without any display server

---

Next: `/probe 'M1 — Install Playwright & generate MCP config'`
