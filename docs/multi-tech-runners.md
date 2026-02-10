# Blueprint: Multi-Tech Stack Runner Support

## Goal

Make all pipeline runners (test, lint, build) and the adversary agent tech-agnostic so they work with any repo — TypeScript, .NET, Python, or mixed-tech repos (e.g., a .NET backend with a TypeScript client subfolder). Introduce a shared **tech scanner** that detects what technologies exist at what paths, and feed that into each runner so they know how to test, lint, and build for each detected stack.

## Non-Goals

- **IDE/editor integration** — out of scope
- **New gate agents beyond build** (e.g., type-check runner) — future agents can use the scanner later
- **Auto-installing toolchains** — we detect what's available, we don't install dotnet/python/node for the user
- **Monorepo sub-project isolation** — we support mixed-tech in one repo, but don't detect and run 5 independent package.json projects separately (scan root + 1 level deep only)
- **Go/Rust/Java support** — sticking to the three requested stacks (Node, .NET, Python) for now; architecture supports adding more later

## Acceptance Criteria

- [ ] A `detectTechStacks(worktreePath)` function scans a repo and returns an array of detected tech stacks with their root paths and tooling info
- [ ] Tech stacks detected: TypeScript/JavaScript (package.json), .NET (*.csproj/*.sln), Python (pyproject.toml/setup.py/requirements.txt)
- [ ] Test runner runs the correct test command for each detected tech (npm test, dotnet test, pytest)
- [ ] Lint runner runs the correct lint command per tech (eslint for JS/TS, dotnet format --verify-no-changes for .NET, ruff/flake8 for Python)
- [ ] Changed-file detection in git-utils supports extensions for all three stacks
- [ ] Adversary agent detects project tech and writes tests in the appropriate language/framework
- [ ] A build runner gate agent is added that runs build per tech (npm run build, dotnet build, skip for Python unless configured)
- [ ] Mixed-tech repos (e.g., .NET root + TypeScript in `client/`) get all relevant runners executed
- [ ] All runners produce the same `GateResult` interface — no type changes needed
- [ ] Existing JS/TS-only repos continue to work identically (no regression)
- [ ] Pipeline config gains a `gate:build-runner` model key (value: 'shell')

## Architecture

### Core Concept: Tech Scanner as Shared Foundation

```
┌─────────────────────────────────────┐
│          Tech Scanner               │
│  detectTechStacks(worktreePath)     │
│  → TechStack[]                      │
└──────────┬──────────────────────────┘
           │
     ┌─────┴──────┬──────────────┬──────────────┐
     │            │              │              │
  test-runner  lint-runner  build-runner  adversary
  (per stack)  (per stack)  (per stack)  (picks best)
```

### TechStack Interface

```typescript
interface TechStack {
  type: 'node' | 'dotnet' | 'python'
  /** Relative path from worktree root to the tech root ('' for root, 'client' for subfolder) */
  rootPath: string
  /** Absolute path to the tech root directory */
  absolutePath: string
  /** What was detected (e.g., 'package.json', 'MyApp.sln', 'pyproject.toml') */
  detectedVia: string
  /** Available commands detected */
  commands: {
    test?: string       // e.g. 'npm test', 'dotnet test', 'pytest'
    lint?: string       // e.g. 'npm run lint', 'dotnet format --verify-no-changes', 'ruff check'
    build?: string      // e.g. 'npm run build', 'dotnet build'
  }
  /** File extensions relevant to this stack */
  lintableExtensions: string[]
}
```

### Design Decision: One Runner Per Concern, Multi-Stack Inside

**NOT** per-tech runners (DotnetTestRunner, PythonTestRunner). Instead, each runner (test, lint, build) internally loops over `TechStack[]` and runs the correct command per stack.

Rationale:
1. **Simpler gate stage** — still 6+1 agents, no explosion of agents per tech
2. **Unified GateResult** — one test-runner result aggregates all stacks
3. **New techs = just add to scanner** — runners don't need new files
4. **Mixed-tech handling natural** — scanner returns 2 stacks, runner loops both

### Data Flow

```
gate.ts
  → detectTechStacks(worktreePath)  (called once)
  → pass TechStack[] to each runner

