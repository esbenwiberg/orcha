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

## Prompt Templates

### Loading Precedence

Templates are loaded in this order:
1. **Custom overrides**: `~/.orcha/prompts/custom/<template>.yaml`
2. **Default templates**: `~/.orcha/prompts/defaults/<template>.yaml`
3. **Hardcoded fallback**: Built-in prompts (if no files found)

### File Paths

- Package templates (distributed via npm): `prompts/defaults/`
- User defaults (installed to): `~/.orcha/prompts/defaults/`
- User customizations: `~/.orcha/prompts/custom/`

### Template CLI

- `orcha prompts list` - Show all available templates
- `orcha prompts show <name>` - View template content
- `orcha prompts edit <name>` - Customize a template
- `orcha prompts reset <name>` - Revert to default
- `orcha prompts export` - Export custom templates
- `orcha prompts import <file>` - Import templates from tarball
