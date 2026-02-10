# Blueprint: Test Coverage Tracking

## Goal

Add test coverage tracking to the Orcha pipeline with an 80% target for new code. The coverage checker runs as a gate agent (like test-runner, lint-runner), reports coverage on newly added lines only, and displays results as a soft warning — never blocking the pipeline.

## Non-Goals

- **Hard gate enforcement** — coverage below 80% does NOT block the pipeline (user requested soft warning)
- **Full project coverage** — only track coverage for newly added lines in the current commit
- **Modified line coverage** — exclude lines that were changed (not added) from coverage tracking
- **Automated test generation** — dev agent writes tests, but we don't auto-generate tests to meet coverage
- **Coverage for adversary tests** — adversary-generated tests won't count toward the 80% target
- **Detailed branch/function coverage** — stick to line coverage for simplicity
- **Coverage trends over time** — just report current coverage per pipeline run

## Acceptance Criteria

- [ ] A `coverage-checker` gate agent runs in parallel with the 7 existing gate agents (becomes 8 total)
- [ ] Coverage checker detects tech stacks and runs appropriate coverage tools (nyc for Node, pytest-cov for Python, dotnet test --collect for .NET)
- [ ] Parses git diff to identify newly added lines (lines starting with `+` but not `+++`)
- [ ] Calculates coverage percentage on new lines only, not modified lines
- [ ] Returns verdict: `'skip'` (informational only, never blocks pipeline)
- [ ] Coverage threshold defaults to 80% (configurable via pipeline config)
- [ ] Web dashboard displays coverage results with color coding: green ≥80%, yellow 60-79%, red <60%
- [ ] Details include list of uncovered new lines (file:line format)
- [ ] Dev stage prompts encourage test writing with 80% target
- [ ] Works with Node.js, Python, and .NET projects
- [ ] Coverage tool failures (missing dependencies, etc.) result in 'skip' verdict with error details, not pipeline failure

## Architecture

### High-Level Flow

```
gate.ts
  → detectTechStacks(worktreePath)  (called once)
  → pass TechStack[] to all runners including coverage-checker

coverage-checker:
  1. Parse git diff → extract added lines per file
  2. For each tech stack:
     - Run coverage tool (nyc/pytest-cov/dotnet test --collect)
     - Parse coverage report (JSON/XML)
     - Match covered lines against added lines
  3. Aggregate coverage across stacks
  4. Return verdict: 'skip' (informational only)
```

### Coverage Checker Components

```typescript
// Main entry point
runCoverageChecker(
  worktreePath: string,
  techStacks: TechStack[],
  baseCommit?: string
): Promise<GateResult>

// Git diff parsing
getNewlyAddedLines(
  worktreePath: string,
  baseCommit?: string
): Map<string, number[]>  // file → [line numbers]

// Per-stack coverage runners
runNodeCoverage(stack: TechStack): CoverageReport
runPythonCoverage(stack: TechStack): CoverageReport
runDotnetCoverage(stack: TechStack): CoverageReport

// Coverage report parsers
parseNycCoverage(coverageDir: string): Map<string, number[]>  // file → covered lines
parsePytestCoverage(coverageXml: string): Map<string, number[]>
parseDotnetCoverage(coverageXml: string): Map<string, number[]>

// Calculate coverage on added lines
calculateNewLineCoverage(
  addedLines: Map<string, number[]>,
  coveredLines: Map<string, number[]>
): { total: number, covered: number, percentage: number, uncovered: Array<{file: string, line: number}> }
```

### GateResult Format

```typescript
{
  verdict: 'skip',  // Always skip — informational only
  checkName: 'coverage-checker',
  summary: 'New lines coverage: 78.4% (98/125 lines) — below 80% threshold',
  details: {
    overallCoverage: 85.2,        // Whole project coverage (optional)
    newLinesCoverage: 78.4,       // What we track
    threshold: 80,
    metThreshold: false,
    totalNewLines: 125,
    coveredNewLines: 98,
    uncoveredLines: [
      { file: 'src/foo.ts', line: 42 },
      { file: 'src/bar.ts', line: 18 },
      { file: 'src/bar.ts', line: 19 },
    ],
    perStack: [
      {
        type: 'node',
        path: '.',
        coverage: 78.4,
        newLines: 125,
        coveredLines: 98,
      }
    ]
  },
  timestamp: '2026-02-10T...'
}
```

## Key Files

