# Fix-Loop 2.0 Architecture

This document describes the fix-loop system in Orcha, including the architecture, how to extend it with new fix strategies, circuit breaker tuning, and the roadmap for competing fix agents.

## Table of Contents

1. [Architecture Overview](#architecture-overview)
2. [Fix-Loop Flow](#fix-loop-flow)
3. [Circuit Breaker](#circuit-breaker)
4. [Failure Patterns & Learning](#failure-patterns--learning)
5. [Metrics & Observability](#metrics--observability)
6. [Adding New Fix Strategies](#adding-new-fix-strategies)
7. [Tuning Circuit Breaker Thresholds](#tuning-circuit-breaker-thresholds)
8. [Competing Fix Design (Roadmap)](#competing-fix-design-roadmap)

---

## Architecture Overview

The fix-loop is the core remediation system in Orcha's pipeline. When the gate stage detects failures, the fix-loop attempts to automatically fix them using Claude.

### Key Components

```
┌─────────────────────────────────────────────────────────────┐
│                         Fix-Loop                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────┐ │
│  │ Context      │─────▶│ Fix Agent    │─────▶│ Commit   │ │
│  │ Builder      │      │ (Claude)     │      │ & Re-gate│ │
│  └──────────────┘      └──────────────┘      └──────────┘ │
│         │                      │                    │      │
│         ▼                      ▼                    ▼      │
│  ┌──────────────┐      ┌──────────────┐      ┌──────────┐ │
│  │ Failure      │      │ Circuit      │      │ Attempt  │ │
│  │ Patterns     │      │ Breaker      │      │ Tracker  │ │
│  └──────────────┘      └──────────────┘      └──────────┘ │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

**Context Builder** (`src/pipeline/fix-loop/context-builder.ts`)
- Gathers full file contents for failing files
- Builds attempt history with diffs and summaries
- Identifies affected modules and related files
- Provides rich context to the fix agent

**Circuit Breaker** (`src/pipeline/fix-loop/circuit-breaker.ts`)
- Detects repeated failures (same failure signature appearing multiple times)
- Triggers escalation when threshold is exceeded
- Prevents infinite fix loops on unfixable issues

**Failure Patterns** (`src/pipeline/learning/failure-patterns.ts`)
- Records patterns of failures and successful fixes
- Provides examples of similar fixes to the fix agent
- Learns over time to improve fix success rate

**Attempt Tracker** (`src/pipeline/fix-loop/attempt-tracker.ts`)
- Records each fix attempt with metadata (diff, timestamp, outcome)
- Enables replay and debugging of fix-loop behavior
- Feeds into metrics and learning systems

**Metrics Store** (`src/pipeline/learning/fix-success-rate.ts`)
- Tracks fix-loop performance metrics
- Aggregates success rates by pattern type
- Provides observability dashboard data

---

## Fix-Loop Flow

The fix-loop runs when the gate stage fails. Here's the step-by-step flow:

### 1. Gate Failure Detection
```typescript
// Gate returns 'fail' verdict
if (gateResult.verdict === 'fail') {
  transition(run, 'fix-loop')
}
```

### 2. Context Building
```typescript
const context = await buildEnhancedFixContext(run, gateResults)
// Returns:
// - Full file contents for failing files
// - Attempt history (diffs from previous attempts)
// - Affected modules (directory tree)
// - Related files (imports/exports)
```

### 3. Circuit Breaker Check
```typescript
const signature = computeFailureSignature(gateResults)
const shouldEscalate = circuitBreaker.shouldTrigger(signature)
if (shouldEscalate) {
  transition(run, 'escalated')
  return
}
```

### 4. Fix Agent Invocation
```typescript
// Agent receives:
// - Gate failure report
// - Enhanced context (files, history, modules)
// - Similar failure patterns (from learning store)
// - Instructions to make targeted fixes
const fixResult = await invokeFix(run, context, patterns)
```

### 5. Re-gate
```typescript
// Commit the fix
await commitChanges(run, fixResult.diff)
// Run gate again
const newGateResult = await runGateStage(run)
if (newGateResult.passed) {
  transition(run, 'checkpoint:ship')
} else if (run.fixLoopCount < maxFixLoops) {
  // Try again (loop back to step 2)
} else {
  transition(run, 'escalated')
}
```

---

## Circuit Breaker

The circuit breaker prevents infinite fix loops by detecting when the same failure occurs repeatedly.

### Failure Signature

A failure signature is a hash of the failure type:
```typescript
function computeFailureSignature(gateResults: GateResult[]): FailureSignature {
  const failures = gateResults.filter(r => r.verdict === 'fail')
  const text = failures.map(f => `${f.checkName}:${f.summary}`).join('|')
  return {
    hash: sha256(text),
    description: failures[0].summary.substring(0, 100)
  }
}
```

### Trigger Logic

The circuit breaker triggers when:
- The same failure signature appears **3 times** in a row
- Example: security check fails with "command injection" three times

### When It Triggers

- Pipeline is transitioned to `escalated` state
- User is notified via web dashboard
- Escalation manager provides options:
  - Skip the failing check
  - Override severity threshold
  - Provide manual feedback

---

## Failure Patterns & Learning

The learning system records failure patterns and their successful fixes, enabling the fix agent to learn from past successes.

### Pattern Detection

Patterns are classified by type:
- `command-injection` - Shell injection vulnerabilities
- `sql-injection` - SQL injection vulnerabilities
- `xss` - Cross-site scripting issues
- `validation-missing` - Missing input validation
- `test-failure` - Test failures
- `lint-error` - Linting issues
- `build-error` - Compilation errors

### Pattern Matching

When a failure occurs, the system:
1. Extracts keywords from the failure message
2. Detects the pattern type
3. Searches for similar patterns in the learning store
4. Provides top 3 most similar fixes to the fix agent

### Recording Successful Fixes

When a fix succeeds (gate passes after fix-loop):
```typescript
const pattern: FailurePattern = {
  patternType: detectPatternType(gateResults),
  signature: computeSignature(gateResults),
  checkName: 'security',
  language: 'typescript',
  keywords: extractKeywords(gateResults),
  successfulFix: {
    description: 'Fixed command injection by sanitizing user input',
    filesModified: ['src/api/routes.ts'],
    diff: '...',
    approach: 'Added input validation using validator library',
    timestamp: new Date().toISOString()
  }
}
await patternStore.recordPattern(pattern)
```

---

## Metrics & Observability

The metrics system tracks fix-loop performance to provide visibility into the fix process.

### Tracked Metrics

**Attempts Distribution**
- How many pipelines succeed on 1st attempt
- How many require 2nd or 3rd attempt
- How many escalate (exceed max attempts)

**Success Rate by Pattern**
- For each pattern type, track success rate
- Example: `command-injection` has 85% success rate

**Circuit Breaker Trigger Rate**
- How often the circuit breaker stops infinite loops
- Indicator of unfixable issues

**Average Time Per Attempt**
- How long each fix attempt takes
- Useful for capacity planning

### Viewing Metrics

Metrics are available in the web dashboard:
1. Open a pipeline detail page
2. Scroll to "Fix-Loop Metrics" section
3. View charts:
   - Attempts distribution bar chart
   - Success rate by pattern
   - Summary stats (total attempts, triggers, avg time)

### API Endpoint

```bash
curl http://localhost:3000/api/pipelines/metrics
```

Returns:
```json
{
  "totalAttempts": 42,
  "totalPipelines": 15,
  "attemptsDistribution": {
    "1": 8,
    "2": 4,
    "3": 2,
    "escalated": 1
  },
  "successRateByPattern": {
    "command-injection": {
      "attempts": 5,
      "successes": 4,
      "rate": 0.8
    }
  },
  "circuitBreakerTriggers": 1,
  "averageTimePerAttemptMs": 45000
}
```

---

## Adding New Fix Strategies

Fix strategies define different approaches to fixing gate failures. Currently, Orcha uses a single default strategy, but you can add new ones for the competing fix runner.

### Default Strategy

The current fix agent uses this approach:
- Targeted file changes (only modify failing files)
- Conservative fixes (minimal changes)
- Pattern-based learning (use similar fixes)

### Adding a Custom Strategy

1. **Define the strategy** in `src/pipeline/fix-loop/competing-runner.ts`:

```typescript
const aggressiveStrategy: FixStrategy = {
  name: 'aggressive',
  prompt: `You are an aggressive fix agent. Fix failures by refactoring code structure.
Consider the entire module, not just failing files. Apply best practices even if not required.
Make systemic improvements to prevent future failures.`,
  scopePermissions: 'broad'
}
```

2. **Register the strategy** in the competing runner:

```typescript
export const CUSTOM_STRATEGIES: FixStrategy[] = [
  ...DEFAULT_STRATEGIES,
  aggressiveStrategy
]
```

3. **Test the strategy** by enabling competing mode:

```bash
orcha pipeline run \
  --description "Test aggressive strategy" \
  --competing-fix-strategies 2
```

### Strategy Parameters

**name** - Unique identifier for the strategy

**prompt** - Instructions for the fix agent. This is the most important parameter. Include:
- Role definition ("You are a conservative/aggressive fix agent")
- Approach description (targeted vs. broad changes)
- Risk profile (safe vs. experimental)

**scopePermissions** - File access scope:
- `targeted` - Only files mentioned in failures
- `module` - Related files in the same module
- `broad` - Full repository access

---

## Tuning Circuit Breaker Thresholds

The circuit breaker has configurable thresholds to balance between retry attempts and escalation speed.

### Default Thresholds

```typescript
// src/pipeline/fix-loop/circuit-breaker.ts
const DEFAULT_THRESHOLD = 3 // Trigger after 3 repeated failures
const MAX_FIX_LOOPS = 3     // Maximum total attempts
```

### Adjusting Thresholds

**Increase threshold** (more retries before escalation):
```typescript
// In pipeline config
const config: PipelineConfig = {
  maxFixLoops: 5, // Allow up to 5 attempts
  // Circuit breaker will trigger if same failure repeats 3 times within those 5
}
```

**Decrease threshold** (escalate faster):
```typescript
// Modify circuit-breaker.ts
const DEFAULT_THRESHOLD = 2 // Trigger after 2 repeated failures
```

### When to Adjust

**Increase threshold if:**
- Pipelines often succeed on 4th or 5th attempt
- Gate failures are intermittent (flaky tests)
- You have budget for more fix attempts

**Decrease threshold if:**
- Circuit breaker rarely triggers (infinite loops are occurring)
- Fix attempts are expensive (time or cost)
- You want faster escalation to human review

### Monitoring Threshold Effectiveness

Check the metrics dashboard:
- If `circuitBreakerTriggers` is high → threshold might be too low
- If `escalated` count is high but triggers are low → threshold might be too high
- Optimal: ~10-20% of pipelines trigger circuit breaker (unfixable issues)

---

## Competing Fix Design (Roadmap)

Competing fix agents run multiple fix strategies in parallel and select the best one. This is a planned feature for Fix-Loop 2.0.

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Competing Fix Runner                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐ │
│  │ Strategy 1   │    │ Strategy 2   │    │ Strategy 3   │ │
│  │ (Conservative│    │ (Refactor)   │    │ (Minimal)    │ │
│  │ worktree-1)  │    │ (worktree-2) │    │ (worktree-3) │ │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘ │
│         │                   │                    │         │
│         ▼                   ▼                    ▼         │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐ │
│  │ Fix Agent 1  │    │ Fix Agent 2  │    │ Fix Agent 3  │ │
│  │ (Claude)     │    │ (Claude)     │    │ (Claude)     │ │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘ │
│         │                   │                    │         │
│         └───────────────────┼────────────────────┘         │
│                             ▼                              │
│                    ┌─────────────────┐                     │
│                    │ Gate Evaluator  │                     │
│                    │ (Score & Select)│                     │
│                    └─────────────────┘                     │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### How It Works

1. **Create parallel worktrees** for each strategy
   ```bash
   git worktree add /tmp/fix-strategy-1 source-branch
   git worktree add /tmp/fix-strategy-2 source-branch
   git worktree add /tmp/fix-strategy-3 source-branch
   ```

2. **Run fix agents in parallel** with strategy-specific prompts
   ```typescript
   const results = await Promise.all([
     runFixAgent(run, conservativeStrategy, worktree1),
     runFixAgent(run, refactorStrategy, worktree2),
     runFixAgent(run, minimalStrategy, worktree3)
   ])
   ```

3. **Re-gate each result** to score fixes
   ```typescript
   for (const result of results) {
     const gateResults = await runGateStage(result.worktreePath)
     result.gateScore = gateResults.filter(r => r.verdict === 'pass').length
   }
   ```

4. **Select the winner** based on:
   - Primary: Number of passed checks (higher is better)
   - Tiebreaker 1: Diff size (smaller is better)
   - Tiebreaker 2: Execution time (faster is better)

5. **Adopt winner's changes**
   ```typescript
   const winner = results.sort((a, b) => b.gateScore - a.gateScore)[0]
   await mergeWorktree(winner.worktreePath, run.worktreePath)
   ```

6. **Cleanup losing worktrees**
   ```bash
   git worktree remove /tmp/fix-strategy-1
   git worktree remove /tmp/fix-strategy-2
   ```

### Configuration

Enable competing fix mode:
```bash
orcha pipeline run \
  --description "Test competing fix" \
  --competing-fix-strategies 3
```

Or in code:
```typescript
const config: PipelineConfig = {
  competingFixStrategies: 3, // Run 3 strategies in parallel
  fixStrategies: [
    conservativeStrategy,
    refactorStrategy,
    minimalStrategy
  ]
}
```

### Benefits

- **Higher success rate**: Multiple approaches increase chance of finding a working fix
- **Better fixes**: Competition drives quality (gate picks the best)
- **Faster iteration**: Parallel execution reduces fix-loop latency
- **Learning**: Compare strategies to identify which work best for each pattern

### Challenges

- **Resource usage**: Running N agents in parallel requires N times the compute
- **Worktree management**: Creating/cleaning up worktrees adds complexity
- **Merge conflicts**: If strategies modify same files differently, resolution is needed

### Implementation Status

- **Interface design**: ✅ Complete (`src/pipeline/fix-loop/competing-runner.ts`)
- **Types**: ✅ Complete (`CompetingFixResult` in `src/pipeline/types.ts`)
- **Runner implementation**: ❌ TODO
- **Gate integration**: ❌ TODO
- **Worktree management**: ❌ TODO
- **Strategy selection**: ❌ TODO

### Roadmap

**Phase 1** (Foundation)
- Implement `CompetingFixRunner` class
- Add worktree creation/cleanup logic
- Wire into fix-loop stage

**Phase 2** (Scoring & Selection)
- Implement scoring algorithm
- Add tiebreaker logic (diff size, time)
- Integrate with gate stage

**Phase 3** (Learning & Optimization)
- Track which strategies win most often
- Auto-tune strategy parameters based on success rate
- Add strategy recommendation system

**Phase 4** (Advanced Features)
- Custom strategy templates
- Strategy marketplace (community-contributed)
- Multi-stage strategies (try conservative first, escalate to aggressive)

---

## Best Practices

### For Fix-Loop Success

1. **Keep gate checks deterministic** - Flaky tests lead to infinite loops
2. **Use severity thresholds** - Don't block on low-priority issues
3. **Monitor metrics** - Watch for patterns of failure
4. **Tune thresholds** - Adjust circuit breaker based on metrics
5. **Provide good error messages** - Clear gate failures lead to better fixes

### For Learning System

1. **Record all fixes** - Even manual fixes should be recorded for learning
2. **Review patterns** - Periodically check `~/.orcha/learning/failure-patterns.json`
3. **Prune old patterns** - Remove outdated patterns (e.g., after major refactors)
4. **Share patterns** - Consider exporting patterns for team-wide learning

### For Competing Fix (Future)

1. **Start with 2-3 strategies** - More isn't always better (diminishing returns)
2. **Use diverse strategies** - Conservative + aggressive works better than 3 conservative
3. **Monitor costs** - Competing mode uses N times more API calls
4. **Test locally first** - Run on small changes before enabling on all pipelines

---

## Troubleshooting

### Fix-loop exceeds max attempts

**Symptoms**: Pipeline always escalates after 3 attempts

**Diagnosis**:
```bash
# Check circuit breaker state
cat ~/.orcha/pipelines/{pipeline-id}/circuit-breaker.json

# Check attempt history
cat ~/.orcha/pipelines/{pipeline-id}/attempt-history.json
```

**Solutions**:
- Increase `maxFixLoops` in config
- Lower severity threshold (skip non-critical findings)
- Check if same failure repeats (circuit breaker should trigger)

### Circuit breaker triggers too early

**Symptoms**: Pipeline escalates on 1st or 2nd attempt

**Diagnosis**:
```bash
# Check failure signatures
cat ~/.orcha/pipelines/{pipeline-id}/circuit-breaker.json | jq '.failureCounts'
```

**Solutions**:
- Increase circuit breaker threshold (default: 3)
- Check if gate failure messages are consistent
- Review gate agent prompts (inconsistent failures might indicate prompt issues)

### Metrics not updating

**Symptoms**: Metrics dashboard shows "No data yet"

**Diagnosis**:
```bash
# Check metrics file
cat ~/.orcha/learning/fix-metrics.json
```

**Solutions**:
- Ensure fix-loop has completed (metrics recorded on completion)
- Check that `trackFixSuccess()` is called in fix-loop stage
- Verify file permissions on `~/.orcha/learning/`

### Pattern learning not working

**Symptoms**: Fix agent doesn't reference similar fixes

**Diagnosis**:
```bash
# Check recorded patterns
cat ~/.orcha/learning/failure-patterns.json | jq '.patterns | length'
```

**Solutions**:
- Ensure successful fixes are being recorded
- Check pattern matching logic (keywords, language detection)
- Verify pattern type detection is working correctly

---

## References

### Related Files

- `src/pipeline/fix-loop/circuit-breaker.ts` - Circuit breaker implementation
- `src/pipeline/fix-loop/context-builder.ts` - Context building for fix agent
- `src/pipeline/fix-loop/attempt-tracker.ts` - Attempt history tracking
- `src/pipeline/fix-loop/competing-runner.ts` - Competing fix interface (roadmap)
- `src/pipeline/learning/failure-patterns.ts` - Pattern learning system
- `src/pipeline/learning/fix-success-rate.ts` - Metrics tracking
- `src/pipeline/stages/fix-loop.ts` - Main fix-loop stage logic
- `src/web/routes/pipeline-metrics.ts` - Metrics API endpoint (roadmap)
- `docs/architecture.md` - Overall pipeline architecture

### External Resources

- [Circuit Breaker Pattern](https://martinfowler.com/bliki/CircuitBreaker.html)
- [Competing Consumers Pattern](https://www.enterpriseintegrationpatterns.com/patterns/messaging/CompetingConsumers.html)
- [Machine Learning for DevOps](https://research.google/pubs/pub43146/)

---

## Changelog

- **2026-02-10**: Initial version (Milestone 5)
  - Architecture overview
  - Fix-loop flow documentation
  - Circuit breaker tuning guide
  - Competing fix design (roadmap)
  - Metrics & observability section
