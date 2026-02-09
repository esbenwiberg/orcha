# Blueprint: Orcha Pipeline — Autonomous Development Workflow

## Goal

Add a pipeline orchestration layer (`src/pipeline/`) to Orcha that drives work items through an autonomous development lifecycle: **architect → develop → gate → fix loop → ship** — with human checkpoints, adversarial review, competing agent support, per-pipeline token tracking, and a self-improving learning loop.

## Non-Goals

- Replacing or modifying existing Orcha session management (pipeline is additive)
- Cloud/SaaS execution — runs on user's own VM with existing tmux infrastructure
- Building a custom LLM gateway or model router — uses Claude Code / Gemini CLI / Codex CLI as-is
- Multi-user pipeline management (single operator, same as current Orcha)
- Formal verification integration (future consideration)
- Custom IDE/editor integration (agents use CLI tools)

## Acceptance Criteria

- [ ] `orcha pipeline run --work-item <id>` starts an autonomous pipeline from a GitHub issue or ADO work item
- [ ] `orcha pipeline run --description "..." --ac "..."` starts a pipeline from inline text
- [ ] `--source-branch <branch>` forks dev worktree from any branch (default: main/master); PR targets that branch
- [ ] Architect agent produces a structured JSON blueprint with files-to-touch, approach, risks, and test strategy
- [ ] Human checkpoint pauses pipeline after architect stage; dashboard shows approve/reject/edit controls
- [ ] Dev agent(s) execute in fresh worktrees with blueprint as instructions
- [ ] Competing mode (`--competing 3`) runs N dev agents in parallel on the same blueprint
- [ ] Gate runs test, security, code-review, AC-validation, and adversary agents in parallel (configurable)
- [ ] Gate failure triggers fix loop: fresh Claude session with blueprint + diff + failure report
- [ ] Fix loop caps at configurable max retries (default 3), then escalates to human
- [ ] Human checkpoint before ship shows full diff, gate results, and approve/reject
- [ ] Ship stage commits, pushes, and creates PR with structured body linking to work item
- [ ] Pipeline view in web dashboard shows stage progress, active sessions, gate verdicts
- [ ] Token usage tracked per pipeline run (snapshot before/after each session)
- [ ] Pipeline run results logged to learning store for future architect prompt improvement
- [ ] Model configurable per stage (`--model opus` for architect, `--model sonnet` for gate, etc.)
- [ ] Per-session cost caps via `--max-budget-usd`
- [ ] Project CLAUDE.md respected by all pipeline agents (inherited from worktree automatically)
- [ ] Existing `orcha start/stop/watch/web` commands work unchanged
- [ ] `npm run build` succeeds with no type errors
- [ ] Pipeline state survives Orcha restarts (persisted to disk)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  CLI / Web Dashboard                                         │
│  orcha pipeline run --work-item 42                           │
│  orcha pipeline status                                       │
│  orcha pipeline list                                         │
│  Web: /api/pipelines, /api/pipelines/:id, WebSocket events   │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  PIPELINE ORCHESTRATOR  (src/pipeline/)                      │
│                                                              │
│  PipelineEngine          — state machine, drives stages      │
│  PipelineConfig          — Zod-validated configuration       │
│  StageRunner             — executes a single stage           │
│  GateAggregator          — collects & scores gate verdicts   │
│  UsageTracker            — snapshot-based token accounting   │
│  LearningStore           — records outcomes for feedback     │
│  PromptBuilder           — assembles agent prompts per stage │
│                                                              │
│  Interfaces only to src/core/:                               │
│    SessionManager.createSession({ ephemeral: true, ... })    │
│    SessionManager.destroySession(id)                         │
│    WorktreeManager.create / remove / reuseForSession         │
│    StatusMonitor.getStatus / on('status-change')             │
│    VcsProvider.getWorkItem / createPullRequest                │
│    ProcessRegistry.spawn / kill                              │
└──────────────────────────┬──────────────────────────────────┘
                           │ uses (clean interface boundary)
