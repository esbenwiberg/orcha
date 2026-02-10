<p align="center">
  <img src="src/web/public/logo.png" alt="Orcha Logo" width="200">
</p>

# Orcha

**Parallel AI session orchestrator with real-time status visibility**

Run multiple AI coding agents (Claude Code, Gemini CLI, Codex) simultaneously, each in its own git worktree, with live status monitoring across terminal and web dashboards.

[![GitHub](https://img.shields.io/github/stars/esbenwiberg/orcha?style=social)](https://github.com/esbenwiberg/orcha)
![Status](https://img.shields.io/badge/status-alpha-orange)
![Node.js 20+](https://img.shields.io/badge/node-20%2B-green)
![License MIT](https://img.shields.io/badge/license-MIT-blue)

<!-- Add screenshots here after generating them:
![Web Dashboard](docs/screenshots/web-dashboard.png)
![TUI Dashboard](docs/screenshots/tui-dashboard.png)
-->

## Why Orcha?

When working on complex features, you often need to tackle multiple aspects in parallel—authentication, API endpoints, UI components, tests. Orcha lets you spin up multiple AI coding sessions, each working on a separate branch, while you monitor their progress from a single dashboard.

- **Parallel Execution**: Run 1-12 AI sessions simultaneously
- **Isolated Worktrees**: Each session gets its own git worktree—no merge conflicts
- **Real-time Status**: See which sessions are working, waiting for input, or done
- **Multiple Interfaces**: CLI, TUI dashboard, or web dashboard with interactive terminals
- **MCP Integration**: AI agents can report their status back to Orcha

## Quick Start

### Option 1: NPM (Coming Soon)

```bash
npm install -g @esbenwiberg/orcha

# Start 3 Claude sessions in your project
orcha start -n 3 -r ~/myproject

# Open web dashboard
orcha web
```

> **Note**: NPM package publishing in progress. Use the installer below for now.

### Option 2: One-line installer

```bash
curl -fsSL https://raw.githubusercontent.com/esbenwiberg/orcha/main/install.sh | bash

# Then use orcha
orcha start -n 3 -r ~/myproject
```

### Option 3: From source

```bash
git clone https://github.com/esbenwiberg/orcha.git
cd orcha
npm install && npm run build && npm link
```

## Commands

| Command | Description |
|---------|-------------|
| `orcha start -n N -r <repo>` | Start N sessions in repo |
| `orcha start -n N -b <branches>` | Start sessions on specific branches (comma-separated) |
| `orcha stop` | Stop sessions for current repo |
| `orcha stop --all` | Stop all running instances |
| `orcha status` | Show session statuses |
| `orcha watch` | Interactive TUI dashboard |
| `orcha web` | Web dashboard with terminals |
| `orcha focus <n>` | Focus on session #n in tmux |
| `orcha send <n> "text"` | Send input to session #n |
| `orcha kill <n>` | Kill session #n |
| `orcha add` | Add a new session to running instance |
| `orcha list` | List all running orcha instances |
| `orcha attach [instance]` | Attach to tmux session |
| `orcha cleanup -r <repo>` | Remove orphaned worktrees |

## Dashboards

### Web Dashboard (`orcha web`)

Full-featured web interface with interactive terminals powered by xterm.js:

- Live terminal view for each session
- Click to focus, type to interact
- Session status indicators (working/waiting/idle/error/done)
- Usage statistics from Claude Code
- Responsive grid layout

### TUI Dashboard (`orcha watch`)

Terminal-based dashboard using blessed:

- Keyboard navigation (1-9 to focus sessions)
- Quick replies (y/n) for waiting sessions
- Compact status overview

## Session States

| State | Indicator | Meaning |
|-------|-----------|---------|
| Working | Blue | AI is actively processing |
| Waiting | Yellow | Needs user input (y/n prompt, etc.) |
| Idle | Gray | Ready for instructions |
| Done | Green | Task completed |
| Error | Red | Something went wrong |

## Git Worktree Isolation

By default, Orcha creates a separate git worktree for each session:

```
~/.orcha/worktrees/myproject/
├── session-1-20260201/  → feature/auth branch
├── session-2-20260201/  → feature/api branch
└── session-3-20260201/  → feature/ui branch
```

This means:
- Each AI works on isolated files
- No conflicts between parallel changes
- Easy to review and merge when done

### Branch Options

**Use existing branches:**
```bash
# Work on an existing feature branch
orcha start -n 2 -b feature/authentication

# Work on multiple existing branches
orcha start -n 3 -b feature/auth,feature/api,bugfix/login
```

**Auto-generate new branches:**
```bash
# Orcha creates branches: orcha/session-1-20260203, orcha/session-2-20260203, etc.
orcha start -n 3
```

**Work directly in repo (no worktree):**
```bash
# All sessions work in the same directory
orcha start -n 2 --no-worktree
```

Orcha automatically detects whether a branch exists locally or on origin. If it exists, it checks out that branch in a worktree. If it doesn't exist, it creates a new branch from your default branch (main/master).

## Presets

Save and reuse session configurations:

```bash
# Save current setup
orcha preset save my-workflow -r ~/myproject -n 4 -b auth,api,ui,tests

# List presets
orcha preset list

# Load preset
orcha preset load my-workflow
```

## MCP Integration

Enable AI agents to report their status back to Orcha via the Model Context Protocol:

```bash
# Get config for Claude Desktop
orcha mcp-config

# Add to ~/.config/claude/claude_desktop_config.json
{
  "mcpServers": {
    "orcha": {
      "command": "orcha-mcp"
    }
  }
}
```

## Multi-Instance Support

Run orcha on multiple repositories simultaneously:

```bash
# Terminal 1: Start sessions for project A
cd ~/project-a
orcha start -n 3

# Terminal 2: Start sessions for project B
cd ~/project-b
orcha start -n 2

# List all instances
orcha list

# Output:
# INSTANCE                 REPO                                    SESSIONS  STARTED
# project-a-abc123         /home/user/project-a                    3         5m ago
# project-b-def456         /home/user/project-b                    2         2m ago
```

## Requirements

- **Node.js 20+**
- **tmux** - Terminal multiplexer
  ```bash
  # Ubuntu/Debian
  sudo apt install tmux

  # macOS
  brew install tmux
  ```
- **AI CLI tool** - Claude Code, Gemini CLI, or Codex CLI

## Custom Actions

Create custom action buttons in the web dashboard for frequently-used scripts:

```bash
# Actions are managed via the web UI
orcha web
```

In the sidebar, click **"+ Add Action"** to create:
- **Name**: Short label (e.g., "Check Mail")
- **Icon**: Any emoji (e.g., 📧)
- **Script**: Shell commands to run

**Usage:**
- **Click** action button → Creates new tmux session and runs script
- **Right-click** action button → Edit name, icon, or script
- **Delete** via edit dialog

**Example actions:**
- `📧 Check Mail` → `mail-cli inbox --unread`
- `🐳 Docker Status` → `docker ps -a && docker images`
- `📊 System Info` → `htop`

Actions are stored in `~/.orcha/actions.json` and persist across sessions.

## Customizable Prompts

Orcha uses Handlebars-powered YAML templates for all pipeline phases, allowing you to customize AI behavior for your codebase and workflow.

### Quick Start

```bash
# View all available templates
orcha prompts list

# See a template's content
orcha prompts show architect

# Customize a template
orcha prompts edit architect

# Reset to default
orcha prompts reset architect
```

### Template Types

- **architect** - Designs feature architecture from milestone specs
- **dev** - Implements features with tests and documentation
- **gate/** - Adversarial review, code quality, security checks, test validation
- **fix-loop** - Fixes issues found during gate phase

### Example Customization

Tailor the architect template for your team's standards:

```yaml
systemPrompt: |
  You are a senior architect at {{companyName}}.

  Follow our architecture principles:
  - Microservices with API-first design
  - PostgreSQL for persistent data
  - Redis for caching
  - Event-driven patterns for async work

userPrompt: |
  Design architecture for: {{milestoneName}}

  Requirements:
  {{milestoneDetails}}

  Deliverables:
  1. Component diagram
  2. API contracts
  3. Database schema
  4. Deployment strategy
```

### Sharing Templates

Export and share templates with your team:

```bash
# Export custom templates
orcha prompts export my-templates.tar.gz

# Import on another machine
orcha prompts import my-templates.tar.gz
```

Full documentation: [docs/prompt-templates.md](docs/prompt-templates.md)

## Configuration

Orcha stores data in:

| Location | Purpose |
|----------|---------|
| `~/.orcha/presets/` | Saved preset configurations |
| `~/.orcha/worktrees/` | Git worktrees for sessions |
| `~/.orcha/registry.json` | Running instance registry |
| `~/.orcha/actions.json` | Custom action buttons |
| `~/.orcha/prompts/custom/` | Custom prompt templates |
| `~/.orcha/prompts/defaults/` | Default prompt templates |
| `/tmp/orcha/agents/` | Session status files |

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        orcha CLI                             │
│  start │ stop │ status │ watch │ web │ focus │ send │ kill  │
└────────────────────────────┬────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌─────────────────┐  ┌───────────────┐  ┌─────────────────┐
│  TUI Dashboard  │  │ Web Dashboard │  │   Status Files  │
│    (blessed)    │  │ (Express+WS)  │  │ (/tmp/orcha/)   │
└─────────────────┘  └───────────────┘  └─────────────────┘
                             │
                             ▼
                     ┌───────────────┐
                     │  tmux session │
                     │  (N panes)    │
                     └───────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
    ┌─────────┐         ┌─────────┐         ┌─────────┐
    │ Claude  │         │ Claude  │         │ Claude  │
    │ Session │         │ Session │         │ Session │
    │   #1    │         │   #2    │         │   #3    │
    └─────────┘         └─────────┘         └─────────┘
         │                   │                   │
         ▼                   ▼                   ▼
    ┌─────────┐         ┌─────────┐         ┌─────────┐
    │Worktree │         │Worktree │         │Worktree │
    │feature/a│         │feature/b│         │feature/c│
    └─────────┘         └─────────┘         └─────────┘
```

## AI Mode Support

| Mode | Command | Description |
|------|---------|-------------|
| `claude` | `claude` | Claude Code CLI (default) |
| `gemini` | `gemini` | Google Gemini CLI |
| `codex` | `codex` | OpenAI Codex CLI |
| `shell` | (none) | Plain shell, no AI |

```bash
# Start with Gemini instead of Claude
orcha start -n 2 -r ~/myproject -m gemini
```

## Demo Mode

Try the dashboard without running real sessions:

```bash
orcha demo
```

Creates mock sessions with various states to preview the interface.

## Development

```bash
# Build
npm run build

# Watch mode
npm run dev

# Run tests
npm test

# Lint
npm run lint
```

## Troubleshooting

**"tmux is not installed"**
```bash
sudo apt install tmux  # Linux
brew install tmux      # macOS
```

**Sessions not showing status**
- The MCP server must be configured in your AI tool
- Check `/tmp/orcha/agents/` for status files
- Try `orcha status -w` to watch for changes

**Orphaned worktrees after crash**
```bash
orcha cleanup -r ~/myproject
```

**Multiple instances, wrong one selected**
```bash
orcha list                        # See all instances
orcha status -i <instance-id>     # Target specific instance
```

## License

MIT

## Contributing

Contributions welcome! Please open an issue first to discuss what you'd like to change.

---

*Orcha: Herd your AI agents*
