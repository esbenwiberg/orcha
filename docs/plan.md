# Blueprint: Pipeline Fixes & Missing Features

## Goal

Fix bugs found during code review (config override merge, feedback persistence, json-schema passthrough, code duplication) and implement features promised in the original `docs/pipeline.md` blueprint that were skipped (WebSocket pipeline events, MCP pipeline status tool, `orcha pipeline recover` command).

## Non-Goals

- Rewriting the pipeline architecture (it's sound)
- Adding new pipeline features beyond what the blueprint specifies
- Adding tests (will be a separate effort)
- Changing the state machine or transition table

## Acceptance Criteria

- [ ] `orcha pipeline run --model-architect sonnet` correctly overrides architect model while preserving all other model/budget defaults
- [ ] `feedbackArchitectCheckpoint()` persists the restored original description to disk
- [ ] Architect stage passes `--output-format json` to Claude CLI (json-schema param removed since Claude CLI doesn't support `--json-schema` as a standalone flag — structured output is handled via `--output-format json` + prompt instructions)
- [ ] `getDiff()` is a single shared function, not duplicated 4 times
- [ ] JSON output parsing (`tryJson` + 4-strategy pattern) is a single shared utility
- [ ] WebSocket emits pipeline state change events when transitions occur
- [ ] Frontend subscribes to WebSocket pipeline events for instant updates (falls back to polling)
- [ ] `orcha_pipeline_status` MCP tool exists and agents can report pipeline-level status
- [ ] `orcha pipeline recover <id>` command resets stuck `error` state pipelines
- [ ] `appendLearning()` uses file-level locking to prevent lost updates from concurrent pipelines
- [ ] `npm run build` succeeds with no type errors

## Architecture

### Bug Fixes (no architectural change)

**Config merge fix** — CLI deep-merges user overrides onto `defaultPipelineConfig()` before calling `parsePipelineConfig()`.

**Feedback persistence** — `feedbackArchitectCheckpoint()` calls `savePipelineRun()` after restoring the original description.

**json-schema cleanup** — Remove the unused `jsonSchema` parameter from `StageRunnerOptions` and `buildCliArgs`. The architect already instructs Claude to output JSON via `--output-format json` + prompt instructions. The `BLUEPRINT_SCHEMA` constant stays for the `isValidBlueprint()` validator.

### Code Deduplication

```
src/pipeline/git-utils.ts          — NEW: getDiff(), getChangedFiles() shared helpers
src/pipeline/output-parser.ts      — NEW: parseStructuredOutput<T>() generic parser
```

Both are pure utility modules with no pipeline-engine dependencies.

### WebSocket Pipeline Events

```
Pipeline Engine (transition())
  └─→ Emits 'pipeline:state-change' event (via Node EventEmitter)
        └─→ WebDashboardServer listens, broadcasts to all WS clients
              └─→ Frontend receives, updates UI instantly
```

The `transition()` function in `pipeline-engine.ts` already persists state. We add an event emission after save. The web server subscribes to this event and broadcasts a JSON message to all connected WebSocket clients.

### MCP Pipeline Status Tool

```
src/mcp/server.ts
  └─→ New tool: orcha_pipeline_status
        - Accepts: pipelineId, stage, status, details
        - Writes to: ~/.orcha/pipelines/{id}/agent-status.json
        - Used by: pipeline agents to report progress from within their sessions
```

### Pipeline Recovery

```
src/cli/index.ts
  └─→ orcha pipeline recover <id>
        - Loads pipeline in 'error' state
        - Transitions to the last non-error stage from stageHistory
        - User can then --continue from there
```

Requires adding `error → <previous-stage>` as a valid transition (similar to how `paused` resumes).

## Folder/File Layout

### New Files

```
src/pipeline/git-utils.ts         — Shared git diff/changed-files helpers
src/pipeline/output-parser.ts     — Generic structured output parser
src/pipeline/events.ts            — Pipeline EventEmitter singleton
```

### Modified Files

```
src/pipeline/pipeline-engine.ts    — Emit events on transition
src/pipeline/checkpoint.ts         — Persist after feedback description restore
src/pipeline/stage-runner.ts       — Remove unused jsonSchema param
src/pipeline/learning-store.ts     — Add file locking to appendLearning
src/pipeline/gate-agents/*.ts      — Replace local getDiff/tryJson with shared utils
src/pipeline/stages/architect.ts   — Remove jsonSchema from runStage call
src/cli/index.ts                   — Fix config merge, add recover command
src/web/server.ts                  — Subscribe to pipeline events, broadcast via WS
src/web/public/app.js              — Listen for WS pipeline events
src/mcp/server.ts                  — Add orcha_pipeline_status tool
```

## Milestones

---

### M1: Bug Fixes (config merge, feedback persistence, json-schema cleanup)

**Intent**: Fix the three confirmed bugs that affect correctness.

**Key files modified**:
- `src/cli/index.ts` — Deep-merge model/budget overrides onto `defaultPipelineConfig()` before `parsePipelineConfig()`
- `src/pipeline/checkpoint.ts` — Add `await savePipelineRun(run)` after restoring original description at line 80
- `src/pipeline/stage-runner.ts` — Remove `jsonSchema` from `StageRunnerOptions`, `CliArgs`, and `buildCliArgs()`
- `src/pipeline/stages/architect.ts` — Remove `jsonSchema` parameter from `runStage()` call

**Verification**:
```bash
npm run build
# Manual: run `orcha pipeline run --model-architect sonnet` and inspect state.json
#   → config.models should have all defaults + architect overridden
# Manual: run feedback on a checkpoint:arch pipeline
#   → After feedback, state.json description should be the ORIGINAL, not augmented
```

---

### M2: Code Deduplication (getDiff, output parser)

**Intent**: Extract duplicated utilities into shared modules.

**Key files created**:
- `src/pipeline/git-utils.ts` — `getDiff(worktreePath, sourceBranch): string | null` and `getChangedLintableFiles(worktreePath, sourceBranch): string[]` (extracted from gate agents and fix-loop)
- `src/pipeline/output-parser.ts` — `parseStructuredOutput<T>(stdout: string, validator: (obj: unknown) => obj is T): T | null` implementing the 4-strategy pattern (direct, result wrapper, code block, brace match)

**Key files modified**:
- `src/pipeline/gate-agents/ac-validator.ts` — Replace local `getDiff`, `tryJson`, parsing with shared utils
- `src/pipeline/gate-agents/adversary.ts` — Same
- `src/pipeline/gate-agents/code-review.ts` — Same
- `src/pipeline/gate-agents/security-review.ts` — Same
- `src/pipeline/gate-agents/lint-runner.ts` — Replace local `getChangedFiles` with shared util
- `src/pipeline/stages/architect.ts` — Replace local `tryParseJson`/parsing with shared util
- `src/pipeline/stages/fix-loop.ts` — Replace local `getDiff` with shared util
- `src/pipeline/index.ts` — Export new modules

**Verification**:
```bash
npm run build
grep -r "function getDiff" src/pipeline/  # Should only appear in git-utils.ts
grep -r "function tryJson\|function tryParseJson" src/pipeline/  # Should only appear in output-parser.ts
```

---

### M3: Learning Store File Locking

**Intent**: Prevent lost updates when concurrent pipelines finish simultaneously.

**Key files modified**:
- `src/pipeline/learning-store.ts` — Use a simple lockfile approach: `writeFile(lockPath, '', { flag: 'wx' })` (fails atomically if lock exists) with retry loop and stale-lock expiry (30s). No new dependencies.

**Verification**:
```bash
npm run build
# Manual: verify learning.json writes don't lose entries under concurrent pipeline completion
```

---

### M4: Pipeline Events & WebSocket Broadcasting

**Intent**: Real-time pipeline state updates in the web dashboard via WebSocket.

**Key files created**:
- `src/pipeline/events.ts` — Singleton `EventEmitter` for pipeline events:
  ```
  pipelineEvents.emit('state-change', { pipelineId, from, to, run })
  ```

**Key files modified**:
- `src/pipeline/pipeline-engine.ts` — Import `pipelineEvents` and emit `state-change` after `savePipelineRun()` in `transition()`
- `src/web/server.ts` — In WebSocket setup, subscribe to `pipelineEvents.on('state-change')` and broadcast `{ type: 'pipeline:state-change', data: { id, state, updatedAt } }` to all connected clients
- `src/web/public/app.js` — In the existing WS connection handler, listen for `pipeline:state-change` messages and update `state.pipelines` + re-render immediately (keep 3s poll as fallback)

**Verification**:
```bash
npm run build && cp src/web/public/{app.js,style.css,index.html} dist/web/public/
# Manual: open web dashboard, run a pipeline, verify instant state updates in sidebar
```

---

### M5: MCP Pipeline Status Tool

**Intent**: Allow pipeline agents to report progress from within their Claude sessions.

**Key files modified**:
- `src/mcp/server.ts` — Register `orcha_pipeline_status` tool with parameters:
  - `pipelineId` (string, required)
  - `stage` (string, required) — current stage name
  - `status` (enum: working|completed|error, required)
  - `details` (string, optional) — human-readable status message

  The tool writes to `~/.orcha/pipelines/{pipelineId}/agent-status.json` (atomic write).
  Emits a `pipeline:agent-status` event so the web dashboard can show agent activity.

**Verification**:
```bash
npm run build
# Manual: run a pipeline, check if agent-status.json is written during stage execution
```

---

### M6: Pipeline Recovery Command

**Intent**: Allow users to recover pipelines stuck in `error` state.

**Key files modified**:
- `src/pipeline/pipeline-engine.ts` — Extend `isValidTransition` to allow `error → <active-state>` when a `recoveryTarget` is provided. Add helper `getRecoveryTarget(run)` that inspects `stageHistory` to determine the right state.
- `src/pipeline/checkpoint.ts` — Add `recoverPipeline(run)` that validates error state, determines recovery target, transitions, clears `error` field.
- `src/cli/index.ts` — Add `orcha pipeline recover <id>` command with `--continue` option.

**Verification**:
```bash
npm run build
# Manual: create a pipeline that errors, run `orcha pipeline recover <id>`, verify state
# Manual: `orcha pipeline recover <id> --continue` should resume execution
```

---

## Risks & Unknowns

| Risk | Impact | Quick Probe |
|------|--------|------------|
| WebSocket broadcast may include full PipelineRun (large payload) | Performance | M4: Send minimal payload `{ id, state, updatedAt }`, client refetches full data if selected |
| MCP tool may not be available if user hasn't configured MCP | Agent can't report status | M5: Best-effort — agent status is informational only, pipeline still works without it |
| File locking in learning store may deadlock if process crashes while holding lock | Learning store unusable | M3: Use lock expiry (stale locks older than 30s are force-removed) |
| Recovery from `error` may resume a stage with stale worktree state | Incorrect behavior | M6: Recovery re-runs the stage from scratch, not resume mid-stage. Document this. |
| `--output-format json` without schema constraint means Claude isn't schema-constrained | Architect may produce invalid JSON | Already handled: `parseArchitectOutput` has 4 fallback strategies + `isValidBlueprint` validation. Low risk. |
| Double gate execution concern was investigated and confirmed NOT a bug | None | The engine's `executeFixLoopStage` consumes the gate transition internally, CLI loop never sees `gate` state after fix-loop |

---

Next: `/probe 'M1: Bug Fixes (config merge, feedback persistence, json-schema cleanup)'`
