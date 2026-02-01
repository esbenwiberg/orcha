# Blueprint: Fix Usage Display & Add Comprehensive Stats

## Goal

Fix the current usage display that shows nothing (because it only looks for "today" which has no data yet) and enhance it to show more comprehensive statistics similar to Claude's `/usage` command output.

---

## Problem Analysis

The current implementation has a **critical flaw**:

```typescript
// server.ts:1056-1060
const today = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
const activity = data.dailyActivity?.find((d) => d.date === today)
const tokenData = data.dailyModelTokens?.find((d) => d.date === today)
```

**Issue**: The stats-cache.json is only updated when Claude sessions end. If today is 2026-02-01 but `lastComputedDate` is 2026-01-31, the usage display shows 0/nothing because there's no entry for today yet.

**Solution**: Fall back to the most recent date if today's data doesn't exist.

---

## Non-Goals (Out of Scope)

- Real-time token streaming during active sessions
- Cost calculation in dollars (stats-cache.json shows costUSD: 0)
- Per-session token breakdowns
- Exporting usage data
- Usage alerts or limits

---

## Acceptance Criteria

- [ ] Usage displays data even when today has no entries (shows yesterday/most recent)
- [ ] Date label shows actual date when not "Today"
- [ ] Shows cumulative/total usage alongside daily stats
- [ ] Shows model breakdown (Opus vs Sonnet tokens)
- [ ] Shows tool call count (available in dailyActivity)
- [ ] Cache read tokens displayed (significantly larger than regular tokens)
- [ ] Display is compact and doesn't overwhelm sidebar

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Frontend (app.js)                           │
│                                                                 │
│  state.usage = {                                                │
│    daily: { date, tokens, messages, sessions, toolCalls },      │
│    totals: { sessions, messages, inputTokens, cacheReadTokens },│
│    byModel: [{ model, tokens }]                                 │
│  }                                                              │
│                                                                 │
│  fetchUsage() → GET /api/usage                                  │
│  updateUsageDisplay() → renders to #usage-stats                 │
└────────────────────────────────────────────────────────────────┘
                            │ HTTP
┌───────────────────────────▼────────────────────────────────────┐
│                    Backend (server.ts)                          │
│                                                                 │
│  GET /api/usage                                                 │
│    - Reads ~/.claude/stats-cache.json                           │
│    - Gets today OR most recent day's activity                   │
│    - Returns { daily, totals, byModel }                         │
└─────────────────────────────────────────────────────────────────┘
                            │
                            ▼