test-runner:  for each stack → run stack.commands.test → aggregate results
lint-runner:  for each stack → get changed files by stack extensions → run lint → aggregate
build-runner: for each stack → run stack.commands.build → aggregate
adversary:    pick primary stack → adjust test patterns/language in prompt
```

## Key Files

### New Files
- `src/pipeline/tech-scanner.ts` — Tech detection logic + TechStack type
- `src/pipeline/gate-agents/build-runner.ts` — New build runner gate agent

### Modified Files
- `src/pipeline/gate-agents/test-runner.ts` — Accept TechStack[], run per-stack
- `src/pipeline/gate-agents/lint-runner.ts` — Accept TechStack[], lint per-stack with correct tool
- `src/pipeline/gate-agents/adversary.ts` — Use TechStack to pick language for test generation
- `src/pipeline/git-utils.ts` — Generalize `getChangedLintableFiles` to accept extensions param
- `src/pipeline/stages/gate.ts` — Call tech scanner, pass stacks to runners, add build-runner
- `src/pipeline/types.ts` — Add ModelStageKey for `gate:build-runner`
- `src/pipeline/pipeline-config.ts` — Add `gate:build-runner: 'shell'` default

## Milestones

### M1: Tech Scanner
**Intent:** Create the shared tech detection module that all runners will consume.

**Key files:** `src/pipeline/tech-scanner.ts`

**Details:**
1. Create `src/pipeline/tech-scanner.ts` with:
   - `TechStack` interface (type, rootPath, absolutePath, detectedVia, commands, lintableExtensions)
   - `detectTechStacks(worktreePath: string): TechStack[]` function
2. Node detection:
   - Look for `package.json` at root and one level deep (e.g., `client/package.json`)
   - Exclude `node_modules/` paths
   - Read scripts to detect test/lint/build commands
   - Check dependencies for eslint (fallback lint)
   - Extensions: `.ts`, `.js`, `.tsx`, `.jsx`, `.mjs`, `.cjs`
3. .NET detection:
   - Look for `*.sln` at root, then `*.csproj` at root and one level deep
   - Test command: `dotnet test` (always available with SDK)
   - Lint: `dotnet format --verify-no-changes`
   - Build: `dotnet build`
   - Extensions: `.cs`, `.fs`, `.vb`
4. Python detection:
   - Look for `pyproject.toml`, `setup.py`, `setup.cfg`, `requirements.txt` at root
   - Test: check if pytest is in deps → `pytest`, else `python -m pytest`
   - Lint: check for ruff → `ruff check .`, else check for flake8 → `flake8`, else skip
   - Build: `python -m build` only if pyproject.toml has `[build-system]`
   - Extensions: `.py`, `.pyi`
5. Return all detected stacks (a mixed repo returns multiple entries)

**Verification:**
```bash
npx tsc --noEmit src/pipeline/tech-scanner.ts
```

---

### M2: Generalize git-utils for Multi-Tech Extensions
**Intent:** Make changed-file detection work with any set of extensions, not just JS/TS.

**Key files:** `src/pipeline/git-utils.ts`

**Details:**
1. Add a new exported function `getChangedFilesByExtensions(worktreePath, sourceBranch, extensions: string[], baseCommit?)` that accepts a list of extensions (e.g. `['.cs', '.fs']`)
2. Builds git diff glob patterns from extensions: `'*.cs' '*.fs'`
3. Uses the same multi-strategy diff approach (baseCommit → origin/branch → branch → HEAD)
4. Refactor `getChangedLintableFiles` to call the new function with `['.ts', '.js', '.tsx', '.jsx']` (backward compat, same behavior)

**Verification:**
```bash
npx tsc --noEmit src/pipeline/git-utils.ts
```

---

### M3: Multi-Tech Test Runner
**Intent:** Make test-runner accept TechStack[] and run tests for each detected stack.

**Key files:** `src/pipeline/gate-agents/test-runner.ts`

**Details:**
1. Change `runTestRunner` signature to `runTestRunner(worktreePath: string, techStacks?: TechStack[])`
2. If `techStacks` provided and non-empty:
   - For each stack with `commands.test`, run the command with cwd = `stack.absolutePath`
   - Collect per-stack results
3. If `techStacks` not provided (backward compat), fall back to current `detectTestCommand` logic
4. Aggregate verdict: any fail → 'fail', all skip → 'skip', else 'pass'
5. Details include per-stack breakdown: `{ stacks: [{ type: 'node', path: '.', status: 'pass', output: '...' }] }`
6. Preserve existing timeout (5 min per stack)

**Verification:**
```bash
npx tsc --noEmit src/pipeline/gate-agents/test-runner.ts
```

---

### M4: Multi-Tech Lint Runner
**Intent:** Make lint-runner accept TechStack[] and lint with the correct tool per stack.

**Key files:** `src/pipeline/gate-agents/lint-runner.ts`

**Details:**
1. Change signature to include `techStacks?: TechStack[]`
2. If stacks provided, for each stack with `commands.lint`:
   - Get changed files filtered by stack's `lintableExtensions` (use new `getChangedFilesByExtensions`)
   - Handle command differences:
     - **Node:** existing behavior — `npm run lint -- {files}` or `npx eslint {files}`
     - **.NET:** `dotnet format --verify-no-changes` in stack's absolutePath (no file list — it operates on the project)
     - **Python:** `ruff check {files}` or `flake8 {files}`
   - Parse output per-tech (eslint parser for node, generic for others)
3. If no stacks, fall back to current behavior
4. Aggregate across stacks (any fail → fail, all skip → skip)

**Verification:**
```bash
npx tsc --noEmit src/pipeline/gate-agents/lint-runner.ts
```

---

### M5: Build Runner Gate Agent
**Intent:** Add a new shell-only gate agent that runs build commands per tech stack.

**Key files:** `src/pipeline/gate-agents/build-runner.ts`, `src/pipeline/types.ts`, `src/pipeline/pipeline-config.ts`

**Details:**
1. Create `src/pipeline/gate-agents/build-runner.ts`:
   - `runBuildRunner(worktreePath: string, techStacks?: TechStack[]): Promise<GateResult>`
   - For each stack with `commands.build`, run it in `stack.absolutePath`
   - Timeout: 5 minutes per stack
   - Any build failure = fail, all skip (no build command) = skip, else pass
   - Details include per-stack results
2. Add `'gate:build-runner'` to `ModelStageKey` union in `types.ts`
3. Add `'gate:build-runner': z.string().optional()` to ModelConfigSchema in `pipeline-config.ts`
4. Add `'gate:build-runner': 'shell'` to default model config

**Verification:**
```bash
npx tsc --noEmit src/pipeline/gate-agents/build-runner.ts
npx tsc --noEmit src/pipeline/types.ts
npx tsc --noEmit src/pipeline/pipeline-config.ts
```

---

### M6: Wire Tech Scanner into Gate Stage
**Intent:** Connect everything — gate stage calls tech scanner, passes stacks to all runners, adds build-runner to the parallel agent set.

**Key files:** `src/pipeline/stages/gate.ts`

**Details:**
1. Import `detectTechStacks` from `../tech-scanner.js`
2. Import `runBuildRunner` from `../gate-agents/build-runner.js`
3. In `runSingleGateStage`, at the top:
   - `const techStacks = detectTechStacks(run.worktreePath)`
4. Update the `Promise.all` to:
   - Pass `techStacks` to `runTestRunner(run.worktreePath, techStacks)`
   - Pass `techStacks` to `runLintRunner(run.worktreePath, run.sourceBranch, run.baseCommit, techStacks)`
   - Add `runBuildRunner(run.worktreePath, techStacks)` with skip check
5. Update results array to include build result
6. Same changes in `evaluateCompetitor` for competing mode
7. Update `GATE_CHECK_NAMES` to include `'build'`

**Verification:**
```bash
npx tsc --noEmit src/pipeline/stages/gate.ts
```

---

### M7: Tech-Aware Adversary
**Intent:** Make the adversary agent aware of project tech so it writes tests in the right language.

**Key files:** `src/pipeline/gate-agents/adversary.ts`, `src/pipeline/prompt-builder.ts`

**Details:**
1. Update `runAdversary` to accept `techStacks?: TechStack[]`
2. Pick the "primary" stack (first one, or the one matching the most changed files)
3. Update `getTestPatterns` to search for tech-appropriate patterns:
   - Node: `*.test.ts`, `*.spec.ts`, `*.test.js`, `*.spec.js` (existing)
   - .NET: `*Tests.cs`, `*Test.cs` in test directories
   - Python: `test_*.py`, `*_test.py`
4. Pass tech type to `buildAdversaryPrompt` — add a `techType` param
5. In the adversary prompt, include the detected tech so Claude writes tests in the right language
6. Update `executeTests` to use the right runner:
   - Node: `npx tsx` (existing)
   - Python: `pytest {testPath}` or `python {testPath}`
   - .NET: skip adversary test execution for now (known limitation — .NET tests need a project context to compile)

**Verification:**
```bash
npx tsc --noEmit src/pipeline/gate-agents/adversary.ts
npx tsc --noEmit src/pipeline/prompt-builder.ts
```

---

### M8: Full Build Verification
**Intent:** Ensure everything compiles and existing behavior is preserved.

**Key files:** All modified files

**Details:**
1. Run `npx tsc --noEmit` — full project must compile clean
2. Run `npm run build` — dist output must succeed
3. Manually verify the tech scanner detects Orcha itself as a node project
4. Review all imports/exports are wired correctly
5. Verify no regressions: when `detectTechStacks` returns only a node stack, behavior is identical to before

**Verification:**
```bash
npx tsc --noEmit
npm run build
```

## Risks & Probes

| Risk | Mitigation |
|------|------------|
| `dotnet format` may not be available on all machines | Included in .NET 6+ SDK. If command fails, lint runner treats as skip (not fail). |
| `ruff` or `flake8` not installed in target repo | Scanner checks deps. If neither found, Python lint command is `undefined` → runner skips. |
| Mixed-tech lint may be noisy | Each linter only runs on its own file extensions. A .cs file never hits eslint. |
| Adversary test execution for .NET is complex | Start with skip for .NET adversary tests. Known limitation, can enhance later. |
| `package.json` in subdirectory misdetected | Only scan 1 level deep. Exclude `node_modules/` paths. |
| Build runner may be slow for large .NET projects | 5 min timeout. Can make configurable later. |
| Python virtual env not activated | Scanner can check for `.venv/` and prefix commands accordingly. Start simple, enhance if needed. |

---

Next: /probe 'M1: Tech Scanner'