### New Files
- `src/pipeline/gate-agents/coverage-checker.ts` (~300-400 lines)
  - Main runner: `runCoverageChecker()`
  - Git diff parser: `getNewlyAddedLines()`
  - Per-stack coverage runners: `runNodeCoverage()`, `runPythonCoverage()`, `runDotnetCoverage()`
  - Coverage report parsers: `parseNycCoverage()`, `parsePytestCoverage()`, `parseDotnetCoverage()`
  - Coverage calculator: `calculateNewLineCoverage()`

### Modified Files
- `src/pipeline/stages/gate.ts` (lines ~113-123)
  - Add `runCoverageChecker()` to Promise.all
  - Add to skip check handling
  - Include coverage result in results array
- `src/pipeline/prompt-builder.ts` (lines ~327-368, ~383-447)
  - Add testing guidelines to dev prompts
  - Mention 80% coverage target
  - Include blueprint.testStrategy if present
- `src/pipeline/types.ts`
  - Add `'gate:coverage-checker'` to `ModelStageKey` union (line ~62)
  - Add `coverageThreshold?: number` to `PipelineConfig` (line ~99)
- `src/pipeline/pipeline-config.ts`
  - Add `'gate:coverage-checker': 'shell'` to default model config
  - Add `coverageThreshold: 80` to default pipeline config
- `src/web/public/app.js` (gate results rendering, around line ~1500-2000)
  - Add coverage-checker display with color coding
  - Show coverage percentage, threshold comparison
  - List uncovered lines

### Dependencies
- `package.json` — Add `nyc` as devDependency for Node coverage

## Milestones

### M1: Git Diff Parser for Added Lines

**Intent:** Create utility to parse git diff and extract newly added line numbers per file.

**Key files:** `src/pipeline/gate-agents/coverage-checker.ts` (partial implementation)

**Details:**
1. Create `getNewlyAddedLines(worktreePath: string, baseCommit?: string): Map<string, number[]>`
2. Use git diff strategy similar to `git-utils.ts`:
   - Try `baseCommit` if provided
   - Fall back to `origin/{sourceBranch}`
   - Fall back to `{sourceBranch}`
   - Fall back to `HEAD~1`
3. Run `git diff {base} --unified=0 --no-color` to get minimal diff
4. Parse output:
   - Look for `diff --git a/... b/...` lines to track current file
   - Look for `@@ -X,Y +A,B @@` lines to get added line ranges
   - Lines starting with `+` (but not `+++`) are added content
   - Map: `{ 'src/foo.ts': [10, 11, 15, 16, 17, 18], 'src/bar.ts': [42] }`
5. Exclude binary files, deleted files, and non-code files (e.g., `.json`, `.md`, `.lock` files)

**Verification:**
```bash
# Manual test in a worktree with changes
cd ~/.orcha/pipelines/test-123/worktree
git diff HEAD~1 --unified=0 --no-color | grep -E '^(\+|@@|diff)'

# TypeScript compile
npx tsc --noEmit src/pipeline/gate-agents/coverage-checker.ts
```

---

### M2: Node.js Coverage Runner

**Intent:** Run nyc (Istanbul) on Node projects and parse the coverage report.

**Key files:** `src/pipeline/gate-agents/coverage-checker.ts`, `package.json`

**Details:**
1. Add `nyc` to devDependencies in `package.json`
2. Implement `runNodeCoverage(stack: TechStack, worktreePath: string): CoverageReport | null`
   - Check if stack has test command
   - Run `npx nyc --reporter=json npm test` in `stack.absolutePath`
   - Timeout: 5 minutes (same as test-runner)
   - Handle failures gracefully (return null, log warning)
3. Implement `parseNycCoverage(coverageDir: string): Map<string, number[]>`
   - Read `coverage/coverage-final.json`
   - For each file, extract covered statement line numbers
   - Istanbul format: `{ 'src/foo.ts': { s: { '0': 1, '1': 0 }, statementMap: { '0': {..., line: 10}, '1': {..., line: 11} } } }`
   - If `s['0'] > 0`, line 10 is covered
   - Return: `{ 'src/foo.ts': [10, 12, 13, ...] }`
4. Handle relative vs absolute paths (coverage reports use absolute, git diff uses relative)
   - Normalize all paths relative to `worktreePath`

**Verification:**
```bash
npm install
npx tsc --noEmit src/pipeline/gate-agents/coverage-checker.ts

# Manual test
cd test-project
npx nyc --reporter=json npm test
cat coverage/coverage-final.json | jq 'keys'
```

---

### M3: Python Coverage Runner

**Intent:** Run pytest-cov on Python projects and parse coverage.xml.

**Key files:** `src/pipeline/gate-agents/coverage-checker.ts`

