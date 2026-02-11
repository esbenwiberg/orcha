# Blueprint: Simplify Pipeline Fix Loop — Per-Gate Specialized Fix Agents

## Goal

Redesign the gate→fix handoff so that **each failed gate check spawns its own specialized fix agent** with clean, plain-text instructions (raw error output + task description + diff). Replace the current "one fix agent tries to fix everything from a massive structured prompt" approach with focused, sequential per-gate fixes followed by a single re-gate.

**Milestones: 6**

## Non-Goals

- Changing the architect or dev stages (they work fine)
- Removing any gate agents (keep all 7: test, lint, build, AC-validator, adversary, security, code-review)
- Changing the state machine transitions (gate → fix-loop → gate stays the same)
- Rewriting the competing agents system
- Changing the ship/checkpoint stages

## Acceptance Criteria

1. Each failed gate check spawns its own fix agent session (not one combined fix agent)
2. Fix agents run sequentially in priority order: test → build → lint → code-review → security → adversary → AC-validator
3. Fix agents receive plain-text input: raw error output + task description + diff (no blueprint JSON, no enhanced context objects)
4. Gate agents output a standardized `ActionableFinding` format: file, line, issue, suggested fix — as plain text
5. Shell gate agents (test, lint, build) pass full terminal output to fix agents (no 4000-char truncation)
6. Circuit breaker remains: if the same gate check fails with the same pattern twice, that check's fix is skipped and escalated
7. Failure pattern store, enhanced context builder, and attempt tracker are removed
8. A single re-gate runs after all per-gate fixes complete
9. Fix prompt templates exist per gate type (test-fix.yaml, security-fix.yaml, etc.)
10. Existing escalation UI actions (skip-gate, retry-with-feedback, etc.) continue to work

## Architecture

### Current Flow (broken)
```
gate (7 agents) → aggregate all failures → one fix agent gets everything → usually fails → escalate
```

### New Flow
```
gate (7 agents, each outputs ActionableFindings)
  → for each failed check (in priority order):
      spawn specialized fix agent (raw output + diff + task)
  → single re-gate
  → if still failing: next fix-loop iteration (same per-gate approach)
  → after N iterations: escalate
```

### Key Design Decisions

1. **Sequential per-gate fixes, not parallel**: Fixes run one after another so each sees the previous fix's changes. Test fix runs first because test failures are most concrete/actionable.

2. **Raw output, not structured JSON**: Fix agents get what a developer would see — terminal output, diff, and task description. No blueprint, no enhanced context trees, no pattern store examples.

3. **Standardized gate output**: Every gate agent produces findings as plain text with a consistent format. This serves both fix agents and human investigation in the UI.

4. **One re-gate per fix-loop iteration**: After all per-gate fixes run, the whole gate re-runs. This catches regressions (fix for test broke lint) in the same iteration.

5. **Simple circuit breaker**: Per-check tracking. If test fails with the same signature twice, skip test-fix on the next iteration and escalate that specific check.

## File Layout (key changes)

```
src/pipeline/
├── types.ts                         # Add ActionableFinding, update GateResult
├── stages/
│   ├── gate.ts                      # Update to use ActionableFinding output format
│   └── fix-loop.ts                  # REWRITE: per-gate sequential fixes
├── gate-agents/
│   ├── test-runner.ts               # Output ActionableFindings, full output (no truncation)
│   ├── lint-runner.ts               # Output ActionableFindings
│   ├── build-runner.ts              # Output ActionableFindings
│   ├── ac-validator.ts              # Output ActionableFindings
│   ├── adversary.ts                 # Output ActionableFindings
│   ├── security-review.ts           # Output ActionableFindings
│   └── code-review.ts              # Output ActionableFindings
├── fix-loop/
│   ├── circuit-breaker.ts           # Simplify to per-check tracking
│   ├── per-gate-fixer.ts            # NEW: spawns per-gate fix agents
│   ├── context-builder.ts           # DELETE
│   └── attempt-tracker.ts           # DELETE
├── learning/
│   └── failure-patterns.ts          # DELETE
└── prompt-builder.ts                # Add per-gate fix prompt builders

prompts/defaults/
├── fix-test.yaml                    # NEW: test-specific fix prompt
├── fix-build.yaml                   # NEW: build-specific fix prompt
├── fix-lint.yaml                    # NEW: lint-specific fix prompt
├── fix-code-review.yaml             # NEW: code-review fix prompt
├── fix-security.yaml                # NEW: security fix prompt
├── fix-adversary.yaml               # NEW: adversary fix prompt
├── fix-ac-validator.yaml            # NEW: AC-validator fix prompt
└── fix-loop.yaml                    # KEEP as fallback/generic
```