┌──────────────────────────▼──────────────────────────────────┐
│  ORCHA CORE  (src/core/ — existing, minimal changes)         │
│                                                              │
│  SessionManager  — add `ephemeral` flag to SessionConfig     │
│  WorktreeManager — no changes needed                         │
│  StatusMonitor   — no changes needed                         │
│  ProcessRegistry — no changes needed                         │
│  VcsProvider     — add getWorkItem to interface if missing   │
│  types.ts        — add PipelineState, ephemeral to Session   │
└──────────────────────────────────────────────────────────────┘
```

### Data Flow

```
1. User runs: orcha pipeline run --work-item 42
2. PipelineEngine creates pipeline record in ~/.orcha/pipelines/{pipelineId}/state.json
3. Fetches work item via VcsProvider → stores in pipeline dir
4. WORKTREE CREATION (before architect):
   a. Creates fresh worktree on branch: pipeline/{work-item-id} from --source-branch (default: main/master)
   b. This ensures architect sees the correct source branch code
   c. Same worktree reused by dev agent and gate agents
5. ARCHITECT stage:
   a. Runs in the WORKTREE created in step 4 — read-only, sees source branch code
   b. Uses --allowedTools "Read,Grep,Glob" to restrict to read-only
   c. All agents use: -p (print mode) + --dangerously-skip-permissions (autonomous operation)
   d. Injects prompt via --append-system-prompt: work item + learning hints
   e. Uses --json-schema for structured JSON blueprint output
   f. Session completes (auto-exits from -p mode) → PipelineEngine validates + stores blueprint
   g. CHECKPOINT: pauses, emits event, waits for human approve/reject/feedback
   h. On "feedback": re-runs architect with original prompt + user feedback (costs 1 more AI call)
6. DEV stage:
   a. Reuses worktree from step 4 (architect already read it, now dev modifies it)
   b. Creates 1..N ephemeral sessions (competing mode: N worktrees, N branches)
   c. Each gets blueprint via --append-system-prompt
   d. All agents use: -p + --dangerously-skip-permissions
   e. Sessions complete (auto-exit) → AUTO-COMMIT: pipeline runs `git add -A && git commit` in worktree
   f. In competing mode: all worktrees kept for gate comparison
7. GATE stage:
   a. Creates parallel agents (bounded by maxConcurrentSessions)
   b. Shell agents (test-runner, lint): run directly in worktree, no AI session needed
   c. AI agents (security, code-review, AC, adversary): use -p + --dangerously-skip-permissions, read commit diff via --append-system-prompt
   d. Adversary: writes tests to temp dir, runs against worktree, reports results, tests discarded
   e. Writes verdict to pipeline dir: gate-results/{agentType}.json
   f. GateAggregator scores: pass/fail + reasons
8. If FAIL → FIX LOOP:
   a. Fresh session (-p + --dangerously-skip-permissions) with: blueprint + committed diff + failure report
   b. Works on same worktree (clean state — previous changes committed)
   c. Session completes → auto-commit again
   d. Re-runs gate on updated code
   e. Max N retries → escalate to human
9. If PASS → CHECKPOINT: human reviews diff + gate results
10. SHIP stage:
    a. Ephemeral session (-p): git add, commit, push, create PR targeting source branch
    b. PR body includes: work item link, blueprint summary, gate results, token usage
11. LearningStore records: work item type, gate scores, fix loops, outcome
12. UsageTracker records: tokens consumed per stage and total
```

### Communication & Storage

```
~/.orcha/pipelines/
├── config.json                          # Default pipeline configuration
├── learning.json                        # Accumulated learning data
└── {pipelineId}/
    ├── state.json                       # Pipeline state machine state
    ├── work-item.json                   # Fetched work item + ACs
    ├── blueprint.json                   # Architect output
    ├── usage.json                       # Token snapshots per stage
    ├── logs/
    │   ├── architect.log                # Full terminal output from architect session
    │   ├── dev.log                      # Full terminal output from dev session(s)
    │   ├── gate-test-runner.log         # Test runner output
    │   ├── gate-lint.log                # Lint output
    │   ├── gate-adversary.log           # Adversary session output
    │   ├── fix-1.log                    # Fix loop attempt 1
    │   └── ship.log                     # Ship session output
    ├── dev-results/
    │   ├── {sessionId}.diff             # Git diff from dev agent
    │   └── {sessionId}.meta.json        # Branch, worktree, timing
    ├── gate-results/
    │   ├── test-runner.json             # { pass: bool, output, duration }
    │   ├── lint.json                    # { pass: bool, warnings: [], errors: [], changedFilesOnly: true }
    │   ├── security.json
    │   ├── code-review.json
    │   ├── ac-validator.json
    │   ├── adversary.json               # { testsWritten, testsFailed, details }
    │   └── verdict.json                 # Aggregated pass/fail + scores
    ├── fix-loops/
    │   ├── attempt-1/                   # Same structure as gate-results
    │   └── attempt-2/
    └── ship/
        ├── commit.json                  # { sha, message, branch }
        └── pr.json                      # { url, number, title, body }
