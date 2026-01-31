# Getting Started with Orcha

Orcha is a CLI orchestrator for running multiple AI coding sessions (Claude Code, Gemini, Codex) in parallel with real-time status visibility.

## Prerequisites

- Node.js 20+
- tmux installed (`apt install tmux` or `brew install tmux`)
- Git repository to work with

## Installation

```bash
# Clone and install
cd orcha
npm install
npm run build

# Link globally (optional)
npm link
```

## Quick Start

### 1. Start Sessions

```bash
# Start 3 Claude sessions in your repo
orcha start -n 3 -r ~/myproject

# Start with specific branches
orcha start -n 3 -r ~/myproject -b feature/auth,feature/api,feature/ui

# Use a different AI mode
orcha start -n 2 -r ~/myproject -m gemini
```

### 2. Monitor Status

```bash
# One-time status check
orcha status

# Live dashboard (interactive TUI)
orcha watch
```

### 3. Interact with Sessions

```bash
# Focus on session #2
orcha focus 2

# Send input to a session
orcha send 2 "yes"

# Kill a session
orcha kill 3
```

### 4. Stop Everything

```bash
orcha stop
```

## Commands Reference

| Command | Description |
|---------|-------------|
| `orcha start -n N -r <repo>` | Start N sessions in repo |
| `orcha stop` | Stop all sessions |
| `orcha status` | Show session statuses |
| `orcha watch` | Interactive TUI dashboard |
| `orcha focus <n>` | Focus on session #n in tmux |
| `orcha send <n> "text"` | Send input to session #n |
| `orcha kill <n>` | Kill session #n |
| `orcha cleanup -r <repo>` | Remove orphaned worktrees |

## Presets

Save and reuse session configurations:

```bash
# Save current setup as preset
orcha preset save my-workflow -r ~/myproject -n 4 -b auth,api,ui,tests

# List presets
orcha preset list

# Load preset
orcha preset load my-workflow

# Show preset details
orcha preset show my-workflow

# Delete preset
orcha preset delete my-workflow
```

## MCP Integration

Enable AI agents to report their status back to Orcha:

```bash
# Get config for Claude Desktop
orcha mcp-config

# Start MCP server manually
orcha mcp
```

Add the orcha MCP server to `~/.config/claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "orcha": {
      "command": "orcha-mcp"
    }
  }
}
```

## Demo Mode

Try the dashboard without running real sessions:

```bash
orcha demo
```

## Keyboard Shortcuts (Dashboard)

| Key | Action |
|-----|--------|
| `1-9` | Focus session #N |
| `y/n` | Reply to waiting session |
| `r` | Refresh display |
| `q` | Quit dashboard |

## File Locations

- Presets: `~/.orcha/presets/`
- Worktrees: `~/.orcha/worktrees/{repo-name}/`
- Status files: `/tmp/orcha/agents/`

## Troubleshooting

**"tmux is not installed"**
```bash
# Ubuntu/Debian
sudo apt install tmux

# macOS
brew install tmux
```

**Sessions not showing status**
- Ensure the MCP server is configured in your AI tool
- Check `/tmp/orcha/agents/` for status files

**Orphaned worktrees**
```bash
orcha cleanup -r ~/myproject
```