**Details:**
1. Implement `runPythonCoverage(stack: TechStack, worktreePath: string): CoverageReport | null`
   - Check if pytest is available (from tech scanner)
   - Run `pytest --cov --cov-report=xml` in `stack.absolutePath`
   - Coverage report written to `coverage.xml` (Cobertura format)
   - 5-minute timeout
   - Return null on failure (missing pytest-cov, etc.)
2. Implement `parsePytestCoverage(coverageXml: string): Map<string, number[]>`
   - Parse XML (use Node's built-in XML parser or simple regex)
   - Cobertura format: `<line number="42" hits="1"/>`
   - Extract lines where `hits > 0`
   - Group by file: `{ 'src/foo.py': [10, 15, 20], ... }`
3. Normalize paths relative to `worktreePath`

**Verification:**
```bash
npx tsc --noEmit src/pipeline/gate-agents/coverage-checker.ts

# Manual test (requires Python project with pytest-cov)
cd python-test-project
pytest --cov --cov-report=xml
cat coverage.xml | grep '<line'
```

---

### M4: .NET Coverage Runner

**Intent:** Run dotnet test with code coverage and parse Cobertura XML.

**Key files:** `src/pipeline/gate-agents/coverage-checker.ts`

**Details:**
1. Implement `runDotnetCoverage(stack: TechStack, worktreePath: string): CoverageReport | null`
   - Run `dotnet test --collect:"Code Coverage" --results-directory ./coverage` in `stack.absolutePath`
   - .NET outputs coverage in Cobertura XML format (or binary .coverage — use Cobertura for simplicity)
   - 5-minute timeout
   - Return null on failure
2. Implement `parseDotnetCoverage(coverageXml: string): Map<string, number[]>`
   - Same Cobertura parser as Python (reuse logic)
   - Extract covered lines from `<line number="..." hits="..."/>` where hits > 0
3. Handle .NET-specific path quirks (absolute Windows-style paths on Windows, Unix paths on Linux)
   - Normalize to relative paths

**Verification:**
```bash
npx tsc --noEmit src/pipeline/gate-agents/coverage-checker.ts

# Manual test (requires .NET project)
cd dotnet-test-project
dotnet test --collect:"Code Coverage" --results-directory ./coverage
ls coverage/*.xml
```

---

### M5: Coverage Calculator & Main Runner

**Intent:** Wire together git diff parsing, coverage runners, and coverage calculation into the main `runCoverageChecker()` function.

**Key files:** `src/pipeline/gate-agents/coverage-checker.ts`

**Details:**
1. Implement `calculateNewLineCoverage(addedLines, coveredLines)`:
   - For each file in `addedLines`, check how many lines are in `coveredLines`
   - Count: `totalNew`, `coveredNew`, `uncoveredNew`
   - Percentage: `(coveredNew / totalNew) * 100`
   - Return uncovered list: `[{ file: 'src/foo.ts', line: 42 }, ...]`
2. Implement `runCoverageChecker(worktreePath, techStacks, baseCommit)`:
   - Call `getNewlyAddedLines(worktreePath, baseCommit)` → get `addedLines`
   - For each stack, call appropriate coverage runner (node/python/dotnet)
   - Parse coverage report → get `coveredLines`
   - Call `calculateNewLineCoverage(addedLines, coveredLines)`
   - Build `GateResult` with verdict: `'skip'`
   - Summary: `"New lines coverage: X% (Y/Z lines) — {above|below} 80% threshold"`
   - Details: include per-stack breakdown, uncovered lines list, threshold
3. Handle edge cases:
   - No new lines → skip (100% coverage by default)
   - Coverage tool fails → skip with error details
   - Multiple stacks → aggregate coverage across stacks

**Verification:**
```bash
npx tsc --noEmit src/pipeline/gate-agents/coverage-checker.ts

# Unit test with mock data
node -e "
const { calculateNewLineCoverage } = require('./dist/pipeline/gate-agents/coverage-checker.js');
const added = new Map([['src/foo.ts', [10, 11, 12]]]);
const covered = new Map([['src/foo.ts', [10, 12]]]);
const result = calculateNewLineCoverage(added, covered);
console.log(result);  // Should show 66.7% coverage
"
```

---

### M6: Integrate Coverage Checker into Gate Stage

**Intent:** Add coverage-checker to the parallel gate agent execution.

**Key files:** `src/pipeline/stages/gate.ts`, `src/pipeline/types.ts`, `src/pipeline/pipeline-config.ts`

**Details:**
1. Import `runCoverageChecker` in `gate.ts`
2. Update the `Promise.all` (line ~113):
   - Add 8th agent: `runCoverageChecker(run.worktreePath, techStacks, run.baseCommit)`
   - Add skip check: `skip.has('coverage-checker') ? makeSkippedResult('coverage-checker') : ...`
3. Update `results` array to include coverage result (line ~123)
4. Add `'gate:coverage-checker'` to `ModelStageKey` union in `types.ts`
5. Add `'gate:coverage-checker': 'shell'` to default model config in `pipeline-config.ts`
6. Add `coverageThreshold?: number` field to `PipelineConfig` interface in `types.ts`
7. Add `coverageThreshold: 80` to config defaults in `pipeline-config.ts`
8. Update competing mode gate to also include coverage-checker (line ~200+)

**Verification:**
```bash
npx tsc --noEmit src/pipeline/stages/gate.ts
npx tsc --noEmit src/pipeline/types.ts
npx tsc --noEmit src/pipeline/pipeline-config.ts
npm run build

# Run gate on a test pipeline
orcha pipeline run --stage gate --id test-coverage-123
cat ~/.orcha/pipelines/test-coverage-123/gate-results/coverage-checker.json
```

---

### M7: Enhance Dev Stage Prompts

**Intent:** Update dev agent prompts to encourage test writing with 80% coverage target.

**Key files:** `src/pipeline/prompt-builder.ts`

**Details:**
1. Update `buildDevPrompt()` (line ~327-368):
   - After existing guidelines, add testing section:
   ```typescript
   '',
   '## Testing Guidelines',
   '- Write tests for new functionality you add',
   '- Aim for 80% test coverage on new code',
   '- Follow existing test patterns in the codebase',
   '- The gate stage will report coverage metrics (informational, not blocking)',
   '- Do NOT run tests yourself — the gate handles test execution',
   ```
2. Update `buildMilestoneDevPrompt()` (line ~383-447):
   - Add same testing guidelines
   - If `blueprint.testStrategy` exists, include it:
   ```typescript
   if (blueprint.testStrategy) {
     sections.push('', '## Test Strategy', blueprint.testStrategy);
   }
   ```
3. Do NOT change existing "Do NOT run tests" instruction (line ~351)

**Verification:**
```bash
npx tsc --noEmit src/pipeline/prompt-builder.ts

# Inspect generated prompt (manual check)
# Run a dev stage and check the agent's prompt includes testing guidelines
```

---

### M8: Web Dashboard Coverage Display

**Intent:** Add coverage-checker results to the web dashboard gate results view with color-coded display.

**Key files:** `src/web/public/app.js`, `src/web/public/style.css`

**Details:**
1. In `app.js`, find gate results rendering (around line ~1500-2000)
2. Add coverage-checker display logic:
   - Show verdict as "SKIP ℹ️" (informational badge)
   - Display coverage percentage with color:
     - `≥80%` → green text
     - `60-79%` → yellow text
     - `<60%` → red text
   - Show threshold comparison:
     - `✓ Above 80% threshold` (green)
     - `⚠️ Below 80% threshold` (yellow/red)
   - List uncovered lines:
     ```
     Uncovered lines:
       • src/foo.ts:42
       • src/bar.ts:18-20
     ```
3. In `style.css`, add coverage-specific styles:
   ```css
   .coverage-good { color: #22c55e; }
   .coverage-warning { color: #eab308; }
   .coverage-poor { color: #ef4444; }
   ```
4. Handle missing coverage data gracefully (e.g., if coverage tool failed)

**Verification:**
```bash
# Copy to dist (remember the build gotcha!)
cp src/web/public/app.js dist/web/public/
cp src/web/public/style.css dist/web/public/

# Restart web server
orcha web

# Open dashboard, navigate to a pipeline run with gate results
# Verify coverage-checker section displays correctly
```

---

## Risks & Probes

| Risk | Mitigation |
|------|------------|
| **nyc not compatible with test framework** | Check if project uses Jest (has built-in `--coverage`). Adapt Node coverage runner to try `jest --coverage` first, fall back to `nyc npm test`. |
| **pytest-cov not installed** | Coverage runner returns null (skip verdict) with details: "pytest-cov not found". Gate doesn't fail. |
| **dotnet code coverage requires vstest** | .NET SDK 6+ includes code coverage. If unavailable, skip with error details. |
| **Git diff parsing breaks on complex diffs** | Test with merge commits, renames, binary files. Exclude non-code files. Handle edge cases gracefully. |
| **Coverage report paths don't match git paths** | Normalize all paths relative to `worktreePath`. Handle both Unix and Windows path separators. |
| **Coverage tool timeout (5 min not enough)** | Make timeout configurable in pipeline config. Default: 5 min (same as test-runner). |
| **False negatives (new lines not in coverage report)** | Some lines (comments, blank lines) won't be in coverage. Filter added lines to only include code lines (exclude comments, whitespace). |
| **Coverage calculation on mixed-tech repos** | Aggregate coverage across stacks. Example: 80% Node coverage + 70% Python coverage → overall average weighted by lines. |
| **Web dashboard rendering breaks with large uncovered line lists** | Limit uncovered lines display to first 50 lines, with "... and N more" if truncated. |

---

## Configuration

Users can customize coverage via pipeline config:

```typescript
// In pipeline-config.ts or user-provided config
{
  coverageThreshold: 90,  // Require 90% instead of 80%
  skipChecks: ['coverage-checker'],  // Disable coverage tracking entirely
}
```

CLI support (future enhancement, not in this blueprint):
```bash
orcha pipeline run --coverage-threshold 90
orcha pipeline run --skip coverage-checker
```

---

## Design Decisions

### Why 'skip' Verdict Instead of 'pass'/'fail'?

**Rationale:**
- User wants soft warning, not gate failure
- Allows coverage < 80% without blocking pipeline
- Distinguishes from real quality gates (test/lint/build)
- Can be changed to `'fail'` later if user wants hard enforcement

**Implementation:**
```typescript
const verdict = 'skip'  // Always skip, regardless of coverage %
```

**Future toggle:**
If user wants hard enforcement, add config:
```typescript
const verdict = run.config.enforceCoverage && coverage < threshold ? 'fail' : 'skip'
```

### Why Track New Lines Only (Not Modified Lines)?

**Rationale:**
- Focuses on fresh code quality
- Doesn't penalize refactoring existing code
- Easier to achieve 80% on new code vs entire changed surface
- Aligns with user preference from questions

**Implementation:**
Git diff parsing only extracts lines starting with `+` (additions), not `-` (deletions) or context lines.

### Why Not a Separate Test-Creation Stage?

**Considered:** Add new stage between dev and gate for dedicated test writing.

**Rejected because:**
- Adds pipeline complexity (extra state, transitions)
- Separates test context from code (TDD principle: write tests with code)
- Slower (extra stage = extra latency)
- User has no strong opinion (answered "don't really have an opinion")

**Chosen approach:** Enhance dev prompts + add gate agent
- Simpler, faster, tests written with code
- Coverage tracked as informational metric in gate
- Can revisit if test quality is insufficient

### Coverage Tool Selection

| Stack | Tool | Format | Pros | Cons |
|-------|------|--------|------|------|
| **Node** | nyc (Istanbul) | JSON | Widely used, works with any test runner | Requires separate installation |
| **Node** | Jest --coverage | JSON | Built-in if using Jest | Only works with Jest |
| **Python** | pytest-cov | XML (Cobertura) | Standard for pytest projects | Requires pytest-cov plugin |
| **Python** | coverage.py | XML (Cobertura) | Standalone, no pytest needed | Less common in modern projects |
| **.NET** | dotnet test --collect | XML (Cobertura) | Built into SDK 6+ | Cobertura conversion may require extra tool |

**Implementation:** Try tool in order of likelihood, fall back gracefully.

---

## Open Questions

1. **Should adversary-generated tests count toward coverage?**
   - **Current decision:** No. Adversary runs after coverage check, focused on bug-finding not coverage.
   - **Future:** Could track "adversary coverage" separately as a bonus metric.

2. **How to handle flaky coverage tools?**
   - **Current decision:** Return `verdict: 'skip'` with error details. Don't block pipeline.
   - **Future:** Add retry logic (up to 2 retries) for transient failures.

3. **Coverage caching between fix loops?**
   - **Current decision:** Always re-run coverage (simpler). Fix loop may change tests.
   - **Future:** Cache coverage results keyed by `git rev-parse HEAD`, reuse if SHA unchanged.

4. **Should we track branch/function coverage?**
   - **Current decision:** Line coverage only (simpler, most tools support).
   - **Future:** Add branch coverage if line coverage proves insufficient.

5. **What if a file has no tests at all (0% coverage)?**
   - **Current decision:** Report actual coverage (e.g., 0%). Don't special-case.
   - **Future:** Add warning: "These files have 0% coverage: ..." to highlight gaps.

---

Next: /probe 'M1: Git Diff Parser for Added Lines'