```

Existing MCP `orcha_status` continues to work — pipeline sessions report status through the same mechanism. New `orcha_pipeline_status` MCP tool added for pipeline-level reporting.

### Token Usage Tracking

```
Strategy: Snapshot-diff approach

Before each stage:
  1. Read ~/.claude/stats-cache.json → record {inputTokens, outputTokens, cacheRead, cacheCreation} per model

After each stage (all sessions in stage complete):
  2. Read stats-cache.json again → compute delta
  3. Store delta in ~/.orcha/pipelines/{id}/usage.json per stage

Limitations:
  - If non-pipeline Claude sessions run concurrently, usage is approximate
  - Good enough for cost estimation and trend analysis

Structure:
{
  "stages": {
    "architect": { "inputTokens": 5200, "outputTokens": 12400, "cacheReadTokens": 890000, "duration": 45000 },
    "dev": { ... },
    "gate": { ... },
    "fix-1": { ... },
    "ship": { ... }
  },
  "total": { "inputTokens": 52000, "outputTokens": 98000, "cacheReadTokens": 4200000, "duration": 320000 },
  "estimatedCostUSD": 4.82   // Calculated from known pricing
}
```

### CLAUDE.md & Project Context Handling

```
Problem: Pipeline agents must follow project conventions (build steps, file sync rules, etc.)
         defined in the project's CLAUDE.md, without pipeline instructions overwriting them.

Solution: Leverage Claude Code's native behavior + --append-system-prompt

1. CLAUDE.md (automatic):
   - Claude Code reads CLAUDE.md from the working directory on startup
   - Worktrees are cloned from the repo → they inherit the project's CLAUDE.md
   - No action needed — project conventions are respected by default

2. Pipeline instructions (additive via --append-system-prompt):
   - Each stage gets its role + context injected via --append-system-prompt
   - This is ADDITIVE to the default system prompt (which includes CLAUDE.md)
   - No file conflicts, no CLAUDE.md overwrites

3. Blueprint delivery:
   - Architect output saved to ~/.orcha/pipelines/{id}/blueprint.json
   - Dev agent gets blueprint content via --append-system-prompt
   - Gate agents get diff + role via --append-system-prompt

Example session spawn (in tmux pane, with output capture):
  claude --model sonnet \
         --append-system-prompt "You are a dev agent in an Orcha pipeline. Your task: ..." \
         --dangerously-skip-permissions \
         --max-budget-usd 5 \
         -p "Implement the following blueprint: ..." \
         2>&1 | tee ~/.orcha/pipelines/{id}/logs/dev.log

For structured output (architect blueprint):
  claude --model opus \
         --json-schema '{"type":"object","properties":{"approach":{"type":"string"},...}}' \
         --append-system-prompt "You are an architect agent. Analyze the codebase and produce a blueprint." \
         --dangerously-skip-permissions \
         --allowedTools "Read,Grep,Glob" \
         -p "Work item: ..." \
         2>&1 | tee ~/.orcha/pipelines/{id}/logs/architect.log

Observability (two levels):
  1. Pipeline level: Dashboard shows stage progress, timing, cost per stage (M12)
  2. Agent level: Each agent runs in a tmux pane — attach via web terminal or tmux
     - Real-time: watch the agent think, edit files, run commands
     - StatusMonitor hooks fire in -p mode → sidebar shows working/idle
     - Post-mortem: output captured to logs/{stage}.log via tee
     - Completed stages: log file viewable in dashboard even after pane exits
```

### Model Configuration Per Stage

```
Rationale: Different stages need different capability levels.
  - Architect: Complex reasoning about codebase → needs strongest model
  - Dev: Writing code → strong model
  - Gate (test-runner): Just runs shell command → NO AI needed
  - Gate (security/code-review/AC): Reading + analysis → mid-tier model
  - Gate (adversary): Creative adversarial thinking → strong model
  - Fix loop: Debugging from failure context → strong model
  - Ship: Mostly git commands → minimal AI or shell