┌─────────────────────────────────────────────────────────────────┐
│              ~/.claude/stats-cache.json                         │
│                                                                 │
│  {                                                              │
│    "lastComputedDate": "2026-01-31",                            │
│    "dailyActivity": [...],                                      │
│    "dailyModelTokens": [...],                                   │
│    "modelUsage": {                                              │
│      "claude-opus-4-5-20251101": {                              │
│        "inputTokens": 793093,                                   │
│        "outputTokens": 37705,                                   │
│        "cacheReadInputTokens": 804505318   <-- huge!            │
│      }                                                          │
│    },                                                           │
│    "totalSessions": 203,                                        │
│    "totalMessages": 34658                                       │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

### Key Data Points Available

| Field | Location | Example Value |
|-------|----------|---------------|
| Daily messages | dailyActivity[].messageCount | 2999 |
| Daily sessions | dailyActivity[].sessionCount | 24 |
| Daily tool calls | dailyActivity[].toolCallCount | 633 |
| Daily tokens (by model) | dailyModelTokens[].tokensByModel | { opus: 127804 } |
| Total sessions | totalSessions | 203 |
| Total messages | totalMessages | 34658 |
| Total input tokens | modelUsage[model].inputTokens | 793093 |
| Total output tokens | modelUsage[model].outputTokens | 37705 |
| Cache read tokens | modelUsage[model].cacheReadInputTokens | 804M |

---

## Proposed UI Layout

Compact sidebar display:

```
╔══════════════════════════════════╗
║  USAGE - Jan 31                  ║
║  ──────────────────────────       ║
║  127K tokens (Opus)              ║
║  2.9K messages • 633 tools       ║
║  ──────────────────────────       ║
║  ALL TIME                        ║
║  203 sessions • 34.6K msgs       ║
║  804M cache reads                ║
╚══════════════════════════════════╝
```

---

## File Layout (Key Changes)

```
src/web/
├── server.ts           # FIX: fallback to most recent date
│                       # ADD: totals and byModel in response
└── public/
    ├── app.js          # UPDATE: updateUsageDisplay() for new format
    └── style.css       # UPDATE: styling for expanded display
```

---

## Milestones

### Milestone 1: Fix Date Fallback (Critical Bug Fix)

**Intent**: Ensure usage always shows something when stats exist.

**Files touched**:
- `src/web/server.ts` - getClaudeUsage() method

**Changes**:
```typescript
// Instead of only looking for today:
const today = new Date().toISOString().slice(0, 10)
let activity = data.dailyActivity?.find((d) => d.date === today)
let tokenData = data.dailyModelTokens?.find((d) => d.date === today)
let displayDate = today

// Fall back to most recent if today not found:
if (!activity && data.dailyActivity?.length) {
  activity = data.dailyActivity[data.dailyActivity.length - 1]
  displayDate = activity.date
}
if (!tokenData && data.dailyModelTokens?.length) {
  tokenData = data.dailyModelTokens[data.dailyModelTokens.length - 1]
}
```

**Verification**:
```bash
npm run build && cp dist/web/server.js dist/web/server.js
curl http://localhost:3847/api/usage | jq
# Should now return data from 2026-01-31 instead of empty
```

---

### Milestone 2: Expand API Response

**Intent**: Return totals and model breakdown alongside daily stats.

**Files touched**:
- `src/web/server.ts` - UsageStats interface and getClaudeUsage()

**New interface**:
```typescript
interface UsageStats {
  daily: {
    date: string
    tokens: number
    messages: number
    sessions: number
    toolCalls: number
  }
  totals: {
    sessions: number
    messages: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
  }
  byModel: Array<{
    model: string
    tokens: number
  }>
}
```

**Verification**:
```bash
curl http://localhost:3847/api/usage | jq '.totals.cacheReadTokens'
# Should show ~804M
```

---

### Milestone 3: Update Frontend Display

**Intent**: Show the enhanced stats in a compact, readable format.

**Files touched**:
- `src/web/public/app.js` - updateUsageDisplay()
- `src/web/public/style.css` - styling tweaks

**Display logic**:
- Show daily stats with date label
- Show abbreviated model name (Opus/Sonnet instead of full ID)
- Show all-time totals
- Format large numbers (804M cache reads)

**Verification**:
```bash
# Open http://localhost:3847
# Usage section should show yesterday's stats with "Jan 31" label
# Should show all-time totals below
```

---

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| stats-cache.json stale for days | Shows very old data | Show date prominently; user will know |
| Cache read tokens confusing | Users don't understand 804M | Add tooltip or label "cache reads" |
| UI too busy | Cluttered sidebar | Use collapsible "All Time" section |
| Model names change | Display breaks | Extract short name dynamically |

---

## Open Questions

1. **Should "All Time" be collapsible?**
   - Recommendation: Start expanded, track if users collapse it

2. **Show output tokens separately?**
   - Recommendation: No, just show total (input + output) for simplicity

3. **Refresh rate for usage?**
   - Recommendation: Keep at 3s (same as sessions), file read is fast

---

## Implementation Order

1. **Milestone 1** - Fix the critical bug (usage shows nothing)
2. **Milestone 2** - Expand API with totals (can be same PR)
3. **Milestone 3** - Update frontend display

Estimated scope: 1 patch for all 3 milestones (small changes).

---

Next: /probe 'Milestone 1 - Fix Date Fallback'
