# Blueprint: Claude Usage Display in Sidebar

## Goal

Display Claude Code usage statistics (tokens, sessions, messages) at the bottom of the left navigation pane in the orcha web dashboard.

---

## Non-Goals (Out of Scope)

- Real-time per-session token tracking (requires Claude Code integration)
- Cost calculation or billing estimates
- Historical usage charts or graphs (MVP shows current stats only)
- Usage limits or alerts
- Per-session usage breakdown (aggregated dashboard-wide only)

---

## Acceptance Criteria

- [ ] Usage section visible at bottom of sidebar (above or replacing current summary)
- [ ] Shows today's token count (aggregated across models)
- [ ] Shows today's message count
- [ ] Shows today's session count
- [ ] Data refreshes automatically (same polling interval as sessions)
- [ ] Graceful fallback if `~/.claude/stats-cache.json` is missing or unreadable
- [ ] No visual disruption to existing sidebar layout

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (app.js)                          │
│                                                                 │
│  state.usage = { tokens, messages, sessions, date }             │
│                                                                 │
│  fetchUsage() → GET /api/usage                                 │
│  updateUsageDisplay() → renders to #usage-stats                │
└────────────────────────────┬────────────────────────────────────┘
                             │ HTTP
┌────────────────────────────▼────────────────────────────────────┐
│                    Backend (server.ts)                          │
│                                                                 │
│  GET /api/usage  (NEW endpoint)                                │
│    - Reads ~/.claude/stats-cache.json                          │
│    - Extracts today's activity + model tokens                  │
│    - Returns { tokens, messages, sessions, date }              │
└─────────────────────────────────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│              ~/.claude/stats-cache.json                        │
│                                                                 │
│  {                                                              │
│    "dailyActivity": [{ date, messageCount, sessionCount }],    │
│    "dailyModelTokens": [{ date, tokensByModel: {...} }]        │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Fetch**: `render()` already polls `/api/status` every 3s. Add parallel call to `/api/usage`.
2. **Parse**: Backend reads `stats-cache.json`, finds today's entry (or latest), sums tokens.
3. **Display**: Frontend renders token/message/session counts in sidebar footer.

---

## File Layout (Key Changes)

```
src/
├── web/
│   ├── server.ts           # Add GET /api/usage endpoint
│   └── public/
│       ├── index.html      # Add #usage-stats container in sidebar-footer
│       ├── app.js          # Add fetchUsage(), updateUsageDisplay(), call in render()
│       └── style.css       # Add .usage-stats styling
```

---

## Milestones

### Milestone 1: Backend API Endpoint

**Intent**: Create `/api/usage` endpoint that reads Claude stats file.

**Files touched**:
- `src/web/server.ts` - Add `GET /api/usage` route

**Implementation notes**:
- Read `~/.claude/stats-cache.json`
- Find today's date entry in `dailyActivity` and `dailyModelTokens`
- Sum all tokens across models for today
- Return `{ date, tokens, messages, sessions }` or `{ error }` if file missing

**Verification**:
```bash
npm run build
# Start server manually or via orcha web
curl http://localhost:3847/api/usage | jq
# Should return: { "date": "2026-01-31", "tokens": 12345, "messages": 100, "sessions": 5 }
```

---

### Milestone 2: Frontend Display

**Intent**: Show usage stats in sidebar footer.

**Files touched**:
- `src/web/public/index.html` - Add `#usage-stats` div in `sidebar-footer`
- `src/web/public/app.js` - Add `fetchUsage()`, `updateUsageDisplay()`, integrate with `render()`
- `src/web/public/style.css` - Style `.usage-stats`

**Implementation notes**:
- Add state.usage object
- Call `fetchUsage()` in `render()` (or as separate interval)
- Format tokens with K/M suffix (e.g., "125K tokens")
- Show date label ("Today" if matches current date)

**HTML structure**:
```html
<div id="usage-stats">
  <div class="usage-label">Today</div>
  <div class="usage-row">
    <span class="usage-value">125K</span>
    <span class="usage-unit">tokens</span>
  </div>
  <div class="usage-row">
    <span class="usage-value">42</span>
    <span class="usage-unit">messages</span>
  </div>
</div>
```

**Verification**:
```bash
npm run build
orcha web --no-open
# Open http://localhost:3847
# Should see usage stats in bottom of sidebar
# Stats should update on page refresh
```

---

## Risks & Probes

| Risk | Impact | Mitigation |
|------|--------|------------|
| **stats-cache.json stale** | Shows old data | Show date label so user knows. Could add "last updated" timestamp. |
| **File permissions** | Can't read stats file | Use try/catch, return graceful error response. Frontend shows "Usage unavailable". |
| **Different Claude installs** | Wrong or missing path | Use `~/.claude/stats-cache.json` (standard path). Consider env var override. |
| **Large token numbers** | Overflow or ugly display | Format with K/M suffixes (1,234,567 → "1.2M") |

### Quick Probes to Run First

1. **Verify stats file path**:
   ```bash
   ls -la ~/.claude/stats-cache.json
   cat ~/.claude/stats-cache.json | jq '.dailyActivity[-1], .dailyModelTokens[-1]'
   ```

2. **Check date format**:
   ```bash
   date +%Y-%m-%d  # Should match format in stats-cache.json
   ```

3. **Verify current structure**:
   ```bash
   cat ~/.claude/stats-cache.json | jq 'keys'
   # Expected: ["dailyActivity", "dailyModelTokens", "modelUsage", ...]
   ```

---

## Open Questions

1. **Refresh frequency**: Should usage poll at same rate as sessions (3s) or less frequently (10s)?
   - **Recommendation**: Same rate for simplicity. File read is fast.

2. **Show sessions/messages?**: Display all three metrics or just tokens?
   - **Recommendation**: Show tokens prominently, messages as secondary. Skip sessions (less useful).

3. **Historical data?**: Show "this week" or "this month" totals?
   - **Recommendation**: MVP shows today only. Add weekly summary in future iteration.

4. **Layout placement**: Replace existing summary or add separately?
   - **Recommendation**: Add above existing session summary. Keep both.

---

## Data Format Reference

From `~/.claude/stats-cache.json`:

```json
{
  "dailyActivity": [
    {
      "date": "2026-01-30",
      "messageCount": 1045,
      "sessionCount": 10,
      "toolCallCount": 186
    }
  ],
  "dailyModelTokens": [
    {
      "date": "2026-01-30",
      "tokensByModel": {
        "claude-opus-4-5-20251101": 60988,
        "claude-sonnet-4-5-20250929": 1234
      }
    }
  ]
}
```

---

Next: /probe 'Milestone 1 - Backend API Endpoint'