Default model mapping:
  architect:    opus        (complex reasoning, codebase analysis)
  dev:          opus        (code generation)
  gate:
    test-runner:    shell   (no AI — just runs configured test command)
    lint-runner:    shell   (no AI — runs eslint on changed files, --max-warnings 0)
    security:       sonnet  (diff analysis)
    code-review:    sonnet  (diff analysis)
    ac-validator:   sonnet  (diff vs ACs comparison)
    adversary:      opus    (creative edge-case thinking)
  fix:          opus        (debugging)
  ship:         haiku       (git operations, PR body generation)

Config structure:
{
  "models": {
    "default": "sonnet",
    "architect": "opus",
    "dev": "opus",
    "gate": "sonnet",
    "gate:adversary": "opus",
    "gate:test-runner": "shell",
    "gate:lint-runner": "shell",
    "fix": "opus",
    "ship": "haiku"
  },
  "budgets": {
    "default": 5.00,
    "architect": 3.00,
    "dev": 10.00,
    "gate": 2.00,
    "fix": 5.00,
    "ship": 1.00
  }
}

Stage-specific keys override "default". Gate agents use "gate" unless
"gate:<agent>" is specified. Budgets are per-session USD caps via
--max-budget-usd.

CLI override:
  orcha pipeline run --work-item 42 --source-branch develop --model-dev sonnet --model-gate haiku

Estimated cost comparison (typical pipeline run):
  All Opus:    ~$15-25 per pipeline run
  Optimized:   ~$5-10  per pipeline run (50-60% savings)
```

### Pipeline State Machine

```
          ┌──────────┐
          │ created   │
          └────┬─────┘
               ▼
          ┌──────────┐
          │architect  │──── session running
          └────┬─────┘
               ▼
       ┌───────────────┐
       │checkpoint:arch │──── human approve/reject/edit
       └───┬───────┬───┘
         approve  reject
           │       └──→ [cancelled]
           ▼
      ┌──────────┐
      │ dev       │──── 1..N sessions running
      └────┬─────┘
           ▼
      ┌──────────┐
      │ gate      │──── parallel review sessions
      └────┬─────┘
           │
     ┌─────┴─────┐
     pass       fail
     │       ┌───▼────┐
     │       │fix-loop │──── retry ≤ maxFixLoops
     │       └───┬────┘
     │         ┌─┴──┐
     │       pass  fail (exhausted)
     │         │     └──→ [escalated] (human notified)
     │         │
     ▼         ▼
  ┌───────────────┐
  │checkpoint:ship│──── human approve/reject
  └───┬───────┬───┘
    approve  reject
      │       └──→ [cancelled]
      ▼
  ┌──────────┐
  │ ship      │──── commit + push + PR
  └────┬─────┘
       ▼
  ┌──────────┐
  │ completed │
  └──────────┘
