# Blueprint: VM Health Monitoring

## Goal

Add CPU and memory monitoring to the Orcha dashboard so users can see when their VM is under stress and anticipate crashes before they happen. The health data displays in the sidebar alongside existing usage stats.

## Non-Goals

- **Disk I/O monitoring** - out of scope for now, can be added later
- **Alerting / notifications** - no email/slack alerts, just visual indicators
- **Historical data / graphs** - no time-series storage, just current snapshot
- **Per-session resource usage** - tracking total VM health, not per-process
- **Network monitoring** - not needed for the crash-detection use case

## Acceptance Criteria

- [ ] New `GET /api/health` endpoint returns current CPU %, memory used/total (GB), and uptime
- [ ] Sidebar shows a compact health widget below the usage stats area
- [ ] CPU and memory show as labeled progress bars with percentage
- [ ] Bars change color: green (<60%), yellow (60-85%), red (>85%)
- [ ] Health data refreshes on the same 3-second polling cycle as sessions
- [ ] Zero new dependencies — uses Node.js `os` module only
- [ ] TypeScript compiles cleanly, no regressions

## Architecture

### Data Flow

```
Node.js os module → GET /api/health → Frontend fetch (3s poll) → Sidebar widget
```

### Components

1. **Backend** (`server.ts`): New `/api/health` GET endpoint
   - Uses `os.cpus()`, `os.totalmem()`, `os.freemem()`, `os.uptime()`, `os.loadavg()`
   - Returns JSON with cpu %, mem used/total, uptime
   - CPU calculated from 1-minute load average relative to CPU count (simple, no state needed)

2. **Frontend** (`app.js`):
   - New `fetchHealth()` function alongside existing `fetchUsage()`
   - New `updateHealthDisplay(health)` function renders widget into a new `#vm-health` div
   - Added to the parallel `Promise.all` in `render()`

3. **HTML** (`index.html`): New `<div id="vm-health"></div>` in sidebar footer

4. **CSS** (`style.css`): Styles for health bars and widget

### API Response Shape

```json
{
  "cpu": 42.5,
  "memUsed": 6.2,
  "memTotal": 16.0,
  "memPercent": 38.8,
  "uptime": 86400,
  "loadAvg": [1.2, 0.8, 0.6]
}
```

## File Layout (Key Changes)

```
src/web/server.ts          # Add /api/health endpoint + os import
src/web/public/index.html  # Add #vm-health div in sidebar footer
src/web/public/app.js      # Add fetchHealth(), updateHealthDisplay(), integrate into render()
src/web/public/style.css   # Add health widget styles
```

Plus copies to `dist/web/public/` per CLAUDE.md convention.

## Milestones

### Milestone 1: Backend `/api/health` Endpoint

**Intent:** Expose system health data via REST API.

**Key files:**
- `src/web/server.ts` — add endpoint + `os` import

**Implementation:**
- `os` module is already partially imported (`homedir`). Add `cpus`, `totalmem`, `freemem`, `uptime` as named imports.
- Add new `GET /api/health` route near existing `/api/usage`
- CPU % derived from 1-minute load average / CPU count × 100 (capped at 100)
- Memory: `totalmem() - freemem()` for used, `totalmem()` for total
- All values rounded to 1 decimal

**Verification:**
```bash
npm run build
curl http://localhost:3000/api/health
```

### Milestone 2: Frontend Health Widget

**Intent:** Display health data in the sidebar with color-coded progress bars.

**Key files:**
- `src/web/public/index.html` — add `<div id="vm-health"></div>` in sidebar footer
- `src/web/public/app.js` — add fetch + render functions, integrate into render loop
- `src/web/public/style.css` — health widget styles

**Implementation:**
- HTML: Add `<div id="vm-health"></div>` between `#usage-stats` and `#summary`
- JS: `fetchHealth()` fetches `/api/health`, `updateHealthDisplay()` renders two labeled bars (CPU, MEM)
- CSS: `.health-bar-track` (background track), `.health-bar-fill` (colored fill), color classes via thresholds
- Integrate into `render()` Promise.all alongside existing fetches
- Widget hides itself when data unavailable (same `:empty` pattern as usage stats)

**Verification:**
```bash
cp src/web/public/{index.html,app.js,style.css} dist/web/public/
# Open dashboard, verify sidebar shows CPU and MEM bars
# Verify bars update every 3 seconds
```

### Milestone 3: Build + End-to-End Verification

**Intent:** Ensure TypeScript compiles and dist files are synced.

**Verification:**
```bash
npm run build
# Restart server, open dashboard
# Confirm health widget visible with CPU/MEM bars
# Confirm no console errors
```

## Risks / Unknowns

| Risk | Mitigation |
|------|-----------|
| Load average isn't "CPU %" — it's a rough proxy | Good enough for a dashboard widget. Can refine later with `/proc/stat` delta sampling if needed. |
| WSL may report different values than native Linux | `os` module works fine on Linux/WSL. Test on actual VM. |
| Adding to 3s poll increases API calls | Single `os.*` calls are sub-millisecond; negligible cost. |

## Design Notes

The health widget follows the exact same pattern as the existing usage stats widget:
- Same `<div>` in sidebar footer
- Same fetch-in-parallel pattern in `render()`
- Same compact labeling style (`.usage-label` reused as `.health-label`)
- Widget hides itself when data unavailable (same as usage stats)

---

Next: /probe 'Milestone 1: Backend /api/health Endpoint'