## Milestones

### M1: Standardize Gate Agent Output Format

**Intent**: Define `ActionableFinding` type and update all 7 gate agents to output findings in a consistent plain-text format alongside the existing GateResult.

**Key files**:
- `src/pipeline/types.ts` — add `ActionableFinding` interface
- `src/pipeline/gate-agents/test-runner.ts` — add `findings` and `rawOutput`, remove 4000-char truncation
- `src/pipeline/gate-agents/build-runner.ts` — add `findings` and `rawOutput`
- `src/pipeline/gate-agents/lint-runner.ts` — add `findings` and `rawOutput`
- `src/pipeline/gate-agents/code-review.ts` — format findings as ActionableFindings
- `src/pipeline/gate-agents/security-review.ts` — format findings as ActionableFindings
- `src/pipeline/gate-agents/adversary.ts` — format findings as ActionableFindings
- `src/pipeline/gate-agents/ac-validator.ts` — format findings as ActionableFindings

**Details**:

New type in `types.ts`:
```typescript
export interface ActionableFinding {
  /** File path (if applicable, empty string for general issues) */
  file: string
  /** Line number (0 if not applicable) */
  line: number
  /** What's wrong — one sentence */
  issue: string
  /** How to fix it — one sentence suggestion */
  suggestedFix: string
  /** Severity level */
  severity: Severity
}
```

Extend `GateResult` to include:
```typescript
export interface GateResult {
  // ... existing fields ...
  /** Standardized findings for fix agents and human review */
  findings: ActionableFinding[]
  /** Raw output from the check (terminal output for shell agents, full text for AI agents) */
  rawOutput: string
}
```

For shell agents (test, lint, build): `rawOutput` = full terminal output (no truncation, but capped at 50KB for sanity). `findings` = parsed from output where possible (e.g., test names that failed), otherwise a single finding with the issue summary.

For AI agents: instruct them to output findings in the ActionableFinding format. `rawOutput` = the full AI response text.