```

Valid states: `created | architect | checkpoint:arch | dev | gate | fix-loop | checkpoint:ship | ship | completed | cancelled | escalated | paused | error`

Pause/Resume: `orcha stop` while pipeline is running → state saved as `paused` with `pausedAt` field recording which stage was active. Active sessions killed, worktrees preserved. `orcha pipeline resume <id>` restarts from the paused stage.

## Folder/File Layout

### New Files

```
src/pipeline/
├── index.ts                    # Public exports
├── types.ts                    # Pipeline types, Zod schemas, state enum
├── pipeline-engine.ts          # State machine + stage orchestration
├── pipeline-store.ts           # Persistence (read/write pipeline state)
├── pipeline-config.ts          # Configuration loading + defaults
├── stage-runner.ts             # Creates sessions, waits for completion, collects output
├── stages/
│   ├── architect.ts            # Architect stage: prompt building + blueprint parsing
│   ├── dev.ts                  # Dev stage: single + competing mode
│   ├── gate.ts                 # Gate stage: parallel agents + aggregation
│   ├── fix-loop.ts             # Fix loop: failure report → fresh session → re-gate
│   └── ship.ts                 # Ship stage: commit, push, PR
├── gate-agents/
│   ├── test-runner.ts          # Runs test command, parses output
│   ├── lint-runner.ts          # Runs lint on changed files only, --max-warnings 0
│   ├── security-review.ts      # OWASP checklist prompt
│   ├── code-review.ts          # Convention + correctness prompt
│   ├── ac-validator.ts         # Compares diff to acceptance criteria
│   └── adversary.ts            # Writes breaking tests
├── prompt-builder.ts           # Assembles context-aware prompts per stage
├── usage-tracker.ts            # Snapshot-diff token accounting
├── learning-store.ts           # Records outcomes, provides hints to architect
└── checkpoint.ts               # Pause/resume + human interaction interface
```

### Modified Files

```
src/core/types.ts               # Add ephemeral to SessionConfig, PipelineState type
src/cli/index.ts                # Add `orcha pipeline` subcommands
src/web/server.ts               # Add /api/pipelines/* endpoints, WebSocket events
src/web/public/app.js           # Add pipeline view tab/panel
src/web/public/style.css        # Pipeline view styles
src/web/public/index.html       # Pipeline view container
src/mcp/server.ts               # Add orcha_pipeline_status tool
```

## Milestones

---

### M1: Pipeline Types, Config & State Machine

**Intent**: Define the type system, configuration schema (including per-stage model/budget mapping), and core state machine that everything else builds on. No agent execution yet — just the skeleton.

**Key files created**:
- `src/pipeline/types.ts` — PipelineState, PipelineRun, StageResult, GateVerdict, Blueprint, UsageSnapshot, LearningRecord, ModelConfig, BudgetConfig
- `src/pipeline/pipeline-config.ts` — Zod schema for PipelineConfig with defaults (including models + budgets per stage)
- `src/pipeline/pipeline-store.ts` — CRUD for `~/.orcha/pipelines/{id}/state.json`
- `src/pipeline/pipeline-engine.ts` — State machine with transition validation (no stage execution)
- `src/pipeline/index.ts` — Public exports

**Key files modified**:
- `src/core/types.ts` — Add `ephemeral?: boolean` to SessionConfig

**Verification**:
```bash
npm run build                    # Compiles clean
npm test -- --grep pipeline      # State machine transition tests pass
# Manual: create pipeline, verify state.json written, verify transitions
```

---

### M2: Stage Runner & Architect Agent

**Intent**: Build the stage runner that creates ephemeral sessions (with per-stage model selection and `--append-system-prompt` for pipeline instructions) and the architect stage that produces blueprints.

**Key design decisions**:
- Worktree created BEFORE architect runs (so architect sees source branch code).
- Architect runs in the worktree with read-only tools (`--allowedTools "Read,Grep,Glob"`).
- All pipeline agents use `-p` (print mode) + `--dangerously-skip-permissions` for autonomous operation.
- CLAUDE.md: Not touched. Claude Code reads it automatically from the worktree.
- Pipeline instructions: Injected via `--append-system-prompt` (additive, not replacing).
- Blueprint output: Use `--json-schema` for structured architect output.
- Model: Resolved from PipelineConfig per stage (e.g., `opus` for architect).
- Budget: `--max-budget-usd` passed per session from config.
- Work item ACs: Parsed from issue body (looks for "Acceptance Criteria", checkboxes, "## AC" patterns). Full issue body also passed to architect for reasoning.

**Key files created**:
- `src/pipeline/stage-runner.ts` — Creates ephemeral session with: `--model`, `--append-system-prompt`, `--max-budget-usd`, `-p` (for non-interactive stages). Waits for completion, cleans up.
- `src/pipeline/prompt-builder.ts` — Assembles prompts with codebase context (tree, key files, conventions, learning hints)
- `src/pipeline/stages/architect.ts` — Architect prompt + `--json-schema` for blueprint validation

**Key files modified**:
- `src/pipeline/pipeline-engine.ts` — Wire architect stage execution
- `src/cli/index.ts` — Add `orcha pipeline run` command (architect-only for now), including `--model-*` overrides

**Verification**:
```bash
npm run build
orcha pipeline run --description "Add a health check endpoint" --ac "GET /health returns 200"
# Pipeline creates, architect session spawns with --model opus
# CLAUDE.md from repo is respected (build gotchas, etc.)
# Pipeline pauses at checkpoint:arch
cat ~/.orcha/pipelines/*/blueprint.json   # Valid JSON with approach + files
```

---

### M3: Dev Stage (Single Mode)

**Intent**: Dev agent takes blueprint and implements changes in a fresh worktree. Auto-commits before advancing to gate.

**Key design decisions**:
- Reuses worktree created before architect stage (already on correct source branch).
- Blueprint delivered via `--append-system-prompt` (project CLAUDE.md read automatically from worktree).
- Uses `-p` + `--dangerously-skip-permissions` for autonomous operation.
- On session completion: pipeline auto-runs `git add -A && git commit -m "pipeline: dev agent implementation"` in the worktree. This ensures gate reviews a clean commit diff and fix loop starts from a clean state.

**Key files created**:
- `src/pipeline/stages/dev.ts` — Dev stage: creates worktree, creates session with blueprint, waits for completion, auto-commits

**Key files modified**:
- `src/pipeline/pipeline-engine.ts` — Wire dev stage after architect checkpoint

**Verification**:
```bash
npm run build
# After approving architect checkpoint:
# Dev session spawns in fresh worktree on pipeline/42 branch
# Session completes → auto-commit
git -C ~/.orcha/worktrees/*/pipeline-*/  log --oneline -1   # Shows auto-commit
git -C ~/.orcha/worktrees/*/pipeline-*/  diff main --stat    # Shows changes vs base
```

---

### M4: Gate — Test Runner, Lint & AC Validator

**Intent**: Minimum viable gate with the three most critical checks: do tests pass, is lint clean on changed code, and do changes meet acceptance criteria.

**Key files created**:
- `src/pipeline/stages/gate.ts` — Runs gate agents in parallel, collects verdicts
- `src/pipeline/gate-agents/test-runner.ts` — Runs configured test command (default: `npm test`), captures output. Shell-only, no AI.
- `src/pipeline/gate-agents/lint-runner.ts` — Runs lint scoped to changed files only. Shell-only, no AI.
  - Discovers lint command: `npm run lint` from package.json, or falls back to `npx eslint`
  - Scopes to changed files: `git diff --name-only origin/{sourceBranch}... -- '*.ts' '*.js' '*.tsx' '*.jsx'`
  - Strict mode: `--max-warnings 0` — any warning in changed code = gate failure
  - Reports: file, line, rule, severity for each finding
- `src/pipeline/gate-agents/ac-validator.ts` — Claude session (model from config, default sonnet) that compares diff to ACs

**Key files modified**:
- `src/pipeline/pipeline-engine.ts` — Wire gate stage

**Verification**:
```bash
npm run build
# After dev stage completes:
# Gate spawns test-runner (runs npm test in worktree) — shell, no AI
# Gate spawns lint-runner (runs eslint on changed files) — shell, no AI
# Gate spawns ac-validator (Claude session reads diff + ACs)
# gate-results/{test-runner,lint,ac-validator}.json written with pass/fail
# verdict.json aggregated
cat ~/.orcha/pipelines/*/gate-results/verdict.json
cat ~/.orcha/pipelines/*/gate-results/lint.json    # Shows per-file warnings
```

---

### M5: Fix Loop

**Intent**: On gate failure, spawn a fresh dev session with failure context, retry up to N times.

**Key files created**:
- `src/pipeline/stages/fix-loop.ts` — Builds failure report, spawns fresh session, re-runs gate

**Key files modified**:
- `src/pipeline/pipeline-engine.ts` — Wire fix loop: gate fail → fix → re-gate → (pass|retry|escalate)

**Verification**:
```bash
npm run build
# Introduce a deliberate test failure in the worktree
# Gate fails → fix loop spawns fresh session with failure report
# Fix agent corrects the issue → gate re-runs
# After max retries: pipeline state → escalated
```

---

### M6: Checkpoints (Human Approval)

**Intent**: Pause pipeline at architect and pre-ship stages. Provide approve/reject/feedback via CLI and API. Add pause/resume support for `orcha stop`.

**Key design decisions**:
- Checkpoint:arch supports three actions: approve, reject, feedback.
- "Feedback" re-runs the architect agent with the original prompt + user's feedback text (costs 1 additional AI call). Blueprint is replaced with the new output.
- Checkpoint:ship supports: approve, reject.
- `orcha stop` during any active stage → pipeline state set to `paused`, active sessions killed, worktrees preserved. `orcha pipeline resume <id>` restarts from the paused stage.

**Key files created**:
- `src/pipeline/checkpoint.ts` — Checkpoint state management, approve/reject/feedback operations, pause/resume

**Key files modified**:
- `src/pipeline/pipeline-engine.ts` — Pause at checkpoint states, resume on approval, handle `paused` state
- `src/cli/index.ts` — Add `orcha pipeline approve/reject/feedback/resume/list/status <id>`

**Verification**:
```bash
npm run build
orcha pipeline list                                    # Shows pipelines with current state
orcha pipeline status <id>                             # Shows stage, blueprint, gate results
orcha pipeline approve <id>                            # Advances past checkpoint
orcha pipeline reject <id>                             # Sets state to cancelled
orcha pipeline feedback <id> "also handle edge case X" # Re-runs architect with feedback
orcha pipeline resume <id>                             # Resumes paused pipeline
```

---

### M7: Ship Stage

**Intent**: Commit changes, push branch, create PR with structured body.

**Key files created**:
- `src/pipeline/stages/ship.ts` — Git commit + push + VcsProvider.createPullRequest

**Key files modified**:
- `src/pipeline/pipeline-engine.ts` — Wire ship stage after checkpoint:ship approval

**Verification**:
```bash
npm run build
# After approving ship checkpoint:
# Ship stage commits with message referencing work item
# Pushes to remote
# Creates PR with: summary, gate results, work item link
orcha pipeline status <id>    # Shows completed state with PR URL
```

---

### M8: Token Usage Tracking

**Intent**: Track token consumption per pipeline stage and total.

**Key files created**:
- `src/pipeline/usage-tracker.ts` — Reads stats-cache.json, computes deltas, stores per-stage

**Key files modified**:
- `src/pipeline/stage-runner.ts` — Wrap stage execution with usage snapshots
- `src/pipeline/pipeline-engine.ts` — Include usage in pipeline state

**Verification**:
```bash
npm run build
# Run a full pipeline
cat ~/.orcha/pipelines/*/usage.json
# Shows per-stage token counts + total + estimated cost
```

---

### M9: Adversary Gate Agent

**Intent**: A gate agent that tries to break the dev agent's code by writing adversarial tests.

**Key design decisions**:
- Adversary writes tests to a TEMP directory (not the worktree). Tests are run against the worktree code but discarded after.
- If adversary's own tests fail to compile/run (buggy tests), that counts as adversary-pass (couldn't break it).
- Only tests that compile AND fail against the dev's code count as gate failures.
- Adversary gets the commit diff + existing test patterns as context.

**Key files created**:
- `src/pipeline/gate-agents/adversary.ts` — Prompt: "Write tests that expose bugs in this diff". Runs in temp dir, executes against worktree, reports results.

**Key files modified**:
- `src/pipeline/stages/gate.ts` — Include adversary in gate agent list
- `src/pipeline/pipeline-config.ts` — Add adversary to default gate agents

**Verification**:
```bash
npm run build
# Run pipeline with adversary enabled
cat ~/.orcha/pipelines/*/gate-results/adversary.json
# Shows: tests written, which compiled, which passed/failed, edge cases found
ls /tmp/orcha-adversary-*/    # Temp test dir (cleaned up after gate)
```

---

### M10: Security & Code Review Gate Agents

**Intent**: Add remaining gate agents for comprehensive review.

**Key files created**:
- `src/pipeline/gate-agents/security-review.ts` — OWASP top 10 + dependency check prompt
- `src/pipeline/gate-agents/code-review.ts` — Project conventions + correctness prompt

**Key files modified**:
- `src/pipeline/stages/gate.ts` — Register new agents
- `src/pipeline/pipeline-config.ts` — Add to default gate list

**Verification**:
```bash
npm run build
cat ~/.orcha/pipelines/*/gate-results/security.json
cat ~/.orcha/pipelines/*/gate-results/code-review.json
```

---

### M11: Competing Dev Agents

**Intent**: Run N dev agents in parallel with separate worktrees, gate picks the best.

**Key files modified**:
- `src/pipeline/stages/dev.ts` — Competing mode: create N sessions with N worktrees
- `src/pipeline/stages/gate.ts` — Run gate on each competing result, pick highest-scoring
- `src/pipeline/pipeline-engine.ts` — Clean up losing worktrees after gate selection

**Verification**:
```bash
npm run build
orcha pipeline run --description "..." --competing 3
# 3 dev sessions spawn in parallel
# Gate runs on all 3
# Best result selected, other worktrees cleaned up
orcha pipeline status <id>   # Shows which agent won + comparative scores
```

---

### M12: Web Dashboard Pipeline View

**Intent**: Pipeline progress panel in the web dashboard with stage indicators, session drill-in, and checkpoint controls.

**Key files modified**:
- `src/web/server.ts` — Add `/api/pipelines`, `/api/pipelines/:id`, `/api/pipelines/:id/approve`, `/api/pipelines/:id/reject`, WebSocket pipeline events
- `src/web/public/app.js` — Pipeline view: stage progress bar, active sessions, gate verdicts, approve/reject buttons, usage display
- `src/web/public/style.css` — Pipeline stage indicators, verdict cards, checkpoint UI
- `src/web/public/index.html` — Pipeline view container

**Verification**:
```bash
npm run build && cp src/web/public/{app.js,style.css,index.html} dist/web/public/
# Web dashboard shows pipeline tab
# Pipeline view shows: stage progress, active sessions, gate results
# Checkpoint stages show approve/reject buttons
# Token usage shown per stage and total
# Can drill into active session terminals
```

---

### M13: Learning Loop

**Intent**: Record pipeline outcomes and feed successful patterns back into architect prompts.

**Key files created**:
- `src/pipeline/learning-store.ts` — Append-only JSON store of pipeline outcomes

**Key files modified**:
- `src/pipeline/pipeline-engine.ts` — Record outcome on completion/failure
- `src/pipeline/stages/architect.ts` — Query learning store for relevant hints
- `src/pipeline/prompt-builder.ts` — Include learning hints in architect prompt

**Verification**:
```bash
npm run build
# Run several pipelines
cat ~/.orcha/pipelines/learning.json
# Shows: [{workItemType, approach, gateScores, fixLoops, outcome, timestamp}, ...]
# Subsequent architect prompts include hints from past successes/failures
```

---

## Risks & Unknowns

| Risk | Impact | Quick Probe |
|------|--------|------------|
| Agent output parsing: Claude may not produce valid JSON blueprints reliably | Blueprint stage fails | M2: Test with 5 different work item types. Use structured output hints in prompt + JSON extraction with fallback regex. |
| Session completion detection: How to know when an agent is truly "done" vs still thinking? | Pipeline hangs | M2: Rely on Claude Code's exit behavior + StatusMonitor `done` state. Add timeout (configurable, default 15min per stage). |
| Worktree conflicts in competing mode: Multiple agents on overlapping branches | Git errors | M11: Each competing agent gets a unique branch name (`pipeline-{id}-dev-{n}`). No shared branches. |
| stats-cache.json not updating in real-time | Usage tracking inaccurate | M8: Test how frequently Claude Code flushes to stats-cache. If too slow, add delay before reading post-snapshot. |
| Gate agent prompts need tuning per project type | False positives/negatives in gate | M4+M9: Start with lenient thresholds, tighten via learning loop. Make gate prompts configurable in pipeline config. |
| Fix loop context: fresh session lacks knowledge of what was tried | Repeated failures | M5: Include full history of previous attempts + their gate failures in the fix prompt. |
| Pipeline state corruption on crash | Pipeline stuck | M1: Write state atomically (write-then-rename). Add `orcha pipeline recover` command. |
| Concurrent pipelines on same repo | Branch conflicts | M1: Pipeline IDs include timestamp. Enforce max 1 active pipeline per instance (configurable). |
| `--append-system-prompt` length limits: Very large blueprints may exceed CLI arg limits | Prompt truncated | M2: Test with large blueprints. If too long, write to temp file and use `cat blueprint.json | claude -p --append-system-prompt "..."` with piped input instead. |
| `--json-schema` reliability: Claude may not always produce valid JSON matching schema | Architect output parsing fails | M2: Add retry (up to 2) on schema validation failure. Use lenient schema with required fields only. |
| Model availability: User may not have access to all models (e.g., Opus) | Pipeline fails to start | M1: Validate model access on pipeline start. Fall back to `default` model if specific model unavailable. |
| `--max-budget-usd` behavior: Session may stop mid-task when budget exhausted | Incomplete stage output | M2: Set budgets with headroom (2x expected). Monitor and adjust via learning loop. |
| Auto-commit after dev stage: `git add -A` may stage unintended files (.env, node_modules) | Secrets or junk committed | M3: Use `.gitignore` from repo (inherited by worktree). Add pipeline-specific exclusions. Review diff at checkpoint:ship before push. |
| Project has no tests: test-runner gate fails or is meaningless | False pass or error | M4: Detect if test command exists in package.json. If missing, skip test-runner and log warning. Gate still runs other agents. |
| Architect re-run on feedback: could produce completely different blueprint | Wasted dev work if already approved once | M6: Feedback only available at checkpoint:arch BEFORE dev starts. Once approved, no re-run possible. |

---

Next: `/probe 'M1: Pipeline Types, Config & State Machine'`
