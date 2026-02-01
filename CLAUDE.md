# Orcha - Project Guidelines

## User Paths

- Screenshots: `/mnt/c/screenshots/` (organized by month, e.g., `2026-01/`)
- Downloads: `/mnt/c/Users/ewi/Downloads/`

## Build & Static Files

**IMPORTANT:** When editing web dashboard files in `src/web/public/`, you MUST also copy them to `dist/web/public/`. The server serves from `dist/` first.

```bash
# After editing any file in src/web/public/:
cp src/web/public/<file> dist/web/public/
```

Files to sync: `index.html`, `style.css`, `app.js`, `logo.png`, `favicon.png`

## Project Structure

- `src/core/` - Core orchestration logic
- `src/web/` - Web dashboard (Express + WebSocket server)
- `src/web/public/` - Static frontend files (HTML, CSS, JS)
- `dist/` - Compiled TypeScript output (server runs from here)
- `bin/` - CLI entry points

## Tech Stack

- TypeScript + Node.js
- Express + WebSocket for web dashboard
- xterm.js for terminal rendering
- tmux for session management