**Verification**:
- `npm run build` succeeds
- Existing gate tests pass (if any)
- Manual: run a pipeline, check gate-results/*.json files contain `findings` and `rawOutput` fields

---

### M2: Create Per-Gate Fix Prompt Templates

**Intent**: Create focused, minimal prompt templates for each gate type. Each template gives the fix agent exactly what it needs — the raw error output, the diff, and the task — nothing more.

**Key files**:
- `prompts/defaults/fix-test.yaml` — NEW
- `prompts/defaults/fix-build.yaml` — NEW
- `prompts/defaults/fix-lint.yaml` — NEW
- `prompts/defaults/fix-code-review.yaml` — NEW
- `prompts/defaults/fix-security.yaml` — NEW
- `prompts/defaults/fix-adversary.yaml` — NEW
- `prompts/defaults/fix-ac-validator.yaml` — NEW
- `src/pipeline/prompt-builder.ts` — add `buildPerGateFixPrompt()` function

**Details**:

Each template follows the same minimal structure. Example for test:
```yaml
name: fix-test
systemPrompt: |
  You are fixing failing tests. Read the test output below, find the root cause, and fix the code.
  Do NOT run tests — the pipeline re-runs them automatically.
  Do NOT commit — the pipeline handles commits.

userPrompt: |
  # Test Output
  {{rawOutput}}

  # What the code is supposed to do
  {{taskDescription}}

  # What was changed (git diff)
  ```diff
  {{diff}}
  ```

  # Specific Findings
  {{#each findings}}
  - {{file}}:{{line}} — {{issue}} → {{suggestedFix}}
  {{/each}}

  Fix the failing tests.
```

Key principle: **system prompt = role + rules (short), user prompt = data (raw output + diff + findings)**. No blueprint. No enhanced context. Just the error and the code.

Template variations per gate type:
- **fix-test**: "You are fixing failing tests" + test output
- **fix-build**: "You are fixing build errors" + build output
- **fix-lint**: "You are fixing lint violations" + lint output
- **fix-code-review**: "You are addressing code review findings" + review findings
- **fix-security**: "You are fixing security vulnerabilities" + security findings
- **fix-adversary**: "You are fixing bugs found by adversarial testing" + adversary results
- **fix-ac-validator**: "You are addressing unmet acceptance criteria" + AC findings

`buildPerGateFixPrompt(checkName, rawOutput, findings, diff, taskDescription)` loads the appropriate template and fills variables.

**Verification**:
- `npm run build` succeeds
- Templates are valid YAML
- `buildPerGateFixPrompt()` returns non-empty systemPrompt and userPrompt for each check type

---

### M3: Implement Per-Gate Fix Runner

**Intent**: Create `per-gate-fixer.ts` that spawns one fix agent per failed gate check, running sequentially in priority order.

**Key files**:
- `src/pipeline/fix-loop/per-gate-fixer.ts` — NEW: core per-gate fix logic
- `src/pipeline/stages/fix-loop.ts` — refactor to use per-gate-fixer
- `src/pipeline/prompt-builder.ts` — wire up `buildPerGateFixPrompt`

**Details**:

New module `per-gate-fixer.ts`:
```typescript
const FIX_PRIORITY = ['test', 'build', 'lint', 'code-review', 'security', 'adversary', 'ac-validator']

export async function runPerGateFixes(
  run: PipelineRun,
  failedResults: GateResult[],
  opts?: FixOptions,
): Promise<{ fixedChecks: string[], skippedChecks: string[] }>
```

Logic:
1. Sort failed gate results by `FIX_PRIORITY` order
2. For each failed check:
   a. Check circuit breaker — if this check has failed with same pattern twice, skip it
   b. Get the current diff from worktree
   c. Build prompt via `buildPerGateFixPrompt(check.checkName, check.rawOutput, check.findings, diff, run.description)`
   d. Spawn Claude session with the prompt (via `runStage()`)
   e. After session completes, auto-commit: `git add -A && git commit -m "fix: {checkName} issues"`
3. Return which checks got fix attempts and which were skipped

The refactored `fix-loop.ts` becomes much simpler:
```typescript
export async function runFixLoopStage(run, opts): Promise<PipelineRun> {
  // 1. Check max retries
  if (run.fixLoopCount >= maxFixLoops) → escalate

  // 2. Get failed checks
  const failed = run.gateResults.filter(r => r.verdict === 'fail')

  // 3. Run per-gate fixes (sequential)
  const { fixedChecks, skippedChecks } = await runPerGateFixes(run, failed, opts)

  // 4. If all checks were skipped (circuit breaker), escalate
  if (fixedChecks.length === 0) → escalate

  // 5. Increment fix loop counter, transition back to gate
  run = await incrementFixLoop(run)
  run = await transition(run, 'gate')
  return run
}
```

**Verification**:
- `npm run build` succeeds
- Run a pipeline with intentional test failures → see per-gate fix agents spawn
- Check logs show sequential execution per check
- Check git log shows per-check commits (`fix: test issues`, `fix: lint issues`, etc.)

---

### M4: Simplify Circuit Breaker to Per-Check Tracking

**Intent**: Refactor the circuit breaker to track failures per gate check instead of overall failure signatures. If "test" fails with the same output pattern twice, skip test-fix and escalate it — but other checks' fixes still run.

**Key files**:
- `src/pipeline/fix-loop/circuit-breaker.ts` — simplify
- `src/pipeline/types.ts` — simplify `CircuitBreakerState`
- `src/pipeline/fix-loop/per-gate-fixer.ts` — use simplified circuit breaker

**Details**:

Simplified circuit breaker:
```typescript
interface PerCheckBreakerState {
  /** checkName → hash of last rawOutput */
  lastFailureHash: Record<string, string>
  /** checkName → consecutive count of same hash */
  consecutiveCount: Record<string, number>
}

