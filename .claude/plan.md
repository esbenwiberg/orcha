# Blueprint: Support Large Pipeline Blueprints with Milestone-Based Execution

## Goal

Enhance the architect stage to generate milestone-based blueprints with clear headers, and ensure the dev stage processes milestones one at a time with fresh context and milestone start/end reporting.

## Non-Goals

- Parallel milestone execution (milestones are sequential by design)
- Breaking changes to existing single-milestone blueprints
- Web UI changes for milestone visualization

## Acceptance Criteria

- [x] Architect stage outputs a plan with milestones
- [x] Dev stage processes each milestone one at a time
- [x] Each milestone is processed with a fresh/clear context
- [x] Dev stage reports milestone start and end
- [x] Architect plan starts with a headline, short description, and milestone count

## Architecture

### Blueprint Structure

```json
{
  "headline": "Short, clear title",
  "shortDescription": "Summary with N milestones",
  "approach": "High-level implementation approach",
  "filesToTouch": ["file1.ts", "file2.ts"],
  "risks": ["Risk 1", "Risk 2"],
  "testStrategy": "How to test",
  "milestones": [
    {
      "description": "What this milestone accomplishes",
      "details": "Step-by-step implementation guidance",
      "filesToTouch": ["optional subset of files"]
    }
  ]
}
```

### Milestone Execution Flow

```
Architect Stage
  -> Produces blueprint with milestones array
  -> Each milestone has description, details, optional filesToTouch
  -> shortDescription includes milestone count

Dev Stage (per milestone)
  -> Report milestone start via appendProgress
  -> Build milestone-specific prompt (fresh context)
  -> Run Claude session with unique stageKey
  -> Auto-commit milestone changes
  -> Report milestone completion via appendProgress
  -> Proceed to next milestone
```

## Key Files

| File | Change |
|------|--------|
| `src/pipeline/stages/architect.ts` | Schema uses 'milestones' field, validation enforces non-empty |
| `src/pipeline/prompt-builder.ts` | Architect prompt instructs milestone planning with count in shortDescription |
| `src/pipeline/stages/dev.ts` | Milestone-based execution with fresh context and progress reporting |
| `src/pipeline/types.ts` | Blueprint type supports both milestones and steps (backward compat) |

## Milestones

### M1: Update architect schema and prompt to emphasize milestones

**Intent:** Ensure the architect produces plans with milestones field and includes milestone count in shortDescription.

**Key files:** `src/pipeline/stages/architect.ts`, `src/pipeline/prompt-builder.ts`

**Changes:**
- BLUEPRINT_SCHEMA uses 'milestones' as preferred field (keeps 'steps' for backward compat)
- Schema requires at least one milestone via minItems: 1
- Prompt instructs architect to divide tasks into milestones with fresh context per milestone
- Prompt explicitly requests milestone count in shortDescription format

### M2: Ensure blueprint output includes prominent milestone count

**Intent:** Make the milestone count visible in architect output logging.

**Key files:** `src/pipeline/stages/architect.ts`

**Changes:**
- Stage result output shows milestone count: `{headline} - N milestones, M files`
- Handles singular/plural correctly (1 milestone vs 2 milestones)

### M3: Verify dev stage milestone reporting is complete

**Intent:** Confirm dev stage reports milestone start/end with progress updates.

**Key files:** (verification only - already implemented in dev.ts)

**Already implemented:**
- `appendProgress` called at milestone start (type: 'info')
- `appendProgress` called at milestone completion (type: 'stage-complete')
- Progress includes milestone index, total count, and description
- Fresh context via unique stageKey `dev-milestone-${i}`

## Risks

| Risk | Mitigation |
|------|------------|
| Backward compatibility | Both 'milestones' and 'steps' fields supported in validation |
| Schema parsing | anyOf clause allows either milestones OR steps to be present |
| LLM not following format | Prompt has explicit examples and format requirements |

## Test Strategy

1. Run pipeline with small task -> verify single milestone works
2. Run pipeline with large task -> verify multiple milestones created
3. Check progress logs show milestone start/end messages
4. Test with legacy 'steps' field blueprints for backward compatibility
