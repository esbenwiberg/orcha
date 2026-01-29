# Debug Orcha Status Issues

Use when orcha status/list commands show incorrect or stale data.

## Common Issues

### 1. Instances disappear from `orcha list`
**Symptom:** `orcha list` shows no instances even though tmux sessions exist
**Cause:** Instance registry (`~/.orcha/instances.json`) stores the CLI process PID, which dies after attaching to tmux. Stale cleanup removes it.
**Fix:** Registry should check tmux session existence (`tmux has-session -t <name>`), not PID.
**Check:** `tmux list-sessions` vs `cat ~/.orcha/instances.json`

### 2. Fake/placeholder branch names in status
**Symptom:** Status shows `feature/task-1` instead of real branch names
**Cause:** `formatStatus` in `src/cli/format.ts` may have placeholder logic
**Fix:** Use session metadata store (`/tmp/orcha/<instance>/sessions.json`)
**Check:** `cat /tmp/orcha/<instance>/sessions.json`

### 3. Status shows "idle" when sessions are working
**Symptom:** All sessions show "idle/Ready" even when Claude is active
**Cause:** Status files only update via MCP tool calls. If MCP not configured, files are stale.
**Fix:** Use tmux pane content detection as fallback
**Check:** `tmux capture-pane -t <session>:0.<pane> -p -S -20`

### 4. Stale demo data pollution
**Symptom:** Status shows old demo data ("Implementing OAuth2 flow", etc.)
**Cause:** `orcha demo` writes to `/tmp/orcha/agents/` which persists
**Fix:** Clean `/tmp/orcha/agents/*.json` or use instance-specific dirs

## Debugging Commands

```bash
# Check tmux sessions
tmux list-sessions

# Check instance registry
cat ~/.orcha/instances.json

# Check session metadata for an instance
cat /tmp/orcha/<instance-id>/sessions.json

# Check status files
ls -la /tmp/orcha/<instance-id>/agents/
cat /tmp/orcha/<instance-id>/agents/*.json

# Check actual pane content
tmux capture-pane -t <session>:0.0 -p -S -30

# Clean stale data
rm /tmp/orcha/agents/*.json
```

## Architecture Notes

- **Instance Registry** (`~/.orcha/instances.json`): Tracks running orcha instances
- **Session Store** (`/tmp/orcha/<id>/sessions.json`): Persists session metadata (branch, mode, worktree)
- **Status Files** (`/tmp/orcha/<id>/agents/*.json`): Agent state updated via MCP
- **Tmux Detection**: Fallback that reads pane content and detects Claude patterns

## Key Files

- `src/core/instance-registry.ts` - Instance tracking and stale cleanup
- `src/core/session-store.ts` - Session metadata persistence
- `src/core/status-monitor.ts` - Status file watching
- `src/cli/format.ts` - Status display formatting
- `src/cli/tmux-renderer.ts` - Tmux pane detection (`detectClaudeStatus`)