// Logic:
// 1. Hash the rawOutput of the failed check (first 1000 chars for stability)
// 2. If hash matches last failure hash for this check → increment count
// 3. If count >= 2 → skip this check's fix, mark as circuit-broken
// 4. If hash is different → reset count to 1
```

Per-check tracking means:
- Test failing twice with same output → skip test fix, escalate test specifically
- Security fix can still run even if test is stuck
- Each check tracked independently

**Verification**:
- `npm run build` succeeds
- Test: same check failing twice → circuit breaker skips its fix
- Test: different checks fail independently without triggering each other

---

### M5: Remove Dead Infrastructure

**Intent**: Delete the failure pattern store, enhanced context builder, and attempt tracker. Clean up imports.

**Key files to DELETE**:
- `src/pipeline/fix-loop/context-builder.ts`
- `src/pipeline/fix-loop/attempt-tracker.ts`
- `src/pipeline/learning/failure-patterns.ts`

**Key files to UPDATE**:
- `src/pipeline/stages/fix-loop.ts` — remove imports of deleted modules
- `src/pipeline/types.ts` — remove `EnhancedFixContext`, `AttemptHistory`, `FailurePattern`, `Fix`, `CompetingFixResult` types
- `src/pipeline/prompt-builder.ts` — remove `enhancedContext` from `FixLoopContext`
- Update the old `fix-loop.yaml` to match the new minimal style (as generic fallback)

**Verification**:
- `npm run build` succeeds with no errors
- `grep -r 'context-builder\|attempt-tracker\|failure-patterns' src/` returns no hits
- Pipeline still runs end-to-end

---

### M6: Update Web Dashboard & Progress Events

**Intent**: Update dashboard to display per-gate fix activity and ActionableFindings. Show which specific check is being fixed in the activity timeline.

**Key files**:
- `src/web/public/app.js` — update fix-loop display for per-gate progress
- `src/web/public/style.css` — styling for per-gate fix display and findings list
- `src/pipeline/fix-loop/per-gate-fixer.ts` — emit per-gate progress events
- `src/pipeline/stages/gate.ts` — include ActionableFindings in progress events

**Details**:

Progress events for per-gate fixes:
```typescript
// Before each per-gate fix:
appendProgress(run.id, {
  type: 'fix-loop',
  title: `Fixing: ${checkName}`,
  detail: `${findings.length} finding(s) to address`,
  data: { checkName, attempt, findings },
})

// After each per-gate fix:
appendProgress(run.id, {
  type: 'fix-loop',
  title: `Fixed: ${checkName}`,
  detail: `Committed ${commitSha}`,
  data: { checkName, commitSha },
})
```

Gate progress events include findings:
```typescript
data: {
  passed,
  results: filteredResults.map(r => ({
    checkName: r.checkName,
    verdict: r.verdict,
    summary: r.summary,
    findings: r.findings,  // NEW
  })),
}
```

Dashboard updates:
- Activity timeline shows per-gate fix status ("Fixing: test → Fixing: lint → ...")
- Gate results display ActionableFindings in a readable list
- Show circuit-breaker-skipped checks with an indicator

**Verification**:
- `npm run build` succeeds
- Copy updated files to `dist/web/public/`
- Manual: run a pipeline, dashboard shows per-gate fix progress
- Manual: gate results show ActionableFindings

---

## Risks & Unknowns

1. **Fix agent context**: Without the blueprint, fix agents only know what broke and what was changed. Mitigated by including task description + acceptance criteria. Probe: test on a few real pipelines.

2. **Sequential fix conflicts**: A security fix might break tests. Mitigated by re-gate after all fixes — regressions caught in next iteration.

3. **Cost per iteration**: 3-4 fix agents instead of 1 costs more per loop. Mitigated by: each is focused and completes faster. Current approach wastes money on fixes that don't work anyway.

4. **Large test output**: Without 4000-char truncation, output could be 50KB+. Cap `rawOutput` at 50KB. Probe: check typical sizes in existing runs.

5. **AI gate agent output quality**: Getting agents to reliably produce ActionableFindings needs prompt testing. Probe: test updated gate prompts on a few diffs.
